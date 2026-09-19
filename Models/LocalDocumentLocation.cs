namespace Diagramon.Models;

/// <summary>本地文件系统上的文档。</summary>
public sealed record LocalDocumentLocation(string FilePath) : IDocumentLocation
{
    public string Kind => "local";

    public string DisplayPath => FilePath;

    /// <summary>
    /// 规范化路径。规范化失败（非法路径）时回退为原串，
    /// 以保证同一路径在多次比较中得到相同的身份。
    /// </summary>
    public string StableId => DocumentIdentity.Normalize(FilePath) ?? FilePath;

    public bool IsWritable => true;
}
