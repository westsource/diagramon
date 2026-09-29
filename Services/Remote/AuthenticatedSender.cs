using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Diagramon.Services.Remote;

/// <summary>
/// 「带令牌的请求」的统一发送器：**401 → 静默刷新一次 → 重试一次**。
/// </summary>
/// <remarks>
/// <para>
/// 抽出来是因为它有**两个**消费者：云端文档（<c>RemoteDocumentStore</c>）与云端 AI
/// （<c>CloudAIService</c>）。刷新语义错一点就会**吊销整条 family 会话**
/// —— 服务端的 refresh 是"轮换 + 重用检测"，检测到重用即吊销整族 ——
/// 所以两处各写一遍必然漂移，而漂移的代价是"用户突然被登出"。
/// </para>
/// <para>
/// 刷新失败时**把原 401 原样返回**，由调用方切回未登录态 —— 未登录是正常状态，不是错误。
/// </para>
/// </remarks>
public sealed class AuthenticatedSender
{
    private readonly ApiClient _api;
    private readonly Func<CancellationToken, Task<bool>> _refreshAsync;

    public AuthenticatedSender(ApiClient api, Func<CancellationToken, Task<bool>> refreshAsync)
    {
        _api = api;
        _refreshAsync = refreshAsync;
    }

    public async Task<ApiResult<T>> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body = null,
        string? ifMatch = null,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? extraHeaders = null)
    {
        var result = await _api.SendAsync<T>(
            method, path, body, authenticated: true, ifMatch: ifMatch,
            timeout: timeout, cancellationToken: cancellationToken, extraHeaders: extraHeaders);

        if (result.Status != HttpStatusCode.Unauthorized)
        {
            return result;
        }

        if (!await _refreshAsync(cancellationToken))
        {
            return result;
        }

        // 重试时**同一份 extraHeaders 要跟着重放**：401 刷新后重发的那一次同样得带上 retry_of，
        // 否则账本上只有第一次调用连着（刷新路径漏头是很典型的疏漏）。
        return await _api.SendAsync<T>(
            method, path, body, authenticated: true, ifMatch: ifMatch,
            timeout: timeout, cancellationToken: cancellationToken, extraHeaders: extraHeaders);
    }
}
