using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Avalonia.Platform;
using Diagramon.Services.Documents;

namespace Diagramon.Services.Preview;

/// <summary>一个格式的承载面：页面 URL 与页面文件落盘位置。</summary>
/// <param name="Url">导航用的 URL（<c>file://</c> 或 <c>http://127.0.0.1:&lt;端口&gt;…</c>）。</param>
/// <param name="HtmlFilePath">承载页 HTML 的落盘路径（两种 URL 都写这里）。</param>
public sealed record PreviewSurface(string Url, string HtmlFilePath);

/// <summary>
/// 承载面宿主：把渲染器的资源与页面落盘、按供给方式决定 origin，并返回可导航的 URL
/// （方案 §8.2.3 的"承载方式由 <see cref="RendererProvision"/> 决定"）。
/// </summary>
/// <remarks>
/// <para>
/// <b>不使用全局单例缓存</b>：每个格式一个固定目录（<c>webpreview/&lt;格式 id&gt;</c>），
/// 首次使用时准备资源、之后复用。原来"用 <c>preview.html</c> 是否存在当作已就绪"的判据对多格式不成立。
/// </para>
/// <para>
/// <see cref="RendererProvision.BundledJs"/> → 资源与页面同目录、走 <c>file://</c>；
/// <see cref="RendererProvision.NpmWasm"/> → 页面目录 + 渲染器资源目录都挂到 loopback 真实 origin，
/// 页面里用 <c>/renderer/</c> 前缀引用渲染器资源。
/// </para>
/// </remarks>
public sealed class PreviewSurfaceHost : IDisposable
{
    private readonly string _root;
    private readonly Dictionary<string, PreviewSurface> _surfaces = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _mounts = new(StringComparer.OrdinalIgnoreCase);
    private LoopbackStaticServer? _server;

    public PreviewSurfaceHost()
    {
        _root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Diagramon",
            "webpreview");
    }

    /// <summary>准备（或复用）某个格式的承载面。会按需启动 loopback 服务。</summary>
    public PreviewSurface GetOrPrepare(IDocumentFormat format)
    {
        if (_surfaces.TryGetValue(format.Id, out var existing))
        {
            return existing;
        }

        var directory = Path.Combine(_root, format.Id);
        Directory.CreateDirectory(directory);
        CopyAssets(format.Renderer.Assets, directory);

        var htmlPath = Path.Combine(directory, "index.html");
        PreviewSurface surface;

        if (format.Renderer.Provision == RendererProvision.NpmWasm)
        {
            _mounts["/" + format.Id + "/"] = directory;

            var originDirectory = format.Renderer.OriginAssetsDirectory;
            if (!string.IsNullOrEmpty(originDirectory))
            {
                _mounts["/renderer/"] = originDirectory;
            }

            var server = EnsureServer();
            surface = new PreviewSurface($"{server.BaseUrl}/{format.Id}/index.html", htmlPath);
        }
        else
        {
            surface = new PreviewSurface(new Uri(htmlPath).AbsoluteUri, htmlPath);
        }

        _surfaces[format.Id] = surface;
        return surface;
    }

    /// <summary>写入承载页 HTML。</summary>
    public static void WritePage(PreviewSurface surface, string html)
    {
        var directory = Path.GetDirectoryName(surface.HtmlFilePath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(surface.HtmlFilePath, html, System.Text.Encoding.UTF8);
    }

    private LoopbackStaticServer EnsureServer()
    {
        return _server ??= LoopbackStaticServer.Start(
            _mounts.Select(pair => (pair.Key, pair.Value)).ToList());
    }

    /// <summary>把随包资源落到承载目录；内容长度一致时跳过（避免每次启动重复复制 3 MB 的 mermaid.min.js）。</summary>
    private static void CopyAssets(IReadOnlyList<RendererAsset> assets, string directory)
    {
        foreach (var asset in assets)
        {
            var target = Path.Combine(directory, asset.TargetFileName);

            try
            {
                if (asset.Source.StartsWith("avares://", StringComparison.OrdinalIgnoreCase))
                {
                    using var source = AssetLoader.Open(new Uri(asset.Source));
                    if (File.Exists(target) && new FileInfo(target).Length == source.Length)
                    {
                        continue;
                    }

                    using var destination = File.Create(target);
                    source.CopyTo(destination);
                }
                else
                {
                    if (File.Exists(target) && new FileInfo(target).Length == new FileInfo(asset.Source).Length)
                    {
                        continue;
                    }

                    File.Copy(asset.Source, target, overwrite: true);
                }
            }
            catch
            {
                // 资源复制失败不致命：页面加载时会报缺失，用户能看到现象而不是崩溃
            }
        }
    }

    /// <summary>清理 7 天前的承载页（历史遗留的 <c>webpreview/preview*.html</c> 也会被清掉）。</summary>
    public static void CleanupStaleFiles()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Diagramon",
            "webpreview");

        if (!Directory.Exists(root))
        {
            return;
        }

        var cutoff = DateTime.Now.AddDays(-7);

        try
        {
            foreach (var file in Directory.EnumerateFiles(root, "*.html", SearchOption.AllDirectories))
            {
                try
                {
                    if (File.GetCreationTime(file) < cutoff)
                    {
                        File.Delete(file);
                    }
                }
                catch
                {
                }
            }
        }
        catch
        {
        }
    }

    public void Dispose()
    {
        _server?.Dispose();
        _server = null;
    }
}