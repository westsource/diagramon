using System.ComponentModel;

namespace Diagramon.Services.Localization;

/// <summary>
/// 本地化文案的统一访问器（<c>Strings.Instance.Foo</c> / <c>S.Foo</c>）。
/// </summary>
/// <remarks>
/// 刻意保持"纯读取器"：不实现 <see cref="INotifyPropertyChanged"/>、不提供索引器。
/// 界面文案一律走"ViewModel 暴露属性 + XAML 绑定"这**一条**约定（切语言时
/// ViewModel 用 <c>OnPropertyChanged("")</c> 整表失效，见 <c>MainViewModel.OnLanguageChanged</c>）。
/// 旁边那个只给 XAML 直取词条用的 <c>MarkupExtensions.LocalizeExtension</c> 至今没有任何调用点，
/// 也不要用它——两套取值约定并存正是"漏刷新"的来源。
/// </remarks>
public class Strings
{
    public static readonly Strings Instance = new();

    public string AppTitle => Get("AppTitle");
    public string Ready => Get("Ready");
    public string Rendering => Get("Rendering");
    public string PreviewUpdated => Get("PreviewUpdated");
    public string Saved => Get("Saved");
    public string Cancelled => Get("Cancelled");
    public string FileAlreadyOpen => Get("FileAlreadyOpen");
    public string FileNotFound => Get("FileNotFound");
    public string ImageCopied => Get("ImageCopied");
    public string ImageSaved => Get("ImageSaved");
    public string ClipboardNotSupported => Get("ClipboardNotSupported");
    public string ZoomFormat => Get("ZoomFormat");
    public string ErrorFormat => Get("ErrorFormat");
    public string SyntaxErrorFormat => Get("SyntaxErrorFormat");
    public string RenderErrorFormat => Get("RenderErrorFormat");
    public string ChromeNotFoundError => Get("ChromeNotFoundError");
    public string NodeNotFoundError => Get("NodeNotFoundError");
    public string UnknownError => Get("UnknownError");
    // ---- AI：云端 provider 与错误文案（错误码 → 文案；服务端 message 是中文硬编码，不能直接展示）----
    public string AICloudProviderName => Get("AICloudProviderName");
    public string AICloudSignInRequired => Get("AICloudSignInRequired");
    public string AIErrorMembershipRequired => Get("AIErrorMembershipRequired");
    public string AIErrorQuotaExceeded => Get("AIErrorQuotaExceeded");
    public string AIErrorRateLimitedFormat => Get("AIErrorRateLimitedFormat");
    public string AIErrorValidation => Get("AIErrorValidation");
    public string AIErrorUpstream => Get("AIErrorUpstream");
    public string AIErrorServiceUnavailable => Get("AIErrorServiceUnavailable");
    public string AIErrorModelNotIncluded => Get("AIErrorModelNotIncluded");
    public string AIErrorVisionNotSupported => Get("AIErrorVisionNotSupported");
    public string AIErrorImageTooLarge => Get("AIErrorImageTooLarge");
    public string AIPickImage => Get("AIPickImage");
    public string AIAutoModel => Get("AIAutoModel");
    public string AIUsedTierFormat => Get("AIUsedTierFormat");
    public string AIPickImageTooltip => Get("AIPickImageTooltip");
    public string AIClearImageTooltip => Get("AIClearImageTooltip");
    public string AIImageAttached => Get("AIImageAttached");
    public string AIImageAttachedFormat => Get("AIImageAttachedFormat");
    public string AIImageDefaultPrompt => Get("AIImageDefaultPrompt");
    public string AIApplyAsDrawio => Get("AIApplyAsDrawio");
    public string AIApplyAsDrawioTooltip => Get("AIApplyAsDrawioTooltip");
    public string AIVisionNeedsCloud => Get("AIVisionNeedsCloud");
    public string AIImageReadFailedFormat => Get("AIImageReadFailedFormat");
    public string AiVisionNoticeTitle => Get("AiVisionNoticeTitle");
    public string AiVisionNoticeBody => Get("AiVisionNoticeBody");
    public string AiVisionNoticeDoNotAsk => Get("AiVisionNoticeDoNotAsk");
    public string AiVisionNoticeContinue => Get("AiVisionNoticeContinue");
    public string AIRenderRetryStatus => Get("AIRenderRetryStatus");
    public string AIRenderRetryPrompt => Get("AIRenderRetryPrompt");
    public string AIRenderFeedbackToggle => Get("AIRenderFeedbackToggle");
    public string AIServiceUrlLabel => Get("AIServiceUrlLabel");
    public string AIServiceUrlHint => Get("AIServiceUrlHint");
    public string AITestConnection => Get("AITestConnection");
    public string AITestOk => Get("AITestOk");
    public string AITestFailFormat => Get("AITestFailFormat");
    public string AITestInvalidUrl => Get("AITestInvalidUrl");
    public string AIRenderFeedbackHint => Get("AIRenderFeedbackHint");
    public string AIErrorTimeout => Get("AIErrorTimeout");
    public string AIErrorNetwork => Get("AIErrorNetwork");
    public string AIErrorOutputTruncated => Get("AIErrorOutputTruncated");
    public string AIAliasLabel => Get("AIAliasLabel");
    public string AICloudHint => Get("AICloudHint");

