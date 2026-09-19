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

    private readonly ApiClient _api;
    private readonly Func<CancellationToken, Task<bool>> _refreshAsync;

    public RemoteDocumentStore(ApiClient api, Func<CancellationToken, Task<bool>> refreshAsync)
    {
        _api = api;
        _refreshAsync = refreshAsync;
    }

    /// <summary>
    /// 列表（游标分页，**不含 content**）。
    /// </summary>
    public Task<ApiResult<DocumentListResponse>> ListAsync(
        int limit = 50, string? cursor = null, string? format = null, CancellationToken cancellationToken = default)
    {
        var query = $"?limit={limit}";
        if (!string.IsNullOrEmpty(cursor)) query += $"&cursor={Uri.EscapeDataString(cursor)}";
        if (!string.IsNullOrEmpty(format)) query += $"&format={Uri.EscapeDataString(format)}";

        return SendWithRetryAsync<DocumentListResponse>(() =>
            _api.SendAsync<DocumentListResponse>(HttpMethod.Get, "/v1/documents" + query, cancellationToken: cancellationToken));
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
    public Task<ApiResult<DocumentPutResponse>> PutAsync(
        Guid documentId,
        string name,
        string format,
        string content,
        int? ifMatch = null,
        bool force = false,
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
        };

        var path = $"/v1/documents/{documentId}" + (force ? "?force=true" : "");
        return SendWithRetryAsync(() =>
            _api.SendAsync<DocumentPutResponse>(
                HttpMethod.Put, path, body,
                ifMatch: ifMatch?.ToString(),
                cancellationToken: cancellationToken));
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
