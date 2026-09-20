using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 选择云端保存目标（保存流程）：左侧目录树选目录，右侧是该目录的直属内容（参照），
/// 上方是文档名（预填当前名字），"当前目录"那一行右侧可显式新建一个（可以是空的）子目录。
/// </summary>
/// <remarks>
/// <para>
/// 目录来自 <c>GET /v1/folders</c>（显式 folders 行 ∪ 文档路径隐含出来的目录），
/// 所以<b>空目录</b>同样会出现在树上。目标目录就是树上选中的那一个 —— 路径必须已经存在；
/// 要落到一个还不存在的目录，先用"当前目录"右侧的"新建"把它建出来（<c>POST /v1/folders</c>）。
/// </para>
/// <para>
/// <b>改名随保存一起走</b>：服务端 <c>PUT /v1/documents/{id}</c> 的 <c>name</c> 就是改名入口
/// （<c>DocumentPutIn.name</c>），所以保存 + 改名只需要一次请求，不需要额外的 PATCH。
/// </para>
/// <para>
/// 本地标签页名不在这里改 —— 那是本地文件的身份，属于调用方的决定。
/// </para>
/// </remarks>
public sealed class CloudPathPickerDialog : Window
{
    /// <summary>服务端 <c>DocumentPutIn.name</c> 的长度上限（<c>Field(min_length=1, max_length=255)</c>）。</summary>
    private const int DocumentNameMaxLength = 255;

    private static readonly Strings S = Strings.Instance;
    private static readonly IBrush ErrorBrush = new SolidColorBrush(Color.Parse("#C42B1C"));
    private static readonly IBrush NormalBrush = new SolidColorBrush(Color.Parse("#444444"));

    private readonly RemoteDocumentStore _store;
    private readonly CloudBrowserPane _browser;
    private readonly TextBox _documentNameBox;
    private readonly TextBox _folderNameBox = new() { MinWidth = 160 };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly Button _createButton;
    private readonly Button _saveButton;

    /// <summary>用户确认的保存目标（目录路径 + 文档名）；取消则为 null。</summary>
    public Target? Selected { get; private set; }

    private CloudPathPickerDialog(
        RemoteDocumentStore store, string title, string label, string? initialPath, string? initialName)
    {
        _store = store;

        Title = title;
        Width = 760;
        Height = 560;
        CanResize = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        // 两个名字框各管一摊：文档名决定"保存成什么名字"；另一个只用于新建目录。
        _documentNameBox = new TextBox { Text = initialName?.Trim() ?? string.Empty };
        _folderNameBox.Watermark = S.CloudPathNewFolderPlaceholder;

        _createButton = MakeButton(S.CloudPathCreate, 72);
        _createButton.Click += async (_, _) => await CreateFolderAsync();

        _saveButton = MakeButton(S.CloudPathConfirm, 88);
        _saveButton.IsDefault = true;
        _saveButton.Click += (_, _) => Confirm();

        var cancelButton = MakeButton(S.AuthClose, 88);
        cancelButton.IsCancel = true;
        cancelButton.Click += (_, _) => Close();

        // 新建目录的名字框与按钮是配对的，整行一起挂到"当前目录"那一行的右侧 ——
        // 新建出来的目录就属于当前目录，动作贴着它放着最说得通。
        var createFolderRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            VerticalAlignment = VerticalAlignment.Center,
            Spacing = 8,
            Children = { _folderNameBox, _createButton },
        };

        _browser = new CloudBrowserPane(store, label, initialPath, createFolderRow);

        _browser.LoadStarted += (_, _) => SetStatus(S.AuthWorking, isError: false);
        _browser.Loaded += (_, _) => RefreshStatus();
        _browser.Failed += (_, code) => ShowError(code);
        _browser.SelectionChanged += (_, _) => RefreshStatus();

        var nameRow = new Grid
        {
            ColumnDefinitions = ColumnDefinitions.Parse("Auto,*"),
            ColumnSpacing = 8,
            Margin = new Thickness(0, 10, 0, 0),
            Children =
            {
                new TextBlock { Text = S.CloudDocumentNameLabel, VerticalAlignment = VerticalAlignment.Center },
                _documentNameBox,
            },
        };
        Grid.SetColumn(_documentNameBox, 1);
        Grid.SetRow(nameRow, 1);

