using System.Text.Json;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Services.AIService;

/// <summary>
/// 云端 AI 的错误码 → 本地化文案。
/// </summary>
/// <remarks>
/// <para>
/// <b>必须按 <c>error_code</c> 映射，不能直接显示服务端的 <c>message</c></b>：服务端的 message 是
/// 中文硬编码，而客户端是多语言的（实测本机 settings.json 是 en-US）—— 直接展示会串语言。
/// 只有在"没有码可映射"时才回落到服务端 message。
/// </para>
/// <para>
/// <b>与 <c>Views.CloudErrorText</c> 刻意不合并</b>：同一个码在两种上下文里该说不同的话 ——
/// 云端存储的 <c>membership_required</c> 是"免费用户暂不支持云端存储"，
/// 而 AI 的是"当前套餐不含 AI 信用点"。合并会让其中一边说错话。
/// 放在 Services 而不是 Views：服务层（<see cref="CloudAIService"/>）要用它，而服务层不依赖 Views。
/// </para>
/// </remarks>
internal static class AiErrorText
{
    private static readonly Strings S = Strings.Instance;

    public static string Describe(string? errorCode, string? serverMessage, JsonElement? details)
    {
        switch (errorCode)
        {
            case ApiClient.NetworkError:
                return S.AIErrorNetwork;

            // 只有"按请求超时"才会走到这里（区别于"连不上"）—— 生成几十秒是常态，
            // 把它说成"无法连接"会误导排查方向。
            case ApiClient.TimeoutError:
                return S.AIErrorTimeout;

            case "unauthorized":
            case "token_expired":
            case "token_revoked":
            case "device_mismatch":
                return S.AICloudSignInRequired;

            case "membership_required":
                // 同一个码两种语义：**本档不含这个模型**（带 details.alias，可升级）
                // vs 本档不含 AI 权益。分开说，用户才知道下一步该做什么。
                return HasDetail(details, "alias") ? S.AIErrorModelNotIncluded : S.AIErrorMembershipRequired;

            case "quota_exceeded":
                return S.AIErrorQuotaExceeded;

            case "rate_limited":
                return IntDetail(details, "retryAfterSeconds") is { } seconds
                    ? S.Format("AIErrorRateLimitedFormat", seconds)
                    : S.AIErrorUpstream;

            case "validation_error":
                return StringDetail(details, "reason") switch
                {
                    "vision_not_supported" => S.AIErrorVisionNotSupported,
                    // 服务端单张上限是 1 MiB（base64 后）。客户端已经压过一轮，
                    // 走到这里说明两档缩放都不够 —— 只能让用户先裁到图表主体。
                    "image_too_large" => S.AIErrorImageTooLarge,
                    _ => S.AIErrorValidation,
                };

            case "upstream_unavailable":
                return S.AIErrorUpstream;

            case "ai_unavailable":
                return S.AIErrorServiceUnavailable;

            default:
                return string.IsNullOrWhiteSpace(serverMessage) ? S.UnknownError : serverMessage;
        }
    }

    private static bool HasDetail(JsonElement? details, string name) =>
        details is { ValueKind: JsonValueKind.Object } element && element.TryGetProperty(name, out _);

    private static string? StringDetail(JsonElement? details, string name) =>
        details is { ValueKind: JsonValueKind.Object } element
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? IntDetail(JsonElement? details, string name) =>
        details is { ValueKind: JsonValueKind.Object } element
        && element.TryGetProperty(name, out var value)
        && value.TryGetInt32(out var number)
            ? number
            : null;
}
