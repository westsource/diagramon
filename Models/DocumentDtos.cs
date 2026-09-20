using System.Collections.Generic;

namespace Diagramon.Models;

/// <summary>云端文档的线上 DTO。字段与《Diagramon 服务端方案》§5 文档逐字对应。</summary>
public sealed class DocumentPutRequest
{
    public string Name { get; set; } = string.Empty;
    public string Format { get; set; } = string.Empty;
    public string PayloadKind { get; set; } = "text";
    public string? Content { get; set; }
    public string? ContentHash { get; set; }
    public int? Size { get; set; }
    public string? BlobKey { get; set; }

    /// <summary>库内相对路径；空串=根目录。省略时服务端按根处理。</summary>
    public string? Path { get; set; }

    /// <summary>目标库 id；省略 = 默认库。</summary>
    public string? VaultId { get; set; }
}

public sealed class DocumentListItemDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Format { get; set; } = string.Empty;
    public string PayloadKind { get; set; } = string.Empty;
    public long Size { get; set; }
    public int Version { get; set; }
    public string? ContentHash { get; set; }
    public string? CreatedAt { get; set; }
    public string? UpdatedAt { get; set; }

    /// <summary>库内相对路径；空串=根目录。</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>所属库 id；默认库同样会回带。</summary>
    public string? VaultId { get; set; }
}

public sealed class DocumentListResponse
{
    public List<DocumentListItemDto> Items { get; set; } = new();
    public string? NextCursor { get; set; }
    public bool HasMore { get; set; }
    public QuotaDto? Quota { get; set; }
}

public sealed class QuotaDto
{
    public long UsedBytes { get; set; }
    public long QuotaBytes { get; set; }
}

public sealed class BlobRefDto
{
    public string Url { get; set; } = string.Empty;
    public string? ExpiresAt { get; set; }
    public string? Sha256 { get; set; }
}

public sealed class DocumentResponse
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Format { get; set; } = string.Empty;
    public string PayloadKind { get; set; } = string.Empty;
    public long Size { get; set; }
    public int Version { get; set; }
    public string? ContentHash { get; set; }
    public string? CreatedAt { get; set; }
    public string? UpdatedAt { get; set; }

    /// <summary>库内相对路径；空串=根目录。</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>所属库 id；默认库同样会回带。</summary>
    public string? VaultId { get; set; }

    /// <summary>内联文档的内容；外置文档为 null（改看 <see cref="Blob"/>）。两者互斥。</summary>
    public string? Content { get; set; }

    /// <summary>外置文档的预签名下载地址。</summary>
    public BlobRefDto? Blob { get; set; }
}

public sealed class DocumentPutResponse
{
    public string Id { get; set; } = string.Empty;
    public int Version { get; set; }
    public string? ContentHash { get; set; }
    public long Size { get; set; }
    public string? UpdatedAt { get; set; }
    public QuotaDto? Quota { get; set; }
}

// ---------------------------------------------------------------- 多级路径

/// <summary>
/// 改名的请求体：两个字段都省略时服务端按"无改动"处理。
/// </summary>
public sealed class DocumentPatchRequest
{
    public string? Name { get; set; }

    /// <summary>库内相对路径；空串=根目录。</summary>
    public string? Path { get; set; }
}

/// <summary>
/// 目录树里的一个目录。目录有两个来源：<b>显式</b>的 folders 行（空目录只能这么表达），
/// 以及文档路径<b>隐含</b>出来的目录 —— 列表是两者的并集。
/// </summary>
public sealed class FolderDto
{
    /// <summary>相对路径；空串=根目录（根一般不出现在列表里）。</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>末段名（不含父路径）。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>层级深度；顶层目录为 0（即段数 - 1）。</summary>
    public int Depth { get; set; }

    /// <summary>直属文档数。</summary>
    public int DocumentCount { get; set; }

    /// <summary>是否还有子目录。</summary>
    public bool HasChildren { get; set; }

    /// <summary>库里是否存在这条显式的 folders 行 —— 用来区分"真的建过的空目录"和"由文档隐含的目录"。</summary>
    public bool IsExplicit { get; set; }
}

public sealed class FolderListResponse
{
    public List<FolderDto> Items { get; set; } = new();
}

/// <summary>整目录移动/改名：<c>from</c>/<c>to</c> 都是目录相对路径。</summary>
public sealed class FolderMoveRequest
{
    public string? VaultId { get; set; }
    public string From { get; set; } = string.Empty;
    public string To { get; set; } = string.Empty;
}

/// <summary>整目录移动的结果：被前缀改写的行数。</summary>
public sealed class FolderMoveResponse
{
    /// <summary>被改写的 folders 行数。</summary>
    public int Folders { get; set; }

    /// <summary>被改写的 documents 行数。</summary>
    public int Documents { get; set; }
}

/// <summary>
/// 显式新建目录。路径下的祖先目录会由服务端补齐 —— 这是"空目录"唯一的表达方式，
/// 因为目录通常只是文档路径推导出来的。
/// </summary>
public sealed class FolderCreateRequest
{
    public string? VaultId { get; set; }
    public string Path { get; set; } = string.Empty;
}
