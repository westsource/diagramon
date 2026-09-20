using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Models;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 云端文件管理：左侧目录树 + 右侧当前目录的内容（打开、删除、刷新）。
/// </summary>
/// <remarks>
/// 左树来自 <c>GET /v1/folders</c>（显式 folders 行 ∪ 文档路径隐含的目录），所以<b>空目录</b>也看得见；
/// 右栏只列当前目录的<b>直属</b>内容（子目录在前、文档在后），文档的 <c>content</c> 在"打开"时按 id 单取
/// —— 契约规定列表不含内容。双击右栏的子目录进下一层，双击文档打开。
/// </remarks>
public sealed class CloudDocumentsDialog : Window
{
    private static readonly Strings S = Strings.Instance;
    private static readonly IBrush ErrorBrush = new SolidColorBrush(Color.Parse("#C42B1C"));
    private static readonly IBrush NormalBrush = new SolidColorBrush(Color.Parse("#444444"));

    private readonly RemoteDocumentStore _store;
    private readonly CloudBrowserPane _browser;
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly Button _openButton;
    private readonly Button _deleteButton;

    /// <summary>用户选择打开的文档；未选择则为 null。</summary>
    public DocumentListItemDto? Selected { get; private set; }

    public CloudDocumentsDialog(RemoteDocumentStore store)
    {
        _store = store;
        _browser = new CloudBrowserPane(store, S.CloudFolderTreeTitle);

        Title = S.CloudTitle;
        Width = 760;
        Height = 540;
        CanResize = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        _browser.LoadStarted += (_, _) => SetStatus(S.AuthWorking, isError: false);
        _browser.Loaded += (_, _) => RefreshStatus();
        _browser.Failed += (_, code) => ShowError(code);
        _browser.SelectionChanged += (_, _) => UpdateButtons();
        _browser.DocumentActivated += (_, _) => OpenSelected();

        _openButton = MakeButton(S.CloudOpen, 96);
        _openButton.Click += (_, _) => OpenSelected();

        _deleteButton = MakeButton(S.CloudDelete, 88);
        _deleteButton.Click += async (_, _) => await DeleteSelectedAsync();

        var refreshButton = MakeButton(S.CloudRefresh, 88);
        refreshButton.Click += async (_, _) => await _browser.ReloadAsync();

        var closeButton = MakeButton(S.AuthClose, 88);
        closeButton.IsCancel = true;
        closeButton.Click += (_, _) => Close();

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Spacing = 8,
            Children = { _deleteButton, refreshButton, _openButton, closeButton },
        };
        Grid.SetRow(buttons, 2);

        var statusRow = new StackPanel
        {
            Margin = new Thickness(0, 10, 0, 0),
            Children = { _status },
        };
        Grid.SetRow(statusRow, 1);

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto,Auto"),
            Margin = new Thickness(20),
            Children = { _browser.View, statusRow, buttons },
        };

        UpdateButtons();
        Opened += async (_, _) => await _browser.ReloadAsync();
    }

    /// <summary>以模态方式打开，返回用户选择要打开的文档（取消返回 null）。</summary>
    public static async Task<DocumentListItemDto?> PickAsync(Window owner, RemoteDocumentStore store)
    {
        var dialog = new CloudDocumentsDialog(store);
        await dialog.ShowDialog(owner);
        return dialog.Selected;
    }

    private static Button MakeButton(string text, double minWidth) => new()
    {
        Content = text,
        MinWidth = minWidth,
        HorizontalContentAlignment = HorizontalAlignment.Center,
    };

    private void RefreshStatus()
    {
        if (_browser.CurrentFolder is not { } folder)
        {
            return;
        }

        if (_browser.FolderCount == 0 && _browser.DocumentCount == 0)
        {
            SetStatus(CloudFolderTree.DescribeEmptyContents(folder), isError: false);
            return;
        }

        var summary = string.Format(S.CloudStatusItemsFormat, _browser.FolderCount, _browser.DocumentCount);
        if (_browser.Quota is { } quota)
        {
            summary += $"    {CloudFolderTree.DescribeQuota(quota)}";
        }

        SetStatus(summary, isError: false);
    }

    private void ShowError(string? code)
    {
        SetStatus(CloudErrorText.Describe(code), isError: true);
        UpdateButtons();
    }

    private void OpenSelected()
    {
        if (_browser.SelectedDocument is not { } document)
        {
            return;
        }

        Selected = document;
        Close();
    }

    private async Task DeleteSelectedAsync()
    {
        if (_browser.SelectedDocument is not { } document)
        {
            return;
        }

        var confirmed = await ConfirmAsync(
            this,
            S.CloudConfirmDeleteTitle,
            string.Format(S.CloudConfirmDeleteFormat, document.Name),
            S.CloudDelete);

        if (!confirmed) return;

        if (!Guid.TryParse(document.Id, out var id))
        {
            SetStatus(CloudErrorText.Describe(RemoteDocumentStore.ErrorValidation), isError: true);
            return;
        }

        var result = await _store.DeleteAsync(id);
        if (!result.Ok)
        {
            SetStatus(CloudErrorText.Describe(result.ErrorCode), isError: true);
            return;
        }

        // 删掉一个目录里的最后一个文档，会让"由文档隐含"出来的目录整条消失，所以连树一起重来
        await _browser.ReloadAsync();
    }

    private void UpdateButtons()
    {
        var isDocument = _browser.SelectedDocument != null;
        _openButton.IsEnabled = isDocument;
        _deleteButton.IsEnabled = isDocument;
    }

    private void SetStatus(string text, bool isError)
    {
        _status.Text = text;
        _status.Foreground = isError ? ErrorBrush : NormalBrush;
    }

    /// <summary>极简确认框 —— 只为避免为一次 yes/no 引入新依赖。</summary>
    private static async Task<bool> ConfirmAsync(Window owner, string title, string message, string okLabel)
    {
        var dialog = new Window
        {
            Title = title,
            Width = 420,
            Height = 190,
            CanResize = false,
            ShowInTaskbar = false,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
        };

        var result = false;

        var ok = MakeButton(okLabel, 88);
        ok.IsDefault = true;
        ok.Click += (_, _) => { result = true; dialog.Close(); };

        var cancel = MakeButton(S.AuthClose, 88);
        cancel.IsCancel = true;
        cancel.Click += (_, _) => dialog.Close();

        dialog.Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto"),
            Margin = new Thickness(20),
            Children =
            {
                new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, FontSize = 14 },
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 8,
                    Children = { cancel, ok },
                },
            },
        };

        await dialog.ShowDialog(owner);
        return result;
    }
}
