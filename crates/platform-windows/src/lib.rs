//! Windows 凭据存储：DPAPI（`CryptProtectData` / `CryptUnprotectData`），作用域是**当前用户**。
//!
//! 直接用 `crypt32` 的 FFI 而不是拉 `windows` crate：这里只用两个函数，
//! 手写声明能少一层版本耦合，也让"密钥不经任何第三方封装"这件事一眼可见。
//!
//! 落盘形态：`<config>/credentials/<sha256(key)>.cred`，内容是 DPAPI 密文（二进制）。
//! 文件名用 key 的哈希 ⇒ 不泄漏 key 名，也避免路径穿越。
#![cfg(windows)]

use std::path::{Path, PathBuf};

use platform::{CredentialStore, Error};
use sha2::{Digest, Sha256};

/// `CRYPTPROTECT_UI_FORBIDDEN`：绝不弹系统对话框（服务/后台线程上调也不会卡住）。
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

impl DataBlob {
    fn from_slice(buf: &mut [u8]) -> Self {
        Self { cb_data: buf.len() as u32, pb_data: buf.as_mut_ptr() }
    }
}

#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        data_descr: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut core::ffi::c_void,
        prompt_struct: *mut core::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;

    fn CryptUnprotectData(
        data_in: *const DataBlob,
        data_descr_out: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut core::ffi::c_void,
        prompt_struct: *mut core::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}

fn protect(plain: &mut [u8]) -> Result<Vec<u8>, Error> {
    let input = DataBlob::from_slice(plain);
    let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(Error::CredentialIo(format!(
            "CryptProtectData 失败（Win32 错误 {}）",
            std::io::Error::last_os_error()
        )));
    }
    let out = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data as *mut core::ffi::c_void) };
    Ok(out)
}

fn unprotect(cipher: &mut [u8]) -> Result<Vec<u8>, Error> {
    let input = DataBlob::from_slice(cipher);
    let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        // 换账户、密文被复制到别的机器、或文件被改坏，都会走到这里
        return Err(Error::DecryptFailed);
    }
    let out = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
    unsafe { LocalFree(output.pb_data as *mut core::ffi::c_void) };
    Ok(out)
}

fn key_file_name(key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    format!("{hex}.cred")
}

pub struct WindowsCredentialStore {
    dir: PathBuf,
}

impl WindowsCredentialStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path_for(&self, key: &str) -> PathBuf {
        self.dir.join(key_file_name(key))
    }
}

impl CredentialStore for WindowsCredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>, Error> {
        let path = self.path_for(key);
        let mut cipher = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::CredentialIo(e.to_string())),
        };
        let plain = unprotect(&mut cipher)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| Error::CredentialIo("解出的密钥不是合法 UTF-8".into()))
    }

    fn set(&self, key: &str, secret: &str) -> Result<(), Error> {
        std::fs::create_dir_all(&self.dir).map_err(|e| Error::CredentialIo(e.to_string()))?;
        let mut plain = secret.as_bytes().to_vec();
        let cipher = protect(&mut plain)?;
        // 明文先擦一遍（尽力而为：Vec 的内存可能已被复制，但至少不留在这块缓冲里）
        for b in plain.iter_mut() {
            *b = 0;
        }
        std::fs::write(self.path_for(key), cipher).map_err(|e| Error::CredentialIo(e.to_string()))
    }

    fn delete(&self, key: &str) -> Result<(), Error> {
        match std::fs::remove_file(self.path_for(key)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::CredentialIo(e.to_string())),
        }
    }
}

/// 便利构造：从配置目录下的 `credentials/` 建存储。
pub fn store_in(config_dir: &Path) -> WindowsCredentialStore {
    WindowsCredentialStore::new(config_dir.join("credentials"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("diagramon-dpapi-test-{tag}"));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn round_trip_through_dpapi() {
        let store = WindowsCredentialStore::new(temp_dir("round"));
        assert_eq!(store.get("openai").unwrap(), None);
        store.set("openai", "sk-test-abcdef123456").unwrap();
        assert_eq!(store.get("openai").unwrap().as_deref(), Some("sk-test-abcdef123456"));
    }

    #[test]
    fn ciphertext_on_disk_does_not_contain_the_plaintext() {
        let dir = temp_dir("cipher");
        let store = WindowsCredentialStore::new(dir.clone());
        let secret = "sk-live-VERY-SECRET-VALUE-1234";
        store.set("openai", secret).unwrap();
        let file = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "cred").unwrap_or(false))
            .expect("应写出一个 .cred 文件");
        let raw = std::fs::read(&file).unwrap();
        assert!(!raw.windows(secret.len()).any(|w| w == secret.as_bytes()), "磁盘上不得出现明文");
    }

    #[test]
    fn key_name_is_hashed_not_plain() {
        let dir = temp_dir("name");
        let store = WindowsCredentialStore::new(dir.clone());
        store.set("my/company/key", "v").unwrap();
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1);
        assert!(!names[0].contains("company"), "文件名不该暴露 key 名：{names:?}");
        assert!(names[0].ends_with(".cred"));
    }

    #[test]
    fn tampered_ciphertext_fails_with_decrypt_error() {
        let dir = temp_dir("tamper");
        let store = WindowsCredentialStore::new(dir.clone());
        store.set("k", "hello world").unwrap();
        let file: PathBuf = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .next()
            .unwrap();
        let mut raw = std::fs::read(&file).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        std::fs::write(&file, raw).unwrap();
        assert!(matches!(store.get("k"), Err(Error::DecryptFailed)));
    }

    #[test]
    fn delete_is_idempotent() {
        let store = WindowsCredentialStore::new(temp_dir("del"));
        store.set("k", "v").unwrap();
        store.delete("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
        store.delete("k").unwrap();
    }
}
