using System.IO;
using System.Xml;
using AvaloniaEdit.Highlighting;
using AvaloniaEdit.Highlighting.Xshd;

namespace Diagramon.Services.Highlighting;

/// <summary>
/// 从 XSHD 字符串建 <see cref="IHighlightingDefinition"/>。
/// </summary>
/// <remarks>
/// 把 <c>MermaidHighlightingProvider.Create()</c> 的做法泛化出来：每个格式只提供 XSHD 文本，
/// 装载方式共用一份，避免每加一个格式就复制一遍 XmlReader/HighlightingLoader 样板。
/// </remarks>
public static class XshdLoader
{
    public static IHighlightingDefinition Create(string xshd)
    {
        using var stringReader = new StringReader(xshd);
        using var xmlReader = XmlReader.Create(stringReader);
        return HighlightingLoader.Load(xmlReader, HighlightingManager.Instance);
    }
}