using System;
using System.Collections.Generic;
using System.Linq;
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
/// 云端文件管理：列出、打开、删除。
/// </summary>
/// <remarks>
/// 列表项只显示元数据 —— 契约规定 <c>List</c> 不返回 <c>content</c>，
/// 内容在"打开"时按 id 单取。
/// </remarks>
public sealed class CloudDocumentsDialog : Window
{
    private static readonly Strings S = Strings.Instance;
    private static readonly IBrush ErrorBrush = new SolidColorBrush(Color.Parse("#C42B1C"));
    private static readonly IBrush NormalBrush = new SolidColorBrush(Color.Parse("#444444"));

    private readonly RemoteDocumentStore _store;
    private readonly ListBox _list = new() { Margin = new Thickness(0, 0, 0, 8) };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly Button _openButton;
    private readonly Button _deleteButton;

    private List<DocumentListItemDto> _items = new();

    /// <summary>用户选择打开的文档；未选择则为 null。</summary>
    public DocumentListItemDto? Selected { get; private set; }

    public CloudDocumentsDialog(RemoteDocumentStore store)
    {
        _store = store;

        Title = S.CloudTitle;
        Width = 620;
        Height = 460;
        CanResize = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        _openButton = MakeButton(S.AuthSignIn, 96);
        _openButton.Click += (_, _) => OpenSelected();

        _deleteButton = MakeButton(S.CloudDelete, 88);
        _deleteButton.Click += async (_, _) => await DeleteSelectedAsync();

        var refreshButton = MakeButton(S.CloudRefresh, 88);
        refreshButton.Click += async (_, _) => await ReloadAsync();

        var closeButton = MakeButton(S.AuthClose, 88);
        closeButton.IsCancel = true;
        closeButton.Click += (_, _) => Close();

        _list.SelectionChanged += (_, _) => UpdateButtons();
        _list.DoubleTapped += (_, _) => OpenSelected();

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto,Auto"),
            Margin = new Thickness(20),
            Children =
            {
                _list,
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 8,
                    Children = { _deleteButton, refreshButton, _openButton, closeButton },
                },
                new StackPanel
                {
                    [Grid.RowProperty] = 2,
                    Margin = new Thickness(0, 10, 0, 0),
                    Children = { _status },
                },
            },
        };

        UpdateButtons();
        Opened += async (_, _) => await ReloadAsync();
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

    private async Task ReloadAsync()
    {
        SetStatus(S.AuthWorking, isError: false);
        _openButton.IsEnabled = false;
        _deleteButton.IsEnabled = false;

        var result = await _store.ListAsync();

        if (!result.Ok || result.Value == null)
        {
            _items = new List<DocumentListItemDto>();
            _list.ItemsSource = new List<string> { DescribeError(result.ErrorCode) };
            SetStatus(DescribeError(result.ErrorCode), isError: true);
            return;
        }

        _items = result.Value.Items ?? new List<DocumentListItemDto>();
        // 列表项用纯文本，SelectedIndex 与 _items 一一对应 —— 避免引入数据模板
        _list.ItemsSource = _items
            .Select(d => $"{d.Name}    v{d.Version}    {FormatSize(d.Size)}    {ShortenTime(d.UpdatedAt)}")
            .ToList();

        if (_items.Count == 0)
        {
            SetStatus(S.CloudEmpty, isError: false);
        }
        else
        {
            var quota = result.Value.Quota;
            SetStatus(
                quota == null
                    ? $"{_items.Count}"
                    : $"{_items.Count}    {FormatSize(quota.UsedBytes)} / {FormatSize(quota.QuotaBytes)}",
                isError: false);
        }

        UpdateButtons();
    }

    private void OpenSelected()
    {
        var item = CurrentSelection();
        if (item == null) return;

        Selected = item;
        Close();
    }

    private async Task DeleteSelectedAsync()
    {
        var item = CurrentSelection();
        if (item == null) return;

        var confirmed = await ConfirmAsync(
            this,
            S.CloudConfirmDeleteTitle,
            string.Format(S.CloudConfirmDeleteFormat, item.Name),
            S.CloudDelete);

        if (!confirmed) return;

        if (!Guid.TryParse(item.Id, out var id))
        {
            SetStatus(DescribeError("validation_error"), isError: true);
            return;
        }

        var result = await _store.DeleteAsync(id);
        if (!result.Ok)
        {
            SetStatus(DescribeError(result.ErrorCode), isError: true);
            return;
        }

        await ReloadAsync();
    }

    private DocumentListItemDto? CurrentSelection()
    {
        var index = _list.SelectedIndex;
        return index >= 0 && index < _items.Count ? _items[index] : null;
    }

    private void UpdateButtons()
    {
        var hasSelection = CurrentSelection() != null;
        _openButton.IsEnabled = hasSelection;
        _deleteButton.IsEnabled = hasSelection;
    }

    private void SetStatus(string text, bool isError)
    {
        _status.Text = text;
        _status.Foreground = isError ? ErrorBrush : NormalBrush;
    }

    /// <summary>把线上错误码映射成本地化文案。</summary>
    private static string DescribeError(string? code) => code switch
    {
        "membership_required" => S.AuthFreePlanHint,
        "quota_exceeded" => S.AuthErrorGeneric,
        "not_found" => S.FileNotFound,
        ApiClient.NetworkError => S.AuthErrorNetwork,
        _ => string.Format(S.CloudStatusErrorFormat, code ?? S.AuthErrorGeneric),
    };

    private static string FormatSize(long bytes) =>
        bytes < 1024 ? $"{bytes} B"
        : bytes < 1024 * 1024 ? $"{bytes / 1024.0:0.#} KB"
        : $"{bytes / (1024.0 * 1024.0):0.##} MB";

    private static string ShortenTime(string? iso) =>
        DateTimeOffset.TryParse(iso, out var t) ? t.ToLocalTime().ToString("MM-dd HH:mm") : string.Empty;

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
