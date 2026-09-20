using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using Avalonia;
using Avalonia.Platform;

namespace Diagramon.Services.Localization;

public class LanguageInfo
{
    public string Code { get; init; } = string.Empty;
    public string NativeName { get; init; } = string.Empty;
    public string EnglishName { get; init; } = string.Empty;
}

public sealed class LocalizationService
{
    public static LocalizationService Instance { get; private set; } = new();

    private string _currentLanguageCode = "en-US";
    private Dictionary<string, string> _strings = new();
    private readonly Dictionary<string, string> _fallbackStrings = new();
    private Dictionary<string, LanguageInfo> _availableLanguages = new();

    public event EventHandler? LanguageChanged;

    public string CurrentLanguageCode
    {
        get => _currentLanguageCode;
        set
        {
            if (_currentLanguageCode != value && _availableLanguages.ContainsKey(value))
            {
                _currentLanguageCode = value;
                LoadStrings();
                LanguageChanged?.Invoke(this, EventArgs.Empty);
            }
        }
    }

    public LanguageInfo CurrentLanguage => _availableLanguages.GetValueOrDefault(_currentLanguageCode) ?? new LanguageInfo { Code = "en-US", NativeName = "English", EnglishName = "English" };

    public IReadOnlyDictionary<string, LanguageInfo> AvailableLanguages => _availableLanguages;

    private LocalizationService()
    {
        LoadFallbackStrings();
        DiscoverAvailableLanguages();
    }

    public static void Initialize(string? savedLanguageCode)
    {
        Instance.DiscoverAvailableLanguages();
        
        if (!string.IsNullOrWhiteSpace(savedLanguageCode) && Instance._availableLanguages.ContainsKey(savedLanguageCode))
        {
            Instance._currentLanguageCode = savedLanguageCode;
        }
        else
        {
            Instance._currentLanguageCode = DetectSystemLanguage();
        }
        
        Instance.LoadStrings();
    }

    private static string DetectSystemLanguage()
    {
        var cultureName = System.Globalization.CultureInfo.CurrentUICulture.Name;
        
        foreach (var lang in Instance._availableLanguages.Keys)
        {
            if (cultureName.StartsWith(lang.Substring(0, 2), StringComparison.OrdinalIgnoreCase))
            {
                return lang;
            }
        }
        
        return "en-US";
    }

    public string GetString(string key)
    {
        if (_strings.TryGetValue(key, out var value))
            return value;
        
        if (_fallbackStrings.TryGetValue(key, out var fallback))
            return fallback;
        
        return key;
    }

    public string GetFormattedString(string key, params object[] args)
    {
        var template = GetString(key);
        try
        {
            return string.Format(template, args);
        }
        catch
        {
            return template;
        }
    }

