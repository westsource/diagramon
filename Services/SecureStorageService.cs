using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Diagramon.Services;

public static class SecureStorageService
{
    private static readonly byte[] Key = SHA256.HashData(Encoding.UTF8.GetBytes("Diagramon2024SecureStorageKey"));
    private static readonly byte[] IV = SHA256.HashData(Encoding.UTF8.GetBytes("Diagramon2024SecureStorageIV")).Take(16).ToArray();

    public static string? Protect(string? plainText)
    {
        if (string.IsNullOrEmpty(plainText)) return null;

        try
        {
            var plainBytes = Encoding.UTF8.GetBytes(plainText);
            using var aes = Aes.Create();
            aes.Key = Key;
            aes.IV = IV;
            using var encryptor = aes.CreateEncryptor();
            var encryptedBytes = encryptor.TransformFinalBlock(plainBytes, 0, plainBytes.Length);
            return Convert.ToBase64String(encryptedBytes);
        }
        catch
        {
            return null;
        }
    }

    public static string? Unprotect(string? encryptedText)
    {
        if (string.IsNullOrEmpty(encryptedText)) return null;

        try
        {
            var encryptedBytes = Convert.FromBase64String(encryptedText);
            using var aes = Aes.Create();
            aes.Key = Key;
            aes.IV = IV;
            using var decryptor = aes.CreateDecryptor();
            var plainBytes = decryptor.TransformFinalBlock(encryptedBytes, 0, encryptedBytes.Length);
            return Encoding.UTF8.GetString(plainBytes);
        }
        catch
        {
            return null;
        }
    }

    public static void SaveProtectedValue(string key, string? value, string configPath)
    {
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
        try
        {
            if (!File.Exists(configPath)) return null;

            var lines = File.ReadAllLines(configPath);
            foreach (var line in lines)
            {
                if (line.StartsWith($"{key}="))
                {
                    var encryptedValue = line.Substring(key.Length + 1);
                    return Unprotect(encryptedValue);
                }
            }
        }
        catch
        {
        }

        return null;
    }
}