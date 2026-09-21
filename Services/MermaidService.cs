using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Diagramon.Services;

public class MermaidService
{
    public sealed record MermaidRenderResult(bool Success, byte[]? ImageData, string? ErrorMessage, bool IsCanceled = false);

    private readonly string _mmdcPath;
    private readonly string _toolsDir;
    private readonly Dictionary<string, byte[]> _renderCache = new();
    private readonly LinkedList<string> _cacheOrder = new();
    private readonly object _cacheLock = new();
    private const int MaxCacheEntries = 32;

    public MermaidService()
    {
        // 定位逻辑统一在 AppPaths（与 Graphviz / drawio 的资源定位共用一份回退列表）
        _mmdcPath = AppPaths.FindInTools("mmdc.cmd")
            ?? Path.Combine(AppPaths.BaseDirectory, "tools", "mmdc.cmd");
        _toolsDir = Path.GetDirectoryName(_mmdcPath) ?? "";
    }

    public async Task<MermaidRenderResult> RenderAndValidateAsync(string mermaidCode, double scale = 3.0, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(mermaidCode))
        {
            return new MermaidRenderResult(true, null, null);
        }

        var cacheKey = BuildCacheKey(mermaidCode, scale);
        if (TryGetFromCache(cacheKey, out var cachedImage))
        {
            return new MermaidRenderResult(true, cachedImage, null);
        }

        var tempInput = Path.Combine(Path.GetTempPath(), $"mermaid_input_{Guid.NewGuid()}.mmd");
        var tempOutput = Path.Combine(Path.GetTempPath(), $"mermaid_output_{Guid.NewGuid()}.png");

        try
        {
            await File.WriteAllTextAsync(tempInput, mermaidCode);

            var startInfo = new ProcessStartInfo
            {
                FileName = _mmdcPath,
                Arguments = $"-i \"{tempInput}\" -o \"{tempOutput}\" -s {scale} -b transparent",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = _toolsDir
            };

            using var process = new Process { StartInfo = startInfo };
            var outputBuilder = new StringBuilder();
            var errorBuilder = new StringBuilder();

            process.OutputDataReceived += (s, e) => { if (e.Data != null) outputBuilder.AppendLine(e.Data); };
            process.ErrorDataReceived += (s, e) => { if (e.Data != null) errorBuilder.AppendLine(e.Data); };

            using var cancellationRegistration = cancellationToken.Register(() =>
            {
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill(entireProcessTree: true);
                    }
                }
                catch
                {
                    // 忽略取消时的进程状态竞争异常
                }
            });

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            try
            {
                await process.WaitForExitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return new MermaidRenderResult(false, null, null, IsCanceled: true);
            }

            if (process.ExitCode != 0)
            {
                var error = errorBuilder.ToString();
                if (string.IsNullOrWhiteSpace(error))
                {
                    error = outputBuilder.ToString();
                }
                return new MermaidRenderResult(false, null, error);
            }

            if (File.Exists(tempOutput))
            {
                var imageBytes = await File.ReadAllBytesAsync(tempOutput, cancellationToken);
                AddToCache(cacheKey, imageBytes);
                return new MermaidRenderResult(true, imageBytes, null);
            }

            return new MermaidRenderResult(false, null, "Mermaid 未生成输出图片。");
        }
        finally
        {
            if (File.Exists(tempInput)) File.Delete(tempInput);
            if (File.Exists(tempOutput)) File.Delete(tempOutput);
        }
    }

    public async Task<byte[]?> RenderToPngAsync(string mermaidCode, double scale = 3.0)
    {
        var result = await RenderAndValidateAsync(mermaidCode, scale);
        return result.Success ? result.ImageData : null;
    }

    public async Task<(bool Success, string? Error)> ValidateSyntaxAsync(string mermaidCode)
    {
        var result = await RenderAndValidateAsync(mermaidCode, 1.0);
        return (result.Success, result.ErrorMessage);
    }

    private static string BuildCacheKey(string mermaidCode, double scale)
    {
        var normalized = $"{scale:F2}|{mermaidCode}";
        var hashBytes = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(hashBytes);
    }

    private bool TryGetFromCache(string key, out byte[]? imageBytes)
    {
        lock (_cacheLock)
        {
            if (_renderCache.TryGetValue(key, out var bytes))
            {
                imageBytes = bytes;
                return true;
            }
        }

        imageBytes = null;
        return false;
    }

    private void AddToCache(string key, byte[] imageBytes)
    {
        lock (_cacheLock)
        {
            if (_renderCache.ContainsKey(key))
            {
                _renderCache[key] = imageBytes;
                return;
            }

            _renderCache[key] = imageBytes;
            _cacheOrder.AddLast(key);

            while (_cacheOrder.Count > MaxCacheEntries)
            {
                var oldest = _cacheOrder.First?.Value;
                if (oldest == null)
                {
                    break;
                }

                _cacheOrder.RemoveFirst();
                _renderCache.Remove(oldest);
            }
        }
    }
}
