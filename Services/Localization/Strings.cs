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
    public string RenderErrorFormat => Get("RenderErrorFormat");
    public string ChromeNotFoundError => Get("ChromeNotFoundError");
    public string NodeNotFoundError => Get("NodeNotFoundError");
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
    public string MenuImageScaleSettings => Get("MenuImageScaleSettings");
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

    public string MenuRecentFilesMore => Get("MenuRecentFilesMore");
    public string RecentHistoryTitle => Get("RecentHistoryTitle");
    public string RecentHistoryFileName => Get("RecentHistoryFileName");
    public string RecentHistoryOpenTime => Get("RecentHistoryOpenTime");
	public string RecentHistoryNoItems => Get("RecentHistoryNoItems");
	public string RecentHistorySearchPlaceholder => Get("RecentHistorySearchPlaceholder");
	public string RecentHistorySearchNoResults => Get("RecentHistorySearchNoResults");

    public string Get(string key)
    {
        return LocalizationService.Instance.GetString(key);
    }

    public string Format(string key, params object[] args)
    {
        return LocalizationService.Instance.GetFormattedString(key, args);
    }
}
