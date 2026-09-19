using System;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.Remote;

namespace Diagramon.Services;

/// <summary>注册的三种结局。</summary>
public enum RegisterOutcome
{
    /// <summary>账号立即可用，令牌已写入会话。</summary>
    Active,

    /// <summary>账号待邮箱激活，**令牌未发放**；调用方应引导用户去邮箱。</summary>
    PendingVerification,

    /// <summary>失败，原因见 <see cref="AuthService.LastErrorCode"/>。</summary>
    Failed,
}

/// <summary>注册结果。仅 <see cref="RegisterOutcome.PendingVerification"/> 时携带后两个字段。</summary>
public sealed record RegisterResult(RegisterOutcome Outcome, string? EmailMasked, int? VerifyTtlSeconds);

/// <summary>
/// 云端服务客户端：匿名配置下发、注册、登录、令牌刷新、登出。
/// </summary>
/// <remarks>
/// <para>
/// <b>未登录是正常状态</b>：本服务任何方法都不要求已登录，也不会因为"没有令牌"而失败。
/// 预期内的失败（凭据错误、令牌失效、网络不可达）统一返回 <c>false</c>，
/// 并把**线上错误码**写进 <see cref="LastErrorCode"/> —— 文案由表现层本地化，
/// 服务层不持有任何用户可见字符串。
/// </para>
/// <para>
/// 令牌只持久化 <b>refresh token</b>（access token 只有 30 分钟，不值得持久化）。
/// 启动时用它换一套新的，因此不存在"启动时拿着过期 access token"的窗口。
/// </para>
/// </remarks>
public sealed class AuthService
{
    private const string RefreshTokenKey = "Auth_RefreshToken";

    private readonly ApiClient _api;
    private readonly SettingsService _settings;

    public AuthSession Session { get; } = new();

    /// <summary>最近一次失败的服务端错误码（如 <c>invalid_credentials</c>）。成功时清空。</summary>
    public string? LastErrorCode { get; private set; }

    /// <summary>服务端附带的原始说明，仅用于诊断，不直接展示给用户。</summary>
    public string? LastErrorDetail { get; private set; }

    /// <summary>最近一次成功的 <c>GET /v1/config</c> 结果；未取到时为 null。</summary>
    public ConfigResponse? Config { get; private set; }

    public AuthService(ApiClient api, SettingsService settings)
    {
        _api = api;
        _settings = settings;
    }

    private static string OsName =>
        OperatingSystem.IsWindows() ? "Windows" :
        OperatingSystem.IsMacOS() ? "macOS" :
        OperatingSystem.IsLinux() ? "Linux" : "Unknown";

    private DeviceDto BuildDevice() => new()
    {
        DeviceId = _settings.GetOrCreateDeviceId(),
        Name = Environment.MachineName,
        Os = OsName,
        AppVersion = typeof(AuthService).Assembly.GetName().Version?.ToString(),
    };

    /// <summary>
    /// 冷启动的第一个请求：**匿名可调**。成功时会更新会话的 <c>CloudEnabled</c>。
    /// </summary>
    public async Task<ConfigResponse?> GetConfigAsync(CancellationToken cancellationToken = default)
    {
        var result = await _api.SendAsync<ConfigResponse>(
            HttpMethod.Get, "/v1/config", authenticated: false, cancellationToken: cancellationToken);

        if (!result.Ok || result.Value == null)
        {
            SetError(result);
            return null;
        }

        Config = result.Value;
        Session.CloudEnabled = result.Value.CloudEnabled;
        ClearError();
        return result.Value;
    }

    /// <summary>
    /// 注册。**必须按状态码分派**：201 才是"账号已可用并发放令牌"，202 是"待邮箱激活、无令牌"。
    /// </summary>
    /// <remarks>
    /// 这里刻意先收成 <see cref="JsonElement"/>，等看到状态码再决定按哪种包络解析 ——
    /// 若直接 <c>SendAsync&lt;AuthResponse&gt;</c>，202 会被当成 2xx 成功，反序列化出一份
    /// 字段全为默认值的包络（空令牌），进而误判为登录成功。
    /// </remarks>
    public async Task<RegisterResult> RegisterAsync(
        string email, string password, CancellationToken cancellationToken = default)
    {
        var body = new RegisterRequest
        {
            Email = email,
            Password = password,
            Device = BuildDevice(),
        };

        var result = await _api.SendAsync<JsonElement>(
            HttpMethod.Post, "/v1/auth/register", body, authenticated: false, cancellationToken: cancellationToken);

        if (result.Ok && result.Status == HttpStatusCode.Accepted)
        {
            var pending = Deserialize<RegisterPendingResponse>(result.Value);
            // 服务端既没发令牌、也没吊销任何既有会话，所以这里既不 Apply 也不 ClearLocalSession：
            // 注册失败/待激活都不该把已登录的用户踢下线（与原 AuthenticateAsync 的失败语义一致）。
            ClearError();
            return new RegisterResult(
                RegisterOutcome.PendingVerification, pending?.EmailMasked, pending?.VerifyTtlSeconds);
        }

        var auth = result.Ok ? Deserialize<AuthResponse>(result.Value) : null;
        if (auth == null)
        {
            SetError(result);
            return new RegisterResult(RegisterOutcome.Failed, null, null);
        }

        Apply(auth);
        ClearError();
        return new RegisterResult(RegisterOutcome.Active, null, null);
    }