    public string AICodeApplied => Get("AICodeApplied");
    public string AICodeFormatMismatch => Get("AICodeFormatMismatch");
    public string CodeGenerated => Get("CodeGenerated");
    public string CodeReverted => Get("CodeReverted");
    public string ConversationCleared => Get("ConversationCleared");
    public string CannotOpenLink => Get("CannotOpenLink");
    // ---- 格式与文件对话框 ----
    public string FormatMermaid => Get("FormatMermaid");
    public string FormatDot => Get("FormatDot");
    public string FormatDrawio => Get("FormatDrawio");
    public string UntitledDrawioFileName => Get("UntitledDrawioFileName");
    public string DrawioRendererMissing => Get("DrawioRendererMissing");
    public string MenuConvertToDrawio => Get("MenuConvertToDrawio");
    public string ConvertToGraphDone => Get("ConvertToGraphDone");
    public string FormatExcalidraw => Get("FormatExcalidraw");
    public string UntitledExcalidrawFileName => Get("UntitledExcalidrawFileName");
    public string ExcalidrawRuntimeMissing => Get("ExcalidrawRuntimeMissing");
    public string MenuConvertToExcalidraw => Get("MenuConvertToExcalidraw");
    public string UntitledMermaidFileName => Get("UntitledMermaidFileName");
    public string UntitledDotFileName => Get("UntitledDotFileName");
    public string FileTypeFormatLabel => Get("FileTypeFormatLabel");
    public string FileTypeAllSupported => Get("FileTypeAllSupported");
    public string FileTypeAllFiles => Get("FileTypeAllFiles");
    public string OpenFileDialogTitle => Get("OpenFileDialogTitle");
    public string SaveFileDialogTitle => Get("SaveFileDialogTitle");
    public string LayoutLabel => Get("LayoutLabel");
    public string DotRendererMissing => Get("DotRendererMissing");

    public string MenuFile => Get("MenuFile");
    public string MenuNew => Get("MenuNew");
    public string MenuOpen => Get("MenuOpen");
    public string MenuRecentFiles => Get("MenuRecentFiles");
    public string MenuSave => Get("MenuSave");
    public string MenuSaveAs => Get("MenuSaveAs");
    public string MenuCloseTab => Get("MenuCloseTab");
    public string MenuAISettings => Get("MenuAISettings");
    public string MenuImageScaleSettings => Get("MenuImageScaleSettings");
    public string MenuExit => Get("MenuExit");
    public string MenuEdit => Get("MenuEdit");
    public string MenuUndo => Get("MenuUndo");
    public string MenuRedo => Get("MenuRedo");
    public string MenuCut => Get("MenuCut");
    public string MenuCopy => Get("MenuCopy");
    public string MenuPaste => Get("MenuPaste");
    public string MenuSelectAll => Get("MenuSelectAll");
    public string MenuView => Get("MenuView");
    public string MenuViewFit => Get("MenuViewFit");
    public string MenuViewZoomIn => Get("MenuViewZoomIn");
    public string MenuViewZoomOut => Get("MenuViewZoomOut");
    public string MenuHelp => Get("MenuHelp");
    public string MenuMermaidDocs => Get("MenuMermaidDocs");
    public string MenuDotDocs => Get("MenuDotDocs");
    public string MenuHelpDocs => Get("MenuHelpDocs");
    public string HelpTitle => Get("HelpTitle");
    public string HelpClose => Get("HelpClose");
    public string HelpUnavailable => Get("HelpUnavailable");
    public string MenuAbout => Get("MenuAbout");
    public string MenuSettings => Get("MenuSettings");

