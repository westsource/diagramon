using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Diagramon.Services;

/// <summary>
/// 敏感值（AI API Key、会员令牌）的本地加密存储。
/// </summary>
/// <remarks>
/// <para>
/// Windows 上使用 DPAPI（<see cref="ProtectedData"/>，<see cref="DataProtectionScope.CurrentUser"/>）：
/// 密钥由操作系统按当前用户账户派生，既不落盘也不进源码；非本用户无法解密。
/// </para>
/// <para>
/// <b>非 Windows</b>：DPAPI 是 Windows 专有。本项目只发布 Windows
/// （<c>publish1-build.ps1</c> 的 runtime 为 <c>win-x64</c>），其他平台上 <see cref="Protect"/>
/// 返回 null —— 即<b>不持久化</b>，而不是降级成弱加密。调用方可用
/// <see cref="IsSecureStorageAvailable"/> 决定是否提示用户。
/// </para>
/// <para>
/// <b>关于旧格式</b>：本类曾用 AES + 源码内硬编码密钥与固定 IV（混淆而非加密）。
/// 本项目无存量用户，故<b>不保留任何旧格式的读取兼容</b>。若将来看到那段代码被重新引入，
/// 说明有人误以为需要迁移 —— 不需要。
/// </para>
/// </remarks>
public static class SecureStorageService
{
    /// <summary>当前平台是否具备真正的加密存储能力（DPAPI）。非 Windows 为 false。</summary>
    public static bool IsSecureStorageAvailable => OperatingSystem.IsWindows();

    public static string? Protect(string? plainText)
    {
        if (string.IsNullOrEmpty(plainText)) return null;
        if (!OperatingSystem.IsWindows()) return null;

        try
        {
            var plainBytes = Encoding.UTF8.GetBytes(plainText);
            var protectedBytes = ProtectedData.Protect(plainBytes, null, DataProtectionScope.CurrentUser);
            return Convert.ToBase64String(protectedBytes);
        }
        catch
        {
            return null;
        }
    }

    public static string? Unprotect(string? encryptedText)
    {
        if (string.IsNullOrEmpty(encryptedText)) return null;
        if (!OperatingSystem.IsWindows()) return null;

        try
        {
            var encryptedBytes = Convert.FromBase64String(encryptedText);
            var plainBytes = ProtectedData.Unprotect(encryptedBytes, null, DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plainBytes);
        }
        catch
        {
            return null;
        }
    }

    public static void SaveProtectedValue(string key, string? value, string configPath)
    {
        // 空值 = 清除该键。原实现在此处直接 return，导致调用方（如 RemoveModelConfig）
        // 以为已删除、实际把凭据永久留在了磁盘上。
        if (string.IsNullOrEmpty(value))
        {
            RemoveProtectedValue(key, configPath);
            return;
        }

        var protectedValue = Protect(value);
        if (protectedValue == null) return;

        try
        {
            var directory = Path.GetDirectoryName(configPath);
            if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
            {
                Directory.CreateDirectory(directory);
            }

            var lines = new List<string>();
            if (File.Exists(configPath))
            {
                lines = File.ReadAllLines(configPath).ToList();
            }

            var existingIndex = lines.FindIndex(l => l.StartsWith($"{key}="));
            var newLine = $"{key}={protectedValue}";

            if (existingIndex >= 0)
            {
                lines[existingIndex] = newLine;
            }
            else
            {
                lines.Add(newLine);
            }

            File.WriteAllLines(configPath, lines);
        }
        catch
        {
        }
    }

    public static string? LoadProtectedValue(string key, string configPath)
    {
        return Unprotect(ReadStoredValue(key, configPath));
    }

    /// <summary>移除配置文件中该键所在行；键不存在则不写文件。</summary>
    private static void RemoveProtectedValue(string key, string configPath)
    {
        try
        {
            if (!File.Exists(configPath)) return;

            var lines = File.ReadAllLines(configPath).ToList();
            if (lines.RemoveAll(l => l.StartsWith($"{key}=")) > 0)
            {
                File.WriteAllLines(configPath, lines);
            }
        }
        catch
        {
        }
    }

    private static string? ReadStoredValue(string key, string configPath)
    {
        try
        {
            if (!File.Exists(configPath)) return null;

            foreach (var line in File.ReadAllLines(configPath))
            {
                if (line.StartsWith($"{key}="))
                {
                    return line.Substring(key.Length + 1);
                }
            }
        }
        catch
        {
        }

        return null;
    }
}
