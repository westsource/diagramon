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
