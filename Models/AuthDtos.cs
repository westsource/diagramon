using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Diagramon.Models;

/// <summary>
/// 云端服务的线上 DTO。字段名与《Diagramon 服务端方案》§5 的 JSON 契约逐字对应。
/// </summary>
/// <remarks>
/// <para>
/// 约定：**除错误包络外一律 camelCase**。序列化统一走 <see cref="AuthJson.Options"/>。
/// </para>
/// <para>
/// <b>错误包络是例外</b>：服务端 <c>app/core/errors.py</c> 的 <c>envelope()</c> 输出的是
/// snake_case 键（<c>error_code</c> / <c>trace_id</c>），不能用 camelCase 策略推断，
/// 故 <see cref="ApiErrorEnvelope"/> 上的键名逐个显式标注。
/// </para>
/// </remarks>
public static class AuthJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

// ---------------------------------------------------------------- 通用

public sealed class DeviceDto
{
    public string DeviceId { get; set; } = string.Empty;
    public string? Name { get; set; }
    public string? Os { get; set; }
    public string? AppVersion { get; set; }
}

// ---------------------------------------------------------------- 认证

public sealed class RegisterRequest
{
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string Password { get; set; } = string.Empty;
    public DeviceDto Device { get; set; } = new();
    public string? DisplayName { get; set; }
}

public sealed class LoginRequest
{
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string Password { get; set; } = string.Empty;
    public DeviceDto Device { get; set; } = new();
}

/// <remarks>注意 refresh 用的是扁平的 <c>deviceId</c>，不是 <c>device</c> 对象。</remarks>
public sealed class RefreshRequest
{
    public string RefreshToken { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
}

public sealed class LogoutRequest
{
    public string RefreshToken { get; set; } = string.Empty;
}

public sealed class UserDto
{
    public string Id { get; set; } = string.Empty;
    public string? Email { get; set; }
    public string? Phone { get; set; }
    public string? DisplayName { get; set; }
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;

    /// <summary>邮箱激活时间；null 表示从未激活。服务端 <c>status</c> 为 <c>pending</c> 时必为 null。</summary>
    public string? EmailVerifiedAt { get; set; }

    public string? CreatedAt { get; set; }
}

public sealed class TokensDto
{
    public string AccessToken { get; set; } = string.Empty;
    public int ExpiresIn { get; set; }
    public string RefreshToken { get; set; } = string.Empty;
    public string? RefreshExpiresAt { get; set; }
}

public sealed class MembershipDto
{
    public string PlanId { get; set; } = string.Empty;
    public string PlanName { get; set; } = string.Empty;
    public bool IsMember { get; set; }
    public bool CloudStorage { get; set; }
    public string? ExpiresAt { get; set; }
    public long QuotaBytes { get; set; }
    public long UsedBytes { get; set; }
}

/// <summary>register / login / refresh 的统一包络。</summary>
public sealed class AuthResponse
{
    public UserDto User { get; set; } = new();
    public TokensDto Tokens { get; set; } = new();
    public MembershipDto Membership { get; set; } = new();
    public string? ServerTime { get; set; }
}

/// <summary>注册后需要邮箱激活时的响应（HTTP 202）。</summary>
/// <remarks>
/// 与 <c>active</c> 路径（HTTP 201 + <see cref="AuthResponse"/>）靠**状态码**区分：
/// 202 的响应体**不含 <c>tokens</c>**。调用方若忽略状态码、按 <see cref="AuthResponse"/> 反序列化，
/// 会得到一份字段默认值（空串令牌）并被误当成登录成功 —— 这是必须按状态码分派的原因。
/// </remarks>
public sealed class RegisterPendingResponse
{
    public string Status { get; set; } = string.Empty;
    public string? EmailMasked { get; set; }
    public int? VerifyTtlSeconds { get; set; }
    public string? ServerTime { get; set; }
}

/// <summary>重发激活邮件。服务端**恒返回 204**，不泄露账号是否存在。</summary>
public sealed class ResendVerificationRequest
{
    public string? Email { get; set; }
    public string? Phone { get; set; }
}

// ---------------------------------------------------------------- 配置

public sealed class AiAliasDto
{
    public string Id { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
}

public sealed class AnnouncementDto
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Body { get; set; } = string.Empty;
    public string Level { get; set; } = string.Empty;
}

public sealed class ConfigResponse
{
    public AnnouncementDto? Announcement { get; set; }

    /// <summary>服务端类型是 <c>dict[str, object]</c>，故按 JsonElement 收，取值时再判类型。</summary>
    public Dictionary<string, JsonElement>? FeatureFlags { get; set; }

    public string MinVersion { get; set; } = string.Empty;

    /// <summary>
    /// 密码最小长度（服务端权威值）。用于注册/改密码前的**前置校验**——
    /// 客户端不硬编码，否则必然与服务端漂移。取不到时按 <see cref="FallbackMinPasswordLength"/> 保守处理。
    /// </summary>
    public int MinPasswordLength { get; set; }

    /// <summary>拿不到 <c>/config</c> 时的兜底（离线冷启动）。服务端仍是最终裁决者。</summary>
    public const int FallbackMinPasswordLength = 8;

    public List<AiAliasDto>? AiAliases { get; set; }
    public bool TelemetryEnabled { get; set; }
    public string? ServerTime { get; set; }

    /// <summary>契约：云端入口可见性 = 登录态 AND 本标志。缺字段按 false 处理。</summary>
    public bool CloudEnabled =>
        FeatureFlags != null
        && FeatureFlags.TryGetValue("cloudEnabled", out var value)
        && value.ValueKind == JsonValueKind.True;
}

// ---------------------------------------------------------------- 错误

/// <summary>所有非 2xx 响应的统一包络（服务端 <c>app/core/errors.py</c>）。</summary>
public sealed class ApiErrorEnvelope
{
    [JsonPropertyName("error_code")]
    public string? ErrorCode { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("details")]
    public JsonElement? Details { get; set; }

    [JsonPropertyName("trace_id")]
    public string? TraceId { get; set; }
}