    public string AboutTitle => Get("AboutTitle");
    public string AboutDescription => Get("AboutDescription");
    public string AboutFeatures => Get("AboutFeatures");
    public string AboutAuthor => Get("AboutAuthor");
    public string AboutVersion => Get("AboutVersion");
    public string AboutOK => Get("AboutOK");

    public string SaveChangesTitle => Get("SaveChangesTitle");
    public string SaveChangesMessage => Get("SaveChangesMessage");
    public string SaveButton => Get("SaveButton");
    public string DontSaveButton => Get("DontSaveButton");
    public string CancelButton => Get("CancelButton");

    public string SavePreviewImage => Get("SavePreviewImage");
    public string CopyPreviewImage => Get("CopyPreviewImage");
    public string NewTabTooltip => Get("NewTabTooltip");

    public string AIAssistant => Get("AIAssistant");
    public string AIReady => Get("AIReady");
    public string AIConfigRequired => Get("AIConfigRequired");
    public string AIConfigApiKey => Get("AIConfigApiKey");
    public string AIConfigAzureApiKey => Get("AIConfigAzureApiKey");
    public string AIConfigOllama => Get("AIConfigOllama");
    public string AIConfigBaseUrl => Get("AIConfigBaseUrl");

    /// <summary>OpenAI 档 Base URL 的占位提示（说明留空 = 官方端点）。</summary>
    public string AIBaseUrlOfficialHint => Get("AIBaseUrlOfficialHint");
    public string AIConfigComplete => Get("AIConfigComplete");
    public string AIReadyFormat => Get("AIReadyFormat");
    public string AIGenerating => Get("AIGenerating");
    public string AIGenerated => Get("AIGenerated");
    public string AIErrorFormat => Get("AIErrorFormat");
    public string AIResponded => Get("AIResponded");
    public string AIGenerationError => Get("AIGenerationError");
    public string AIInputPlaceholder => Get("AIInputPlaceholder");
    public string AISend => Get("AISend");
    public string AISettingsTooltip => Get("AISettingsTooltip");
    public string AIClearHistoryTooltip => Get("AIClearHistoryTooltip");
    public string AISelectModelTooltip => Get("AISelectModelTooltip");
    public string AICodeGenerated => Get("AICodeGenerated");
    public string AIApply => Get("AIApply");
    public string AIRevert => Get("AIRevert");

    public string AISettingsTitle => Get("AISettingsTitle");
    public string AIModelConfig => Get("AIModelConfig");
    public string AIConfiguredModels => Get("AIConfiguredModels");
    public string AIAddModel => Get("AIAddModel");
    public string AIEditModel => Get("AIEditModel");
    public string AIDeleteModel => Get("AIDeleteModel");
    public string AIModelName => Get("AIModelName");
    public string AIServiceType => Get("AIServiceType");
    public string AIModelId => Get("AIModelId");
    public string AIAdvancedOptions => Get("AIAdvancedOptions");
    public string AIConversationStorage => Get("AIConversationStorage");
    public string AIBrowse => Get("AIBrowse");
    public string AIClose => Get("AIClose");
    public string AIEditPanelTitle => Get("AIEditPanelTitle");
    public string AIEndpoint => Get("AIEndpoint");
    public string AIDeploymentName => Get("AIDeploymentName");

    public string ImageScaleTitle => Get("ImageScaleTitle");
    public string ImageScaleDescription => Get("ImageScaleDescription");
    public string ImageScaleAutoMode => Get("ImageScaleAutoMode");
    public string ImageScaleFixedMode => Get("ImageScaleFixedMode");
    public string OKButton => Get("OKButton");

    public string LanguageMenu => Get("LanguageMenu");

    public string MenuCheckUpdate => Get("MenuCheckUpdate");
    public string CheckUpdate => Get("CheckUpdate");
    public string CheckingUpdate => Get("CheckingUpdate");
    public string UpdateAvailable => Get("UpdateAvailable");
    public string UpdateNotAvailable => Get("UpdateNotAvailable");
    public string CheckUpdateFailed => Get("CheckUpdateFailed");
    public string CurrentVersion => Get("CurrentVersion");
    public string LatestVersion => Get("LatestVersion");
    public string ReleaseNotes => Get("ReleaseNotes");
    public string DownloadUpdate => Get("DownloadUpdate");
    public string DownloadInBrowser => Get("DownloadInBrowser");
    public string DownloadingUpdate => Get("DownloadingUpdate");
    public string DownloadComplete => Get("DownloadComplete");
    public string DownloadCompleteMessage => Get("DownloadCompleteMessage");
    public string SkipVersion => Get("SkipVersion");
    public string RemindLater => Get("RemindLater");

