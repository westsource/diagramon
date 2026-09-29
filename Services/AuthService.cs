using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;
using Diagramon.Services.Remote;

namespace Diagramon.Services;


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

    /// <summary>刷新互斥（见 <see cref="TryRestoreSessionAsync"/> 的 remarks）。</summary>
    private readonly SemaphoreSlim _refreshGate = new(1, 1);

    public AuthSession Session { get; } = new();

    /// <summary>
    /// 当前 access token（只读）。**只驻内存**，不落盘。
    /// </summary>
    /// <remarks>
    /// 云 AI provider（<c>CloudAIService</c>）每次请求都从这里取，而不是把它存进
    /// <c>AIModelConfig.ApiKey</c> —— 那个字段会被明文写进 <c>settings.json</c>，
    /// 而 access token 是**账号凭据**且只有 30 分钟寿命。
    /// </remarks>
    public string? CurrentAccessToken => _api.AccessToken;

    /// <summary>
    /// 造一个「带令牌的请求」发送器（401 → 静默刷新一次 → 重试一次）。
    /// </summary>
    /// <remarks>
    /// 放在这里而不是让调用方自己拼：**只有一处知道该怎么建它**，也就只有一处需要保证
    /// "刷新是串行的"（见 <see cref="TryRestoreSessionAsync"/>）。云端文档与云端 AI 各持一个实例
    /// —— 发送器本身无状态，共用的是同一个 <c>ApiClient</c>（连接池）与同一把刷新闸门。
    /// </remarks>
    public AuthenticatedSender CreateSender() => new(_api, TryRestoreSessionAsync);

    /// <summary>最近一次失败的服务端错误码（如 <c>invalid_credentials</c>）。成功时清空。</summary>
    public string? LastErrorCode { get; private set; }

    /// <summary>服务端附带的原始说明，仅用于诊断，不直接展示给用户。</summary>
    public string? LastErrorDetail { get; private set; }

    /// <summary>最近一次成功的 <c>GET /v1/config</c> 结果；未取到时为 null。</summary>
    public ConfigResponse? Config { get; private set; }

    /// <summary>
    /// 服务端**站点根地址**（已去掉尾部斜杠）—— 用来把用户送去网页端（注册、账号页…）。
    /// </summary>
    /// <remarks>
    /// <b>不在客户端硬编码官网域名</b>：注册页就长在用户配置的那个服务端上，
    /// 所以换服务器（联调、私有部署、自建）时「去注册」按钮自动跟着走，不需要改代码。
    /// 路径 <c>/register</c> 是用户端页面（与 <c>/login</c>、<c>/account</c> 同一套 SSR 页面）。
    /// </remarks>
    public string ServiceSiteUrl => _settings.Settings.ServiceBaseUrl.TrimEnd('/');

    /// <summary>
    /// 服务端是否认识**保留别名** <c>auto</c>（`/config.featureFlags.autoAlias`）。
    /// </summary>
    /// <remarks>
    /// <b>必须探测，不能假定</b>：新客户端发 <c>auto</c> 打到**老服务端**会得到
    /// 400「未知的模型别名」。拿不到 `/config`（离线、或老服务端没有这个键）时按 <c>false</c> ——
    /// 保守，宁可少一个选项，也不发出对方不认识的模型名。
    /// </remarks>
    public bool SupportsAutoAlias =>
        Config?.FeatureFlags?.TryGetValue("autoAlias", out var flag) == true
        && flag.ValueKind == JsonValueKind.True;

    /// <summary>
    /// **本账号可用**的 AI 别名（<c>GET /v1/ai/models</c>）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 与 <see cref="ConfigResponse.AiAliases"/>（<c>/v1/config</c>，**全量目录**、匿名可读）刻意分开：
    /// 目录回答"平台有哪些模型"，这份回答"<b>你能用哪些</b>"。面板列模型、判断识图入口是否可用，
    /// 都必须用这一份 —— 拿全量目录去渲染会让免费用户看到一个点了就 403 的选项。
    /// </para>
    /// <para>
    /// 拉不到时保留上一次的结果而不是清空：网络抖一下不该让用户的模型列表凭空消失。
    /// </para>
    /// </remarks>
    public IReadOnlyList<AiModelDto> AiModels { get; private set; } = Array.Empty<AiModelDto>();

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
    /// 拉一次"本账号可用的 AI 别名"。未登录时直接返回 false（这不是错误）。
    /// </summary>
    public async Task<bool> RefreshAiModelsAsync(CancellationToken cancellationToken = default)
    {
        if (!Session.IsSignedIn)
        {
            AiModels = Array.Empty<AiModelDto>();
            return false;
        }

        var result = await _api.SendAsync<AiModelListDto>(
            HttpMethod.Get, "/v1/ai/models", authenticated: true, cancellationToken: cancellationToken);

        if (!result.Ok || result.Value == null)
        {
            // 保留旧值（见 AiModels 的 remarks）
            return false;
        }

        AiModels = result.Value.Data;
        return true;
    }

    /// <summary>
    /// 注册。**必须按状态码分派**：201 才是"账号已可用并发放令牌"，202 是"待邮箱激活、无令牌"。

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
    /// <remarks>
    /// <para>本方法同时充当文档接口 401 后的"静默刷新"回调。</para>
    /// <para>
    /// <b>串行化是必需的，不是优化</b>：服务端的 refresh 是**轮换 + 重用检测**（检测到重用即吊销整条
    /// family 会话）。原先只有文档接口一个刷新消费者，撞车概率低；云 AI（<c>CloudAIService</c>）
    /// 成为第二个消费者后，"文档 401 刷新"与"AI 401 刷新"并发就会**把用户整个会话吊销**
    /// —— 表现为突然被登出。所以这里加互斥，两条路径共用。
    /// </para>
    /// </remarks>
    public async Task<bool> TryRestoreSessionAsync(CancellationToken cancellationToken = default)
    {
        await _refreshGate.WaitAsync(cancellationToken);
        try
        {
            return await RestoreSessionCoreAsync(cancellationToken);
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private async Task<bool> RestoreSessionCoreAsync(CancellationToken cancellationToken)
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

        // 别名列表是**按账号**拉的：登出后必须清掉，否则换账号登录会短暂看到上一个账号的模型
        AiModels = Array.Empty<AiModelDto>();
    }

    private void StoreRefreshToken(string token) =>
        SecureStorageService.SaveProtectedValue(RefreshTokenKey, token, SettingsService.SecureConfigPath);

    private string? LoadRefreshToken() =>
        SecureStorageService.LoadProtectedValue(RefreshTokenKey, SettingsService.SecureConfigPath);

    private void SetError<T>(ApiResult<T> result)
    {
        LastErrorCode = result.ErrorCode ?? ApiClient.NetworkError;
        LastErrorDetail = result.ErrorDetail;
        LastErrorFields = ExtractFields(result.Details);
        LastErrorMinLength = ExtractInt(result.Details, "minLength");
        LastErrorMaxLength = ExtractInt(result.Details, "maxLength");
    }

    /// <summary>服务端错误包络里 <c>details.minLength</c>（<c>weak_password</c> 的下限）；没有则为 null。</summary>
    /// <remarks>
    /// 服务端按分支只给其中一个：密码过短给 <c>minLength</c>、过长给 <c>maxLength</c>。
    /// 表现层据此判断方向并给出**带准确数字**的文案，而不是硬编码的"至少 8 位"。
    /// </remarks>
    public int? LastErrorMinLength { get; private set; }

    /// <summary>同上，<c>details.maxLength</c>。</summary>
    public int? LastErrorMaxLength { get; private set; }

    private static int? ExtractInt(JsonElement? details, string propertyName)
    {
        if (details is not { ValueKind: JsonValueKind.Object } obj)
        {
            return null;
        }

        return obj.TryGetProperty(propertyName, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var number)
                ? number
                : null;
    }

    /// <summary>
    /// 服务端错误包络里 <c>details.fields</c> 指出的出错字段（如 <c>["email"]</c>）：没有则为空。
    /// </summary>
    /// <remarks>
    /// 服务端在 422 里已经指明是哪个字段错了，但 <c>validation_error</c> 这个码本身分不出
    /// "邮箱格式错"还是"密码太短"。表现层据此给出具体提示，而不是笼统的"输入不合法"。
    /// </remarks>
    public IReadOnlyList<string> LastErrorFields { get; private set; } = Array.Empty<string>();

    private static IReadOnlyList<string> ExtractFields(JsonElement? details)
    {
        if (details is not { ValueKind: JsonValueKind.Object } obj)
        {
            return Array.Empty<string>();
        }

        if (!obj.TryGetProperty("fields", out var fields) || fields.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<string>();
        }

        var list = new List<string>();
        foreach (var item in fields.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                list.Add(item.GetString()!);
            }
        }

        return list;
    }

    private void ClearError()
    {
        LastErrorCode = null;
        LastErrorDetail = null;
        LastErrorFields = Array.Empty<string>();
        LastErrorMinLength = null;
        LastErrorMaxLength = null;
    }
}
