using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 把线上错误码翻成本地化文案 —— 云端相关的界面（主视图、各个云对话框）共用同一份映射，
/// 免得同一个码在不同入口显示成不同的话。
/// </summary>
internal static class CloudErrorText
{
    private static readonly Strings S = Strings.Instance;

    public static string Describe(string? code) => code switch
    {
        "membership_required" => S.AuthFreePlanHint,
        "quota_exceeded" => S.AuthErrorGeneric,
        "validation_error" => S.AuthErrorValidation,
        // 保存时改名撞上同目录里的同名文档（服务端 409）—— 目录新建有自己的文案，不走这里
        "name_taken" => S.CloudDocumentNameTaken,
        "not_found" => S.FileNotFound,
        ApiClient.NetworkError => S.AuthErrorNetwork,
        _ => string.Format(S.CloudStatusErrorFormat, code ?? S.AuthErrorGeneric),
    };
}
