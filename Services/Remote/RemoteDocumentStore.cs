using System;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.Remote;

namespace Diagramon.Services.Remote;

/// <summary>
/// 云端文档存储的客户端：只覆盖 <c>/v1/documents</c> 的 CRUD。
/// </summary>
/// <remarks>
/// <para>
/// <b>不暴露任何同步语义</b>（无 outbox / 本地索引 / 冲突副本）—— v1 的云端只是"另一个保存位置"。
/// </para>
/// <para>
/// 所有方法在 <b>401</b> 时会静默刷新一次令牌并重试一次；刷新失败则把 401 原样返回，
/// 由调用方切回未登录态（未登录是正常状态，不是错误）。
/// </para>
/// </remarks>
public sealed class RemoteDocumentStore
{
    /// <summary>服务端错误码。</summary>
    public const string ErrorVersionConflict = "version_conflict";

    /// <summary>服务端错误码：路径等字段不合法。</summary>
    public const string ErrorValidation = "validation_error";

    /// <summary>服务端错误码：同名目录/文档已存在。</summary>
    public const string ErrorNameTaken = "name_taken";

    private readonly ApiClient _api;
    private readonly Func<CancellationToken, Task<bool>> _refreshAsync;

    public RemoteDocumentStore(ApiClient api, Func<CancellationToken, Task<bool>> refreshAsync)
    {
        _api = api;
        _refreshAsync = refreshAsync;
    }