    /// <summary>
    /// 重发激活邮件。服务端**恒返回 204**（不泄露账号是否存在），
    /// 所以"调用成功"不等于"邮件确实发出去了" —— 界面文案不得承诺"已发往该邮箱"。
    /// </summary>
    public async Task<bool> ResendVerificationAsync(string email, CancellationToken cancellationToken = default)
    {
        var body = new ResendVerificationRequest { Email = email };

        var result = await _api.SendAsync<object>(
            HttpMethod.Post, "/v1/auth/resend-verification", body, authenticated: false,
            cancellationToken: cancellationToken);

        if (result.Ok)
        {
            ClearError();
            return true;
        }

        SetError(result);
        return false;
    }

    private static T? Deserialize<T>(JsonElement element) where T : class =>
        element.ValueKind == JsonValueKind.Undefined ? null : element.Deserialize<T>(AuthJson.Options);

    public Task<bool> LoginAsync(string email, string password, CancellationToken cancellationToken = default)
    {
        var body = new LoginRequest
        {
            Email = email,
            Password = password,
            Device = BuildDevice(),
        };
        return AuthenticateAsync("/v1/auth/login", body, cancellationToken);
    }

    /// <summary>
    /// 用已保存的 refresh token 恢复会话。没有令牌、或令牌已失效，都只是返回 false —— 不设错误。
    /// </summary>
    /// <remarks>本方法同时充当文档接口 401 后的"静默刷新"回调。</remarks>
    public async Task<bool> TryRestoreSessionAsync(CancellationToken cancellationToken = default)
    {
        var refreshToken = LoadRefreshToken();
        if (string.IsNullOrEmpty(refreshToken))
        {
            return false;
        }

        var body = new RefreshRequest
        {
            RefreshToken = refreshToken,
            DeviceId = _settings.GetOrCreateDeviceId(),
        };

        var result = await _api.SendAsync<AuthResponse>(
            HttpMethod.Post, "/v1/auth/refresh", body, authenticated: false, cancellationToken: cancellationToken);

        if (result.Ok && result.Value != null)
        {
            Apply(result.Value);
            ClearError();
            return true;
        }

        // 令牌过期 / 被吊销 / 设备不匹配：清掉本地令牌，静默回到未登录。
        // 这是正常状态而不是错误，所以刻意不设 LastErrorCode。
        if (result.Status == HttpStatusCode.Unauthorized)
        {
            ClearLocalSession();
            return false;
        }

        SetError(result);
        return false;
    }

    /// <summary>登出：尽力通知服务端吊销，无论成败都清除本地会话。</summary>
    public async Task LogoutAsync(CancellationToken cancellationToken = default)
    {
        var refreshToken = LoadRefreshToken();
        if (!string.IsNullOrEmpty(refreshToken))
        {
            var body = new LogoutRequest { RefreshToken = refreshToken };
            await _api.SendAsync<object>(
                HttpMethod.Post, "/v1/auth/logout", body, authenticated: false, cancellationToken: cancellationToken);
        }

        ClearLocalSession();
        ClearError();
    }

    private async Task<bool> AuthenticateAsync(string path, object body, CancellationToken cancellationToken)
    {
        var result = await _api.SendAsync<AuthResponse>(
            HttpMethod.Post, path, body, authenticated: false, cancellationToken: cancellationToken);

        if (!result.Ok || result.Value == null)
        {
            SetError(result);
            return false;
        }

        Apply(result.Value);
        ClearError();
        return true;
    }

    private void Apply(AuthResponse response)
    {
        _api.AccessToken = response.Tokens.AccessToken;
        StoreRefreshToken(response.Tokens.RefreshToken);
        Session.User = response.User;
        Session.Membership = response.Membership;
    }

    private void ClearLocalSession()
    {
        _api.AccessToken = null;
        SecureStorageService.SaveProtectedValue(RefreshTokenKey, null, SettingsService.SecureConfigPath);
        Session.Clear();
    }

    private void StoreRefreshToken(string token) =>
        SecureStorageService.SaveProtectedValue(RefreshTokenKey, token, SettingsService.SecureConfigPath);

    private string? LoadRefreshToken() =>
        SecureStorageService.LoadProtectedValue(RefreshTokenKey, SettingsService.SecureConfigPath);

    private void SetError<T>(ApiResult<T> result)
    {
        LastErrorCode = result.ErrorCode ?? ApiClient.NetworkError;
        LastErrorDetail = result.ErrorDetail;
    }

    private void ClearError()
    {
        LastErrorCode = null;
        LastErrorDetail = null;
    }
}
