using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Avalonia.Platform.Storage;
using Diagramon.Services.Localization;

namespace Diagramon.Services.Documents;

/// <summary>
/// 文档格式注册表（方案 §4.1）。**唯一**的格式分派点：文件解析、文件选择器、高亮、渲染器、
/// 默认文件名都从这里取，别处不允许按格式 id 写 <c>if / else</c>。
/// </summary>
public sealed class DocumentFormatRegistry
{
    /// <summary>注册表回退格式：未知扩展名按它处理（现有行为是"全部当 Mermaid"）。</summary>
    public const string FallbackFormatId = "mermaid";

    private static readonly Strings S = Strings.Instance;

    private readonly List<IDocumentFormat> _formats;
    private readonly Dictionary<string, IDocumentFormat> _byId;

    /// <param name="formats">注册项，顺序即界面顺序（第一个通常与回退格式一致）。</param>
    public DocumentFormatRegistry(IEnumerable<IDocumentFormat> formats)
    {
        _formats = formats.ToList();
        if (_formats.Count == 0)
        {
            throw new ArgumentException("至少需要一个格式注册项。", nameof(formats));
        }

        _byId = new Dictionary<string, IDocumentFormat>(StringComparer.OrdinalIgnoreCase);
        foreach (var format in _formats)
        {
            _byId[format.Id] = format;
        }

        Fallback = _byId.TryGetValue(FallbackFormatId, out var fallback) ? fallback : _formats[0];
    }

    /// <summary>未知扩展名的回退格式。</summary>
    public IDocumentFormat Fallback { get; }

    /// <summary>全部注册项（声明顺序）。</summary>
    public IReadOnlyList<IDocumentFormat> All => _formats;

    /// <summary>按 id 取格式；<c>null</c> 或未知 id 返回 <see cref="Fallback"/>。</summary>
    public IDocumentFormat Get(string? id)
    {
        return id != null && _byId.TryGetValue(id, out var format) ? format : Fallback;
    }

    /// <summary>
    /// 按文件名做**最长后缀匹配**得到格式。
    /// </summary>
    /// <remarks>
    /// 不能用 <see cref="Path.GetExtension(string)"/>：它只能拿到最后一段，<c>.drawio.svg</c> 会被判成 <c>.svg</c>。
    /// 只匹配文件名（不匹配目录），否则目录名里出现 <c>.dot</c> 之类会误判。
    /// </remarks>
    public IDocumentFormat Resolve(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return Fallback;
        }

        var fileName = Path.GetFileName(filePath);
        IDocumentFormat? best = null;
        var bestLength = -1;

        foreach (var format in _formats)
        {
            foreach (var extension in format.Extensions)
            {
                if (extension.Length > bestLength &&
                    fileName.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
                {
                    best = format;
                    bestLength = extension.Length;
                }
            }
        }

        return best ?? Fallback;
    }

    /// <summary>
    /// 按服务端的 <c>format</c> 取值取格式。服务端白名单里同一格式可能有多个别名
    /// （<c>mmd</c>/<c>mermaid</c>、<c>dot</c>/<c>gv</c>），这里按 <see cref="IDocumentFormat.CloudFormatId"/>
    /// 匹配，未命中则回退（服务端对未知格式也回退为 <c>other</c> 存储，不报错）。
    /// </summary>
    public IDocumentFormat ResolveCloudFormat(string? cloudFormatId)
    {
        if (string.IsNullOrWhiteSpace(cloudFormatId))
        {
            return Fallback;
        }

        foreach (var format in _formats)
        {
            if (format.CloudFormatIds.Any(id => string.Equals(id, cloudFormatId, StringComparison.OrdinalIgnoreCase)))
            {
                return format;
            }
        }

        return Fallback;
    }

    /// <summary>打开对话框的文件类型过滤器：各格式 + 全部支持的格式 + 所有文件。</summary>
    public IReadOnlyList<FilePickerFileType> BuildOpenPickerTypes()
    {
        var types = _formats.Select(BuildFormatPickerType).ToList();

        types.Add(new FilePickerFileType(S.Get("FileTypeAllSupported"))
        {
            Patterns = _formats.SelectMany(f => f.Extensions.Select(e => "*" + e)).ToArray()
        });

        types.Add(new FilePickerFileType(S.Get("FileTypeAllFiles"))
        {
            Patterns = ["*.*"]
        });

        return types;
    }

