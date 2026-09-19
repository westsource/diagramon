using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;

namespace Diagramon.Services.Remote;

/// <summary>一次 API 调用的结果。失败时 <see cref="ErrorCode"/> 是线上错误码或 <see cref="ApiClient.NetworkError"/>。</summary>
public sealed record ApiResult<T>(
    bool Ok,
    T? Value,
    string? ErrorCode,
    string? ErrorDetail,
    JsonElement? Details,
    HttpStatusCode Status);

/// <summary>
/// 云端 API 的统一出入口：基地址、Bearer、错误包络解析。
/// </summary>
/// <remarks>
/// <b>错误包络的键是 snake_case</b>（<c>error_code</c> / <c>trace_id</c>），其余字段一律 camelCase ——
/// 这是服务端契约里唯一的例外，见 <see cref="ApiErrorEnvelope"/>。
/// </remarks>
public sealed class ApiClient : IDisposable
{
    /// <summary>本地码：连不上服务端、或响应体无法解析。服务端不会有这个码。</summary>
    public const string NetworkError = "network_unreachable";

    private readonly HttpClient _http;
    private readonly SettingsService _settings;

    /// <summary>access token，仅驻留内存。由 <see cref="AuthService"/> 在登录/刷新时写入、登出时清空。</summary>
    public string? AccessToken { get; set; }

    public ApiClient(SettingsService settings)
    {
        _settings = settings;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Diagramon");
    }

    public string BaseUrl => _settings.Settings.ServiceBaseUrl.TrimEnd('/');

    public async Task<ApiResult<T>> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body = null,
        bool authenticated = true,
        string? ifMatch = null,
        CancellationToken cancellationToken = default)
    {
        try
        {
            using var request = new HttpRequestMessage(method, BaseUrl + path);

            if (body != null)
            {
                request.Content = new StringContent(
                    JsonSerializer.Serialize(body, AuthJson.Options), Encoding.UTF8, "application/json");
            }

            if (authenticated && !string.IsNullOrEmpty(AccessToken))
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AccessToken);
            }

            if (!string.IsNullOrEmpty(ifMatch))
            {
                request.Headers.TryAddWithoutValidation("If-Match", ifMatch);
            }

            using var response = await _http.SendAsync(request, cancellationToken);
            var text = await response.Content.ReadAsStringAsync(cancellationToken);

            if (response.IsSuccessStatusCode)
            {
                if (string.IsNullOrWhiteSpace(text))
                {
                    return new ApiResult<T>(true, default, null, null, null, response.StatusCode);
                }

                return new ApiResult<T>(
                    true, JsonSerializer.Deserialize<T>(text, AuthJson.Options), null, null, null, response.StatusCode);
            }

            ApiErrorEnvelope? error = null;
            try
            {
                error = JsonSerializer.Deserialize<ApiErrorEnvelope>(text, AuthJson.Options);
            }
            catch (JsonException)
            {
                // 非契约响应（网关错误页等）—— 交由调用方按"网络/未知"处理
            }

            return new ApiResult<T>(
                false,
                default,
                error?.ErrorCode ?? NetworkError,
                error?.Message,
                error?.Details,
                response.StatusCode);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return new ApiResult<T>(false, default, NetworkError, ex.Message, null, 0);
        }
    }

    public void Dispose() => _http.Dispose();
}
