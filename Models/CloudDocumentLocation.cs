namespace Diagramon.Models;

/// <summary>云端文档。</summary>
/// <remarks>
/// <see cref="StableId"/> 是服务端文档 id（**客户端生成的 UUIDv7**，见契约 1）——
/// 因此"先本地、后上云"时身份会从规范化路径变成 docId，AI 会话键随之改变，已有会话不跟随。
/// v1 接受这一限制。
/// </remarks>
public sealed record CloudDocumentLocation(
    string DocumentId,
    string DisplayName,
    string Path = "",
    string? VaultId = null) : IDocumentLocation
{
    public string Kind => "cloud";

    /// <summary>库内路径 + 名称；根目录下就是名称本身。</summary>
    public string DisplayPath => Path.Length == 0 ? DisplayName : $"{Path}/{DisplayName}";

    public string StableId => DocumentId;

    public bool IsWritable => true;
}
