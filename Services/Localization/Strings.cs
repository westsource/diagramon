namespace Diagramon.Services.Localization;

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
    public string ZoomReset => Get("ZoomReset");
    public string ZoomFormat => Get("ZoomFormat");
    public string ErrorFormat => Get("ErrorFormat");
    public string SyntaxErrorFormat => Get("SyntaxErrorFormat");
    public string UnknownError => Get("UnknownError");
    public string AICodeApplied => Get("AICodeApplied");
    public string CodeGenerated => Get("CodeGenerated");
    public string CodeReverted => Get("CodeReverted");
    public string ConversationCleared => Get("ConversationCleared");
    public string CannotOpenLink => Get("CannotOpenLink");
    public string NewTabTitle => Get("NewTabTitle");
    public string UntitledTab => Get("UntitledTab");

    public string MenuFile => Get("MenuFile");
    public string MenuNew => Get("MenuNew");
    public string MenuOpen => Get("MenuOpen");
    public string MenuRecentFiles => Get("MenuRecentFiles");
    public string MenuSave => Get("MenuSave");
    public string MenuSaveAs => Get("MenuSaveAs");
    public string MenuCloseTab => Get("MenuCloseTab");
    public string MenuAISettings => Get("MenuAISettings");
    public string MenuExit => Get("MenuExit");
    public string MenuEdit => Get("MenuEdit");
    public string MenuUndo => Get("MenuUndo");
    public string MenuRedo => Get("MenuRedo");
    public string MenuCut => Get("MenuCut");
    public string MenuCopy => Get("MenuCopy");
    public string MenuPaste => Get("MenuPaste");
    public string MenuSelectAll => Get("MenuSelectAll");
    public string MenuHelp => Get("MenuHelp");
    public string MenuMermaidDocs => Get("MenuMermaidDocs");
    public string MenuAbout => Get("MenuAbout");
    public string MenuSettings => Get("MenuSettings");

    public string AboutTitle => Get("AboutTitle");
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
    public string AuthSignIn => Get("AuthSignIn");
    public string AuthRegister => Get("AuthRegister");
    public string AuthSwitchToRegister => Get("AuthSwitchToRegister");
    public string AuthSwitchToSignIn => Get("AuthSwitchToSignIn");
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
    public string AuthPendingTitle => Get("AuthPendingTitle");
    public string AuthPendingBodyFormat => Get("AuthPendingBodyFormat");
    public string AuthPendingTtlFormat => Get("AuthPendingTtlFormat");
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

    public string Get(string key)
    {
        return LocalizationService.Instance.GetString(key);
    }

    public string Format(string key, params object[] args)
    {
        return LocalizationService.Instance.GetFormattedString(key, args);
    }
}