    /// <summary>
    /// 该格式的**规范扩展名**（默认文件名带的那个，如 <c>.mmd</c> / <c>.drawio</c>）。
    /// </summary>
    /// <remarks>保存对话框的建议文件名、缺省扩展名与过滤器顺序都以它为准 —— 只此一处定义。</remarks>
    public string CanonicalExtension(IDocumentFormat format) => Path.GetExtension(S.Get(format.DefaultFileNameKey));

    /// <summary>
    /// 保存对话框的文件类型：**当前标签页的格式排在最前**，其后是"所有文件"。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 顺序就是缺省值：Win32 / Avalonia 的保存对话框用第一个过滤器推导"用户没写扩展名"时的缺省扩展名。
    /// 早先这里按注册表顺序返回全部格式（Mermaid 恒在第一），于是 drawio / DOT / Excalidraw 标签页
    /// 另存为时都会存成 <c>.mmd</c> —— 文件后缀与内容对不上，下次打开会被按错误格式解析。
    /// </para>
    /// <para>
    /// 只列当前格式 + 所有文件，不列别的格式：本应用的保存**不做跨格式转换**，
    /// 把其它格式摆进来等于诱导用户把 drawio 的 XML 存成 <c>.mmd</c>。
    /// </para>
    /// </remarks>
    public IReadOnlyList<FilePickerFileType> BuildSavePickerTypes(IDocumentFormat? current)
    {
        if (current == null)
        {
            return _formats.Select(BuildFormatPickerType).ToList();
        }

        return
        [
            BuildFormatPickerType(current),
            new FilePickerFileType(S.Get("FileTypeAllFiles"))
            {
                Patterns = ["*.*"]
            }
        ];
    }

    /// <summary>
    /// 另存为对话框的"建议文件名"：对齐到该格式的**规范扩展名**。
    /// </summary>
    /// <remarks>
    /// 三种情况：没有扩展名就补上规范扩展名；已经是本格式的扩展名（含 <c>.gv</c> 这类等价写法）原样保留；
    /// 是**别的已支持格式**的扩展名则换成规范扩展名（例如历史上被误存成 <c>foo.mmd</c> 的 drawio 标签页，
    /// 再另存为时会建议 <c>foo.drawio</c>）。用户自己敲的非注册扩展名（<c>.txt</c> 之类）尊重不动。
    /// </remarks>
    public string SuggestSaveFileName(IDocumentFormat format, string? currentName)
    {
        var canonicalExtension = CanonicalExtension(format);
        var name = string.IsNullOrWhiteSpace(currentName) ? S.Get(format.DefaultFileNameKey) : currentName!;

        var currentExtension = Path.GetExtension(name);
        if (string.IsNullOrEmpty(currentExtension))
        {
            return name + canonicalExtension;
        }

        if (format.Extensions.Contains(currentExtension, StringComparer.OrdinalIgnoreCase))
        {
            return name;
        }

        var belongsToAnotherFormat = _formats.Any(other =>
            !ReferenceEquals(other, format) &&
            other.Extensions.Contains(currentExtension, StringComparer.OrdinalIgnoreCase));

        return belongsToAnotherFormat ? Path.ChangeExtension(name, canonicalExtension) : name;
    }

    private FilePickerFileType BuildFormatPickerType(IDocumentFormat format)
    {
        var name = S.Get(format.DisplayNameKey);
        var displayName = string.IsNullOrWhiteSpace(name) ? format.Id : name;

        // 默认文件名带的是该格式的**规范扩展名**（未命名.mmd / 未命名.dot）；保存对话框用第一个
        // pattern 推导"用户没写扩展名"时的缺省扩展名，所以把它排到最前 —— 否则会出现
        // "输入 foo 保存成 foo.mermaid" 这种与默认文件名不一致的结果。
        var canonicalExtension = CanonicalExtension(format);

        var patterns = format.Extensions
            .OrderByDescending(extension =>
                string.Equals(extension, canonicalExtension, StringComparison.OrdinalIgnoreCase))
            .Select(extension => "*" + extension)
            .ToArray();

        return new FilePickerFileType(string.Format(S.Get("FileTypeFormatLabel"), displayName))
        {
            Patterns = patterns
        };
    }
}