    // ---- 云端账户 ----
    public string MenuAccount => Get("MenuAccount");
    public string MenuSignIn => Get("MenuSignIn");
    public string MenuSignOut => Get("MenuSignOut");
    public string AuthTitle => Get("AuthTitle");
    public string AuthEmail => Get("AuthEmail");
    public string AuthPassword => Get("AuthPassword");
    public string AuthErrorPasswordTooShortFormat => Get("AuthErrorPasswordTooShortFormat");
    public string AuthErrorPasswordTooLongFormat => Get("AuthErrorPasswordTooLongFormat");
    public string AuthErrorEmailFormat => Get("AuthErrorEmailFormat");
    public string AuthSignIn => Get("AuthSignIn");
    public string AuthRegisterOnWeb => Get("AuthRegisterOnWeb");
    public string AuthRegisterOpenFailedFormat => Get("AuthRegisterOpenFailedFormat");
    public string AuthClose => Get("AuthClose");
    public string AuthWorking => Get("AuthWorking");
    public string AuthSignedInFormat => Get("AuthSignedInFormat");
    public string AuthFreePlanHint => Get("AuthFreePlanHint");
    public string AuthErrorInvalidCredentials => Get("AuthErrorInvalidCredentials");
    public string AuthErrorEmailTaken => Get("AuthErrorEmailTaken");
    public string AuthErrorWeakPassword => Get("AuthErrorWeakPassword");
    public string AuthErrorRateLimited => Get("AuthErrorRateLimited");
    public string AuthErrorValidation => Get("AuthErrorValidation");
    public string AuthErrorNetwork => Get("AuthErrorNetwork");
    public string AuthErrorGeneric => Get("AuthErrorGeneric");
    public string AuthErrorEmailNotVerified => Get("AuthErrorEmailNotVerified");
    public string AuthResend => Get("AuthResend");
    public string AuthResent => Get("AuthResent");

    // ---- 云端文件 ----
    public string CloudDocuments => Get("CloudDocuments");
    public string CloudTitle => Get("CloudTitle");
    public string CloudSaveToCloud => Get("CloudSaveToCloud");
    public string CloudEmpty => Get("CloudEmpty");
    public string CloudDelete => Get("CloudDelete");
    public string CloudRefresh => Get("CloudRefresh");
    public string CloudConfirmDeleteTitle => Get("CloudConfirmDeleteTitle");
    public string CloudConfirmDeleteFormat => Get("CloudConfirmDeleteFormat");
    public string CloudStatusSavedFormat => Get("CloudStatusSavedFormat");
    public string CloudStatusErrorFormat => Get("CloudStatusErrorFormat");
    public string CloudOpen => Get("CloudOpen");
    public string CloudStatusItemsFormat => Get("CloudStatusItemsFormat");
    public string CloudColumnName => Get("CloudColumnName");
    public string CloudColumnType => Get("CloudColumnType");
    public string CloudColumnSize => Get("CloudColumnSize");
    public string CloudColumnModified => Get("CloudColumnModified");
    public string CloudTypeFolder => Get("CloudTypeFolder");

