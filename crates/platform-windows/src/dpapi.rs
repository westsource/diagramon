//! DPAPI 支撑的凭据存储。
//!
//! 每条凭据单独一个文件（`<sha256(key)>.cred`），内容为「`CryptProtectData` 当前用户域加密」
//! 后的 UTF-8 JSON（`{"key":..,"value":..}`）。文件名用键的哈希，避免键里的任意字符进入路径。

use std::path::PathBuf;

use platform::{CredentialStore, PlatformError};
use serde::{Deserialize, Serialize};

/// 落盘的凭据记录（加密前）。
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    key: String,
    value: String,
}

/// DPAPI 凭据存储。
pub struct DpapiCredentialStore {
    dir: PathBuf,
}

impl DpapiCredentialStore {
    pub fn new(dir: PathBuf) -> Result<Self, PlatformError> {
        Ok(Self { dir })
    }

    fn file_for(&self, key: &str) -> PathBuf {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(key.as_bytes());
        self.dir.join(format!("{}.cred", hex::encode(digest)))
    }
}

impl CredentialStore for DpapiCredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>, PlatformError> {
        let file = self.file_for(key);
        if !file.is_file() {
            return Ok(None);
        }
        let blob = std::fs::read(&file).map_err(|e| PlatformError::new(format!("读取凭据失败: {e}")))?;
        let plain = unprotect(&blob)?;
        let record: Record = serde_json::from_slice(&plain)
            .map_err(|e| PlatformError::new(format!("凭据格式无效: {e}")))?;
        Ok(Some(record.value))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), PlatformError> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| PlatformError::new(format!("创建凭据目录失败: {e}")))?;
        let record = Record {
            key: key.to_string(),
            value: value.to_string(),
        };
        let plain = serde_json::to_vec(&record)
            .map_err(|e| PlatformError::new(format!("凭据序列化失败: {e}")))?;
        let blob = protect(&plain)?;
        let file = self.file_for(key);
        std::fs::write(&file, blob).map_err(|e| PlatformError::new(format!("写入凭据失败: {e}")))
    }

    fn delete(&self, key: &str) -> Result<(), PlatformError> {
        let file = self.file_for(key);
        match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(PlatformError::new(format!("删除凭据失败: {e}"))),
        }
    }
}

/// DPAPI 加密（当前用户域，禁用 UI 提示）。
fn protect(data: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| PlatformError::new(format!("DPAPI 加密失败: {e}")))?;
        Ok(take_blob(out))
    }
}

/// DPAPI 解密。
fn unprotect(data: &[u8]) -> Result<Vec<u8>, PlatformError> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| PlatformError::new(format!("DPAPI 解密失败: {e}")))?;
        Ok(take_blob(out))
    }
}

/// 拷贝出输出缓冲并释放系统分配的内存。
unsafe fn take_blob(blob: windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};

    let slice = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize);
    let vec = slice.to_vec();
    let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut core::ffi::c_void)));
    vec
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("diagramon-cred-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn roundtrip_set_get_delete() {
        let dir = temp_dir();
        let store = DpapiCredentialStore::new(dir.clone()).unwrap();
        let key = "ai.demo";

        assert_eq!(store.get(key).unwrap(), None);
        store.set(key, "sk-secret-值").unwrap();
        assert_eq!(store.get(key).unwrap().as_deref(), Some("sk-secret-值"));

        // 落盘必须是密文：磁盘字节里不得出现明文。
        let raw = std::fs::read(store.file_for(key)).unwrap();
        assert!(!raw.windows(6).any(|w| w == "sk-sec".as_bytes()));

        store.delete(key).unwrap();
        assert_eq!(store.get(key).unwrap(), None);
        // 幂等删除
        store.delete(key).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn filenames_are_hashed() {
        let store = DpapiCredentialStore::new(temp_dir()).unwrap();
        let f = store.file_for("a/b\\c:d*?");
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let stem = name.strip_suffix(".cred").expect("以 .cred 结尾");
        assert_eq!(stem.len(), 64, "sha256 十六进制长度");
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
