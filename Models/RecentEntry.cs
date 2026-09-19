namespace Diagramon.Models;

/// <summary>
/// 最近文件条目的持久化形态。
/// 存 <see cref="StableId"/> 而非路径，是为了让云端文档（其身份是服务端 docId）能共用同一结构。
/// </summary>
public sealed class RecentEntry
{
    public string Kind { get; set; } = "local";

    public string DisplayPath { get; set; } = string.Empty;

    public string StableId { get; set; } = string.Empty;

    public RecentEntry()
    {
    }

    public RecentEntry(IDocumentLocation location)
    {
        Kind = location.Kind;
        DisplayPath = location.DisplayPath;
        StableId = location.StableId;
    }

    /// <summary>
    /// 还原为可用的位置。尚未实现的 Kind 返回 null —— 由调用方跳过，而不是崩溃。
    /// </summary>
    public IDocumentLocation? ToLocation()
    {
        return Kind switch
        {
            "local" => string.IsNullOrWhiteSpace(DisplayPath) ? null : new LocalDocumentLocation(DisplayPath),
            _ => null
        };
    }
}