    private void DiscoverAvailableLanguages()
    {
        _availableLanguages.Clear();

        try
        {
            var assets = AssetLoader.GetAssets(new Uri("avares://Diagramon/Assets/Languages/"), null);
            
            foreach (var asset in assets)
            {
                var fileName = Path.GetFileName(asset.LocalPath);
                if (fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                {
                    var code = fileName.Substring(0, fileName.Length - 5);
                    
                    try
                    {
                        using var stream = AssetLoader.Open(asset);
                        using var reader = new StreamReader(stream);
                        var json = reader.ReadToEnd();
                        var data = JsonSerializer.Deserialize<LanguageFile>(json, new JsonSerializerOptions
                        {
                            PropertyNameCaseInsensitive = true
                        });
                        
                        if (data != null)
                        {
                            _availableLanguages[code] = new LanguageInfo
                            {
                                Code = code,
                                NativeName = data._Language ?? code,
                                EnglishName = data._LanguageEnglish ?? code
                            };
                        }
                    }
                    catch
                    {
                        _availableLanguages[code] = new LanguageInfo
                        {
                            Code = code,
                            NativeName = code,
                            EnglishName = code
                        };
                    }
                }
            }
        }
        catch
        {
            _availableLanguages["en-US"] = new LanguageInfo { Code = "en-US", NativeName = "English", EnglishName = "English" };
        }

        if (_availableLanguages.Count == 0)
        {
            _availableLanguages["en-US"] = new LanguageInfo { Code = "en-US", NativeName = "English", EnglishName = "English" };
        }
    }

    private void LoadStrings()
    {
        _strings.Clear();
        
        try
        {
            var uri = new Uri($"avares://Diagramon/Assets/Languages/{_currentLanguageCode}.json");
            using var stream = AssetLoader.Open(uri);
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();
            
            var data = JsonSerializer.Deserialize<Dictionary<string, string>>(json);
            if (data != null)
            {
                foreach (var kvp in data)
                {
                    if (!kvp.Key.StartsWith("_"))
                    {
                        _strings[kvp.Key] = kvp.Value;
                    }
                }
            }
        }
        catch
        {
        }
    }

    private void LoadFallbackStrings()
    {
        _fallbackStrings["AppTitle"] = "Diagramon - Multi-format Diagram Editor";
        _fallbackStrings["Ready"] = "Ready";
        _fallbackStrings["Rendering"] = "Rendering preview...";
        _fallbackStrings["PreviewUpdated"] = "Preview updated";
        _fallbackStrings["Saved"] = "Saved";
        _fallbackStrings["Cancelled"] = "Cancelled";
        _fallbackStrings["FileAlreadyOpen"] = "File already open, switched to the tab";
        _fallbackStrings["FileNotFound"] = "File not found or has been deleted";
        _fallbackStrings["ImageCopied"] = "Image copied to clipboard";
        _fallbackStrings["ImageSaved"] = "Image saved";
        _fallbackStrings["ClipboardNotSupported"] = "Clipboard not supported in current environment";
        _fallbackStrings["ZoomReset"] = "Zoom reset";
        _fallbackStrings["ZoomFormat"] = "Zoom: {0}%";
        _fallbackStrings["ErrorFormat"] = "Error: {0}";
        _fallbackStrings["SyntaxErrorFormat"] = "Syntax error: {0}";
        _fallbackStrings["UnknownError"] = "Unknown error";
        _fallbackStrings["AICodeApplied"] = "AI generated code applied";
        _fallbackStrings["CodeGenerated"] = "Code generated";
        _fallbackStrings["CodeReverted"] = "Code reverted";
        _fallbackStrings["ConversationCleared"] = "Conversation history cleared";
        _fallbackStrings["CannotOpenLink"] = "Cannot open link";
        _fallbackStrings["NewTabTitle"] = "Untitled.mmd";
        _fallbackStrings["UntitledTab"] = "Untitled.mmd";
        _fallbackStrings["MenuFile"] = "_File";
        _fallbackStrings["MenuNew"] = "_New";
        _fallbackStrings["MenuOpen"] = "_Open...";
        _fallbackStrings["MenuRecentFiles"] = "Recent _Files";
        _fallbackStrings["MenuSave"] = "_Save";
        _fallbackStrings["MenuSaveAs"] = "Save _As...";
        _fallbackStrings["MenuCloseTab"] = "Close Current _Tab";
        _fallbackStrings["MenuAISettings"] = "AI _Settings...";
        _fallbackStrings["MenuImageScaleSettings"] = "Image Scale _Settings...";
        _fallbackStrings["MenuExit"] = "E_xit";
        _fallbackStrings["MenuEdit"] = "_Edit";
        _fallbackStrings["MenuUndo"] = "_Undo";
        _fallbackStrings["MenuRedo"] = "_Redo";
        _fallbackStrings["MenuCut"] = "Cu_t";
        _fallbackStrings["MenuCopy"] = "_Copy";
        _fallbackStrings["MenuPaste"] = "_Paste";
        _fallbackStrings["MenuSelectAll"] = "Select _All";
        _fallbackStrings["MenuHelp"] = "_Help";
_fallbackStrings["MenuMermaidDocs"] = "_Mermaid Documentation...";
        _fallbackStrings["MenuAbout"] = "_About...";
        _fallbackStrings["MenuSettings"] = "_Settings...";
        _fallbackStrings["LanguageMenu"] = "Language";

        _fallbackStrings["MenuAccount"] = "_Account";
        _fallbackStrings["MenuSignIn"] = "_Sign in / Register...";
        _fallbackStrings["MenuSignOut"] = "Sign _out";
        _fallbackStrings["AuthTitle"] = "Sign in / Register";
        _fallbackStrings["AuthEmail"] = "Email";
        _fallbackStrings["AuthPassword"] = "Password";
        _fallbackStrings["AuthSignIn"] = "Sign in";
        _fallbackStrings["AuthRegister"] = "Register";
        _fallbackStrings["AuthSwitchToRegister"] = "No account? Register";
        _fallbackStrings["AuthSwitchToSignIn"] = "Have an account? Sign in";
        _fallbackStrings["AuthClose"] = "Close";
        _fallbackStrings["AuthWorking"] = "Working...";
        _fallbackStrings["AuthSignedInFormat"] = "Signed in as {0}";
        _fallbackStrings["AuthFreePlanHint"] = "Cloud storage requires a membership";
        _fallbackStrings["AuthErrorInvalidCredentials"] = "Incorrect email or password";
        _fallbackStrings["AuthErrorEmailTaken"] = "That email is already registered";
        _fallbackStrings["AuthErrorWeakPassword"] = "Password is too weak";
        _fallbackStrings["AuthErrorRateLimited"] = "Too many attempts, please try again later";
        _fallbackStrings["AuthErrorValidation"] = "Invalid input";
        _fallbackStrings["AuthErrorNetwork"] = "Cannot reach the cloud service";
        _fallbackStrings["AuthErrorGeneric"] = "Operation failed, please try again";
        _fallbackStrings["AuthErrorEmailNotVerified"] = "Account not activated yet - please check your inbox";
        _fallbackStrings["AuthPendingTitle"] = "Verify your email";
        _fallbackStrings["AuthPendingBodyFormat"] =
            "We sent an activation link to {0}. Unverified accounts cannot sign in; the desktop app is unaffected and works fully without signing in.";
        _fallbackStrings["AuthPendingTtlFormat"] = "The link is valid for {0} minutes.";
        _fallbackStrings["AuthResend"] = "Resend activation email";
        _fallbackStrings["AuthResent"] = "Sent. Any earlier link is now invalid - use the newest email.";

        _fallbackStrings["CloudDocuments"] = "_Cloud documents...";
        _fallbackStrings["CloudTitle"] = "Cloud documents";
        _fallbackStrings["CloudSaveToCloud"] = "Save to _cloud";
        _fallbackStrings["CloudEmpty"] = "No cloud documents yet";
        _fallbackStrings["CloudDelete"] = "Delete";
        _fallbackStrings["CloudRefresh"] = "Refresh";
        _fallbackStrings["CloudConfirmDeleteTitle"] = "Delete cloud document";
        _fallbackStrings["CloudConfirmDeleteFormat"] = "Delete \"{0}\"? This removes the cloud copy.";
        _fallbackStrings["CloudStatusSavedFormat"] = "Saved to cloud (version {0})";
        _fallbackStrings["CloudStatusErrorFormat"] = "Cloud operation failed: {0}";

        _fallbackStrings["ImageScaleTitle"] = "Image Scale Settings";
        _fallbackStrings["ImageScaleDescription"] = "Set the image scale used when saving PNG or copying to clipboard.";
        _fallbackStrings["ImageScaleAutoMode"] = "Auto (recommended): 1.5x-5.0x by diagram complexity";
        _fallbackStrings["ImageScaleFixedMode"] = "Fixed scale";
        _fallbackStrings["OKButton"] = "OK";
    }

    private class LanguageFile
    {
        public string? _Language { get; set; }
        public string? _LanguageEnglish { get; set; }
    }
}