    /// <summary>
    /// 规范化库内相对路径：去首尾空白与两端的 <c>/</c>，合并重复的 <c>/</c>。
    /// </summary>
    /// <remarks>
    /// 服务端在写入时同样会规范化并可能回 422；这里做的是让界面显示与请求保持一致的最小处理，
    /// <b>不是</b>合法性校验（非法字符仍由服务端裁决）。
    /// </remarks>
    public static string NormalizePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return string.Empty;
        }

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return string.Join('/', segments);
    }

    /// <summary>
    /// 列表（游标分页，**不含 content**）。
    /// </summary>
    /// <param name="path">
    /// 只列该目录直属的文档；空串 = 根目录。<b>该参数总会发送</b> ——
    /// 服务端把"缺省 path"理解为"不做路径过滤"（v1 的历史行为），而界面要的始终是某一层。
    /// </param>
    /// <param name="recursive">连同子目录一并列出。</param>
    public Task<ApiResult<DocumentListResponse>> ListAsync(
        int limit = 50,
        string? cursor = null,
        string? format = null,
        string? path = null,
        bool recursive = false,
        string? vaultId = null,
        CancellationToken cancellationToken = default)
    {
        var query = $"?limit={limit}&path={Uri.EscapeDataString(NormalizePath(path))}";
        if (!string.IsNullOrEmpty(cursor)) query += $"&cursor={Uri.EscapeDataString(cursor)}";
        if (!string.IsNullOrEmpty(format)) query += $"&format={Uri.EscapeDataString(format)}";
        if (recursive) query += "&recursive=true";
        if (!string.IsNullOrEmpty(vaultId)) query += $"&vaultId={Uri.EscapeDataString(vaultId)}";

        return SendWithRetryAsync<DocumentListResponse>(() =>
            _api.SendAsync<DocumentListResponse>(HttpMethod.Get, "/v1/documents" + query, cancellationToken: cancellationToken));
    }

    /// <summary>
    /// 列出库里整棵目录树（显式 folders 行 ∪ 文档路径隐含的目录，扁平返回，不含根）。
    /// 空目录只可能来自显式记录，因此界面要"看到空目录"就必须走这个接口而不是只看文档。
    /// </summary>
    public Task<ApiResult<FolderListResponse>> ListFoldersAsync(
        string? vaultId = null, CancellationToken cancellationToken = default)
    {
        var query = string.IsNullOrEmpty(vaultId) ? "" : $"?vaultId={Uri.EscapeDataString(vaultId)}";

        return SendWithRetryAsync<FolderListResponse>(() =>
            _api.SendAsync<FolderListResponse>(HttpMethod.Get, "/v1/folders" + query, cancellationToken: cancellationToken));
    }

    /// <summary>取单个文档：内联给 <c>content</c>，外置给预签名 <c>blob</c>。</summary>
    public Task<ApiResult<DocumentResponse>> GetAsync(Guid documentId, CancellationToken cancellationToken = default)
    {
        return SendWithRetryAsync(() =>
            _api.SendAsync<DocumentResponse>(HttpMethod.Get, $"/v1/documents/{documentId}", cancellationToken: cancellationToken));
    }

    /// <summary>
    /// 写入（新建与更新同一入口）。
    /// </summary>
    /// <param name="ifMatch">
    /// 乐观锁版本；省略或 <c>"0"</c> 表示"仅当不存在时创建"。
    /// </param>
    /// <param name="force">忽略版本强制覆盖。</param>
    /// <param name="path">
    /// 库内相对路径；null/空串 = 根目录。<b>总是发送</b> —— 服务端只在收到 <c>path</c> 时才改路径
    /// （缺省 = 保持原样），因此"移到根目录"必须显式送空串。
    /// </param>
    /// <param name="vaultId">目标库；null = 保持原库（新建时 = 默认库）。</param>
    public Task<ApiResult<DocumentPutResponse>> PutAsync(
        Guid documentId,
        string name,
        string format,
        string content,
        int? ifMatch = null,
        bool force = false,
        string? path = null,
        string? vaultId = null,
        CancellationToken cancellationToken = default)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var body = new DocumentPutRequest
        {
            Name = name,
            Format = format,
            PayloadKind = "text",
            Content = content,
            ContentHash = Sha256Hex(content),
            Size = bytes.Length,
            Path = NormalizePath(path),
            VaultId = vaultId,
        };

        var url = $"/v1/documents/{documentId}" + (force ? "?force=true" : "");
        return SendWithRetryAsync(() =>
            _api.SendAsync<DocumentPutResponse>(
                HttpMethod.Put, url, body,
                ifMatch: ifMatch?.ToString(),
                cancellationToken: cancellationToken));
    }

    /// <summary>改名（不动路径）。</summary>
    public Task<ApiResult<DocumentResponse>> RenameDocumentAsync(
        Guid documentId, string newName, CancellationToken cancellationToken = default)
    {
        var body = new DocumentPatchRequest { Name = newName };

        return SendWithRetryAsync(() =>
            _api.SendAsync<DocumentResponse>(
                HttpMethod.Patch, $"/v1/documents/{documentId}", body, cancellationToken: cancellationToken));
    }

    /// <summary>移动（改名不动、只换路径）。</summary>
    public Task<ApiResult<DocumentResponse>> MoveDocumentAsync(
        Guid documentId, string path, CancellationToken cancellationToken = default)
    {
        var body = new DocumentPatchRequest { Path = NormalizePath(path) };

        return SendWithRetryAsync(() =>
            _api.SendAsync<DocumentResponse>(
                HttpMethod.Patch, $"/v1/documents/{documentId}", body, cancellationToken: cancellationToken));
    }

    /// <summary>整目录移动/改名（folders 行与 documents 行一起做前缀改写）。</summary>
    /// <remarks>允许并入一个已存在的目录；目标目录里出现同名文档则 409 <c>name_taken</c>。</remarks>
    public Task<ApiResult<FolderMoveResponse>> MoveFolderAsync(
        string from, string to, string? vaultId = null, CancellationToken cancellationToken = default)
    {
        var body = new FolderMoveRequest
        {
            From = NormalizePath(from),
            To = NormalizePath(to),
            VaultId = vaultId,
        };

        return SendWithRetryAsync(() =>
            _api.SendAsync<FolderMoveResponse>(HttpMethod.Patch, "/v1/folders", body, cancellationToken: cancellationToken));
    }

    /// <summary>
    /// 显式新建目录 —— <b>可以建成空目录</b>（这正是 folders 表存在的理由）；
    /// 路径里的祖先目录由服务端补齐。已存在（显式或由文档隐含）则 409 <c>name_taken</c>。
    /// </summary>
    public Task<ApiResult<FolderDto>> CreateFolderAsync(
        string path, string? vaultId = null, CancellationToken cancellationToken = default)
    {
        var body = new FolderCreateRequest
        {
            Path = NormalizePath(path),
            VaultId = vaultId,
        };

        return SendWithRetryAsync(() =>
            _api.SendAsync<FolderDto>(HttpMethod.Post, "/v1/folders", body, cancellationToken: cancellationToken));
    }

    /// <summary>
    /// 删除目录：<b>仅当空目录</b>（没有子目录、也没有文档）时成功，否则 409。
    /// 根目录删不得（空路径会被服务端判 422）。
    /// </summary>
    public Task<ApiResult<object>> DeleteFolderAsync(
        string path, string? vaultId = null, CancellationToken cancellationToken = default)
    {
        var query = $"?path={Uri.EscapeDataString(NormalizePath(path))}";
        if (!string.IsNullOrEmpty(vaultId)) query += $"&vaultId={Uri.EscapeDataString(vaultId)}";

        return SendWithRetryAsync(() =>
            _api.SendAsync<object>(HttpMethod.Delete, "/v1/folders" + query, cancellationToken: cancellationToken));
    }

    /// <summary>软删（墓碑）。幂等 —— 已删除或不存在同样成功。</summary>
    public Task<ApiResult<object>> DeleteAsync(Guid documentId, CancellationToken cancellationToken = default)
    {
        return SendWithRetryAsync(() =>
            _api.SendAsync<object>(HttpMethod.Delete, $"/v1/documents/{documentId}", cancellationToken: cancellationToken));
    }

    /// <summary>内容哈希，与服务端的 <c>contentHash</c> 同算法（sha256 的十六进制小写）。</summary>
    public static string Sha256Hex(string content)
    {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content))).ToLowerInvariant();
    }

    /// <summary>
    /// 401 → 静默刷新一次 → 重试一次。其余错误直接返回。
    /// </summary>
    private async Task<ApiResult<T>> SendWithRetryAsync<T>(Func<Task<ApiResult<T>>> send)
    {
        var result = await send();
        if (result.Status != HttpStatusCode.Unauthorized)
        {
            return result;
        }

        if (!await _refreshAsync(CancellationToken.None))
        {
            return result;
        }

        return await send();
    }
}