        var statusRow = new StackPanel
        {
            Margin = new Thickness(0, 10, 0, 0),
            Children = { _status },
        };
        Grid.SetRow(statusRow, 2);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Spacing = 8,
            Margin = new Thickness(0, 10, 0, 0),
            Children = { _saveButton, cancelButton },
        };
        Grid.SetRow(buttons, 3);

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto,Auto,Auto"),
            Margin = new Thickness(20),
            Children = { _browser.View, nameRow, statusRow, buttons },
        };

        Opened += async (_, _) => await _browser.ReloadAsync();
    }

    /// <summary>
    /// 以模态方式打开，返回用户确认的保存目标（目录路径 + 文档名）；取消返回 null。
    /// </summary>
    /// <param name="initialPath">目录树默认选中的目录 —— 给文档现有的云端路径；null/空 = 根。</param>
    /// <param name="initialName">
    /// 文档名输入框的预填值 —— 文档已有云端位置时给<b>当前云端名</b>，否则给标签页名。
    /// </param>
    public static async Task<Target?> PickAsync(
        Window owner,
        RemoteDocumentStore store,
        string title,
        string label,
        string? initialPath,
        string? initialName)
    {
        var dialog = new CloudPathPickerDialog(store, title, label, initialPath, initialName);
        await dialog.ShowDialog(owner);
        return dialog.Selected;
    }

    private static Button MakeButton(string text, double minWidth) => new()
    {
        Content = text,
        MinWidth = minWidth,
        HorizontalContentAlignment = HorizontalAlignment.Center,
    };

    /// <summary>
    /// 状态栏：默认为当前目录的计数。右栏选中文档时提示"文档只是参照"，免得把文档行当成保存位置。
    /// </summary>
    private void RefreshStatus()
    {
        if (_browser.SelectedDocument != null)
        {
            SetStatus(S.CloudPathDocumentHint, isError: false);
            return;
        }

        if (_browser.CurrentFolder is not { } folder)
        {
            return;
        }

        if (_browser.FolderCount == 0 && _browser.DocumentCount == 0)
        {
            SetStatus(CloudFolderTree.DescribeEmptyContents(folder), isError: false);
            return;
        }

        SetStatus(
            string.Format(S.CloudStatusItemsFormat, _browser.FolderCount, _browser.DocumentCount),
            isError: false);
    }

    private void ShowError(string? code) => SetStatus(CloudErrorText.Describe(code), isError: true);

    /// <summary>在<b>当前目录</b>下显式建一个（可以是空的）子目录，建成后选它作为保存位置。</summary>
    private async Task CreateFolderAsync()
    {
        var name = RemoteDocumentStore.NormalizePath(_folderNameBox.Text);
        if (name.Length == 0)
        {
            SetStatus(S.CloudFolderNameRequired, isError: true);
            _folderNameBox.Focus();
            return;
        }

        // 名字框只收一段名字（与文档名框同一口径）：`/` 会被折成多级路径，`\` 则被服务端
        // 的 normalize_document_path 明确拒绝（"静默当 / 会让两端目录认知分叉"），一并挡在这里。
        if (name.Contains('/') || name.Contains('\\'))
        {
            SetStatus(S.CloudFolderNameInvalid, isError: true);
            _folderNameBox.Focus();
            return;
        }

        var parent = _browser.CurrentPath;
        var path = parent.Length == 0 ? name : $"{parent}/{name}";

        _createButton.IsEnabled = false;
        var result = await _store.CreateFolderAsync(path);
        _createButton.IsEnabled = true;

        if (!result.Ok)
        {
            SetStatus(DescribeCreateFolderFailure(result.ErrorCode, result.Details), isError: true);
            _folderNameBox.Focus();
            return;
        }

        _folderNameBox.Text = string.Empty;

        // 新目录要出现在树上，所以整棵树重来一遍，再把它选成目标
        await _browser.ReloadAsync();
        await _browser.SelectAsync(path);
        SetStatus(string.Format(S.CloudFolderCreatedFormat, path), isError: false);
    }

    /// <summary>
    /// 建目录失败的提示 —— 落点始终是那个名字框。
    /// </summary>
    /// <remarks>
    /// 422 时按服务端 <c>details.reason</c> 给出<b>具体</b>原因，但仍然是全本地化：<b>绝不读服务端的
    /// <c>message</c></b>（那是中文硬编码、也不是稳定接口）。reason 缺失、认不出、或参数不全时退回一句
    /// 泛化的"不符合命名规则"，不会留空白。
    /// 客户端的规则判定只有"名字框里挡分隔符"那两条；服务端那套路径规则一律不复刻。
    /// </remarks>
    private static string DescribeCreateFolderFailure(string? code, JsonElement? details)
    {
        if (code == RemoteDocumentStore.ErrorNameTaken)
        {
            return S.CloudFolderExists;
        }

        return code == RemoteDocumentStore.ErrorValidation
            ? DescribePathRejection(details)
            : CloudErrorText.Describe(code);
    }

    /// <summary>
    /// 服务端路径拒绝原因 → 具体文案。上限数值（<c>maxSegment</c>/<c>maxPath</c>）从 details 读，
    /// 客户端不写死 —— 服务端改上限时文案自动跟着变，不会说谎。
    /// </summary>
    private static string DescribePathRejection(JsonElement? details)
    {
        return ReadDetailText(details, "reason") switch
        {
            "backslash" => S.CloudFolderNameBackslash,
            "control_char" => S.CloudFolderNameControlChar,
            "dot_segment" => S.CloudFolderNameDotSegment,
            "empty_segment" => S.CloudFolderNameEmptySegment,
            "segment_too_long" => DescribeLimit(details, "maxSegment", S.CloudFolderNameSegmentTooLongFormat),
            "path_too_long" => DescribeLimit(details, "maxPath", S.CloudFolderNamePathTooLongFormat),
            _ => S.CloudFolderNameRejected,
        };
    }

    /// <summary>带上限数值的文案；服务端没给这个数就退回泛化文案（宁可不具体，也不猜数字）。</summary>
    private static string DescribeLimit(JsonElement? details, string name, string template)
    {
        return ReadDetailNumber(details, name) is { } limit
            ? string.Format(template, limit)
            : S.CloudFolderNameRejected;
    }

    /// <summary>details 的 JsonElement 读取只此一处：不是对象、字段缺失一律 null。</summary>
    private static JsonElement? ReadDetail(JsonElement? details, string name)
    {
        if (details == null || details.Value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return details.Value.TryGetProperty(name, out var value) ? value : null;
    }

    private static string? ReadDetailText(JsonElement? details, string name)
    {
        var value = ReadDetail(details, name);
        return value != null && value.Value.ValueKind == JsonValueKind.String ? value.Value.GetString() : null;
    }

    private static int? ReadDetailNumber(JsonElement? details, string name)
    {
        var value = ReadDetail(details, name);
        if (value == null || value.Value.ValueKind != JsonValueKind.Number)
        {
            return null;
        }

        return value.Value.TryGetInt32(out var number) ? number : null;
    }

    /// <summary>
    /// 确认：文档名先按服务端的限制挡一遍（非空、≤255），免得提交完才吃 422；
    /// 通过则把"树上选中的目录 + 文档名"交回调用方。
    /// </summary>
    private void Confirm()
    {
        var name = _documentNameBox.Text?.Trim() ?? string.Empty;
        if (name.Length == 0)
        {
            SetStatus(S.CloudDocumentNameRequired, isError: true);
            _documentNameBox.Focus();
            return;
        }

        // 服务端按 Python 的 len（Unicode 码点）算长度，所以这里也数码点、不数 UTF-16 单元
        if (name.EnumerateRunes().Count() > DocumentNameMaxLength)
        {
            SetStatus(
                string.Format(S.CloudDocumentNameTooLongFormat, DocumentNameMaxLength),
                isError: true);
            _documentNameBox.Focus();
            return;
        }

        // 名字是"叶子名"：层级由目标目录（path 字段）表达，混进分隔符会让两个字段语义重叠；
        // 显示端（TabItem.UpdateHeader 取 DisplayPath 的末段）也会把它截断，所以一律挡在框里。
        if (name.Contains('/') || name.Contains('\\'))
        {
            SetStatus(S.CloudDocumentNameInvalid, isError: true);
            _documentNameBox.Focus();
            return;
        }

        Selected = new Target(_browser.CurrentPath, name);
        Close();
    }

    private void SetStatus(string text, bool isError)
    {
        _status.Text = text;
        _status.Foreground = isError ? ErrorBrush : NormalBrush;
    }

    /// <summary>用户确认的保存目标：目录路径（根 = 空串）+ 去掉首尾空白的文档名。</summary>
    public sealed record Target(string Path, string Name);
}
