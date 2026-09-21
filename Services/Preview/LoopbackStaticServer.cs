using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Diagramon.Services.Preview;

/// <summary>
/// 进程内 loopback 静态文件服务：把渲染器资源以**真实 origin** 提供给 WebView（方案 §4.4 回退方案）。
/// </summary>
/// <remarks>
/// <para>
/// 为什么需要它：Chromium 下 <c>file://</c> 会拦截 ES module 的跨源请求
/// （实测报错 <c>Failed to fetch dynamically imported module</c>），而
/// <c>@hpcc-js/wasm-graphviz</c> 是单文件 ESM，因此 <c>NpmWasm</c> 供给必须走真实 origin。
/// </para>
/// <para>
/// 用 <see cref="TcpListener"/> 而不是 <c>HttpListener</c>：后者在 Windows 上对非管理员进程
/// 需要 URL ACL 预留，未预留时直接抛"拒绝访问"。这里只实现静态 <c>GET</c>，够用且无权限依赖。
/// </para>
/// <para>
/// 安全约束（与方案 §4.4 回退方案一致）：<b>只绑回环</b>、<b>只服务白名单目录</b>、
/// 解析后必须落在挂载根内（挡 <c>..</c> 穿越），且只用伴随随机端口。
/// </para>
/// </remarks>
public sealed class LoopbackStaticServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly List<(string Prefix, string Root)> _mounts;
    private readonly CancellationTokenSource _cts = new();

    private LoopbackStaticServer(TcpListener listener, IEnumerable<(string Prefix, string Root)> mounts)
    {
        _listener = listener;
        _mounts = [.. mounts];
        _listener.Start();
        BaseUrl = $"http://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}";
        _ = AcceptLoopAsync();
    }

    /// <summary>形如 <c>http://127.0.0.1:52341</c>（无尾斜杠）。</summary>
    public string BaseUrl { get; }

    /// <summary>
    /// 启动服务。挂载点形如 <c>("/dot/", @"C:\…\webpreview\dot")</c>；
    /// 前缀按长度降序匹配，因此更具体的前缀优先。
    /// </summary>
    public static LoopbackStaticServer Start(IEnumerable<(string Prefix, string Root)> mounts)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        return new LoopbackStaticServer(listener, mounts);
    }

    private async Task AcceptLoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_cts.Token);
            }
            catch
            {
                return;
            }

            _ = Task.Run(() => ServeAsync(client));
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                using var stream = client.GetStream();
                var requestLine = await ReadRequestLineAsync(stream);
                if (requestLine == null)
                {
                    return;
                }

                var parts = requestLine.Split(' ');
                if (parts.Length < 2 || !string.Equals(parts[0], "GET", StringComparison.OrdinalIgnoreCase))
                {
                    await WriteAsync(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("method not allowed"));
                    return;
                }

                var path = parts[1];
                var queryIndex = path.IndexOf('?');
                if (queryIndex >= 0)
                {
                    path = path[..queryIndex];
                }

                if (TryResolveFile(path, out var filePath))
                {
                    var bytes = await File.ReadAllBytesAsync(filePath);
                    await WriteAsync(stream, 200, MimeFor(Path.GetExtension(filePath)), bytes);
                }
                else
                {
                    await WriteAsync(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("not found"));
                }
            }
            catch
            {
                // 单个连接失败不影响服务；浏览器会自行重试或报网络错误
            }
        }
    }

    private static async Task<string?> ReadRequestLineAsync(NetworkStream stream)
    {
        var buffer = new byte[8192];
        var total = 0;

        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total));
            if (read <= 0)
            {
                return null;
            }

            total += read;

            var text = Encoding.ASCII.GetString(buffer, 0, total);
            var lineEnd = text.IndexOf("\r\n", StringComparison.Ordinal);
            if (lineEnd > 0)
            {
                return text[..lineEnd];
            }
        }

        return null;
    }

    private static async Task WriteAsync(NetworkStream stream, int status, string contentType, byte[] body)
    {
        var header = new StringBuilder()
            .Append("HTTP/1.1 ").Append(status).Append(status == 200 ? " OK" : " Error").Append("\r\n")
            .Append("Content-Type: ").Append(contentType).Append("\r\n")
            .Append("Content-Length: ").Append(body.Length).Append("\r\n")
            .Append("Cache-Control: no-store\r\n")
            .Append("Connection: close\r\n\r\n")
            .ToString();

        await stream.WriteAsync(Encoding.ASCII.GetBytes(header));
        await stream.WriteAsync(body);
        await stream.FlushAsync();
    }

    private bool TryResolveFile(string rawPath, out string filePath)
    {
        filePath = string.Empty;

        string decoded;
        try
        {
            decoded = Uri.UnescapeDataString(rawPath);
        }
        catch
        {
            return false;
        }

        if (decoded.IndexOf('\0') >= 0 || decoded.Contains('\\'))
        {
            return false;
        }

        var normalized = decoded.Replace('/', Path.DirectorySeparatorChar);
        var mount = _mounts
            .Where(m => normalized.StartsWith(m.Prefix.Replace('/', Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(m => m.Prefix.Length)
            .FirstOrDefault();

        if (mount.Root == null)
        {
            return false;
        }

        var rootFull = Path.GetFullPath(mount.Root);
        var candidate = Path.GetFullPath(Path.Combine(rootFull, normalized[mount.Prefix.Length..]));

        if (!candidate.StartsWith(rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(candidate))
        {
            return false;
        }

        filePath = candidate;
        return true;
    }

    private static string MimeFor(string extension)
    {
        return extension.ToLowerInvariant() switch
        {
            ".html" or ".htm" => "text/html; charset=utf-8",
            ".js" or ".mjs" => "text/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".wasm" => "application/wasm",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
    }

    public void Dispose()
    {
        _cts.Cancel();
        try
        {
            _listener.Stop();
        }
        catch
        {
        }

        _cts.Dispose();
    }
}