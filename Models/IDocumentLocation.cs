namespace Diagramon.Models;

/// <summary>
/// 文档位置与身份。
/// 本地文件路径与（将来的）云端文档 id 都通过它表达，
/// 使标题、保存、最近文件、AI 会话键不再直接依赖"路径"这一种形态。
/// </summary>
public interface IDocumentLocation
{
    /// <summary>位置种类："local" | "cloud"。</summary>
    string Kind { get; }

    /// <summary>标题栏 / 最近文件等处展示用。</summary>
    string DisplayPath { get; }

    /// <summary>
    /// 稳定身份：最近文件去重、AI 会话键、（将来）云端文档 id。
    /// 本地实现返回规范化路径；云端实现返回服务端 docId。
    /// </summary>
    string StableId { get; }

    bool IsWritable { get; }
}