    // ---- 云端多级路径 ----
    public string CloudPathSaveTitle => Get("CloudPathSaveTitle");
    public string CloudPathSaveLabel => Get("CloudPathSaveLabel");
    public string CloudPathRoot => Get("CloudPathRoot");
    public string CloudPathCurrentFormat => Get("CloudPathCurrentFormat");
    public string CloudPathNoContent => Get("CloudPathNoContent");
    public string CloudPathDocumentHint => Get("CloudPathDocumentHint");
    public string CloudPathNewFolderPlaceholder => Get("CloudPathNewFolderPlaceholder");
    public string CloudPathCreate => Get("CloudPathCreate");
    public string CloudPathConfirm => Get("CloudPathConfirm");
    public string CloudDocumentNameLabel => Get("CloudDocumentNameLabel");
    public string CloudDocumentNameRequired => Get("CloudDocumentNameRequired");
    public string CloudDocumentNameTooLongFormat => Get("CloudDocumentNameTooLongFormat");
    public string CloudDocumentNameInvalid => Get("CloudDocumentNameInvalid");
    public string CloudDocumentNameTaken => Get("CloudDocumentNameTaken");
    public string CloudFolderTreeTitle => Get("CloudFolderTreeTitle");
    public string CloudFolderEmpty => Get("CloudFolderEmpty");
    public string CloudFolderDocsFormat => Get("CloudFolderDocsFormat");
    public string CloudFolderSubdirs => Get("CloudFolderSubdirs");
    public string CloudFolderNameRequired => Get("CloudFolderNameRequired");
    public string CloudFolderNameInvalid => Get("CloudFolderNameInvalid");
    public string CloudFolderNameRejected => Get("CloudFolderNameRejected");
    public string CloudFolderNameBackslash => Get("CloudFolderNameBackslash");
    public string CloudFolderNameControlChar => Get("CloudFolderNameControlChar");
    public string CloudFolderNameDotSegment => Get("CloudFolderNameDotSegment");
    public string CloudFolderNameEmptySegment => Get("CloudFolderNameEmptySegment");
    public string CloudFolderNameSegmentTooLongFormat => Get("CloudFolderNameSegmentTooLongFormat");
    public string CloudFolderNamePathTooLongFormat => Get("CloudFolderNamePathTooLongFormat");
    public string CloudFolderExists => Get("CloudFolderExists");
    public string CloudFolderCreatedFormat => Get("CloudFolderCreatedFormat");

    // ---- 最近历史 ----
    public string MenuRecentFilesMore => Get("MenuRecentFilesMore");
    public string RecentHistoryTitle => Get("RecentHistoryTitle");
    public string RecentHistoryFileName => Get("RecentHistoryFileName");
    public string RecentHistoryOpenTime => Get("RecentHistoryOpenTime");
    public string RecentHistoryNoItems => Get("RecentHistoryNoItems");
    public string RecentHistorySearchPlaceholder => Get("RecentHistorySearchPlaceholder");
    public string RecentHistorySearchNoResults => Get("RecentHistorySearchNoResults");

    // ---- 承载面 / 预览 / 宿主通道 ----
    public string EmbeddedCanvasNotReadyFormat => Get("EmbeddedCanvasNotReadyFormat");
    public string EmbeddedExportTimeoutFormat => Get("EmbeddedExportTimeoutFormat");
    public string EmbeddedFlushTimeoutFormat => Get("EmbeddedFlushTimeoutFormat");
    public string EmbeddedHostEntryMissingFormat => Get("EmbeddedHostEntryMissingFormat");
    public string OfflineRequestBlockedFormat => Get("OfflineRequestBlockedFormat");
    public string DrawioHostErrorFallback => Get("DrawioHostErrorFallback");
    public string DrawioExportMissingData => Get("DrawioExportMissingData");
    public string ExcalidrawHostErrorFallback => Get("ExcalidrawHostErrorFallback");
    public string ExcalidrawExportMissingData => Get("ExcalidrawExportMissingData");
    public string WebViewInitFailed => Get("WebViewInitFailed");
    public string WebViewPreviewFailedFormat => Get("WebViewPreviewFailedFormat");
    public string WebViewNavigationUnsupported => Get("WebViewNavigationUnsupported");
    public string CanvasHostNotCreated => Get("CanvasHostNotCreated");
    public string PreviewWebViewNotReady => Get("PreviewWebViewNotReady");
    public string PreviewSurfaceFormatMismatch => Get("PreviewSurfaceFormatMismatch");
    public string PreviewSurfaceNotReady => Get("PreviewSurfaceNotReady");
    public string InPageExportTimeout => Get("InPageExportTimeout");
    public string InPageExportFailed => Get("InPageExportFailed");
    public string ExportMissingPngData => Get("ExportMissingPngData");

    // ---- AI 设置：字段标签与存储路径占位 ----
    public string AIApiKeyLabel => Get("AIApiKeyLabel");
    public string AIBaseUrlLabel => Get("AIBaseUrlLabel");
    public string AIMaxTokensLabel => Get("AIMaxTokensLabel");
    public string AITemperatureLabel => Get("AITemperatureLabel");
    public string AIConversationStorageWatermarkFormat => Get("AIConversationStorageWatermarkFormat");

    public string Get(string key)
    {
        return LocalizationService.Instance.GetString(key);
    }

    public string Format(string key, params object[] args)
    {
        return LocalizationService.Instance.GetFormattedString(key, args);
    }
}
