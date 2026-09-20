using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Styling;
using Diagramon.Models;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 右侧内容表：当前目录的<b>直属</b>内容 —— 子目录在前、文档在后，按 名称/类型/大小/修改时间 四列铺开。
/// </summary>
/// <remarks>
/// <para>
/// 手写表格（不引 DataGrid）：一行表头 + <see cref="ListBox"/> 的数据行。
/// <b>列宽只有 <see cref="Columns"/> 一处定义</b>，表头与每一行都拿它解析出自己的列，
/// 因此缩放窗口时列边界始终对齐；同时把 ListBox / ListBoxItem 的内边距与边框压成 0、
/// 并让滚动条以 overlay 方式出现，行从左边界起画，与表头同一个原点。
/// </para>
/// <para>
/// 单元格文本由 <see cref="AddCell"/> 统一生成（内边距、省略号、tooltip 都在那里），
/// 表头与数据行共用同一份，不会出现"表头缩进和行对不上"的老毛病。
/// </para>
/// <para>
/// <c>SelectedIndex</c> 仍与内部行一一对应；双击只把事件抛出去，是"进目录"还是"开文档"由调用方分派。
/// </para>
/// </remarks>
internal sealed class CloudContentsList
{
    private static readonly Strings S = Strings.Instance;

    /// <summary>
    /// 四列的比例（名称 / 类型 / 大小 / 修改时间）—— <b>表格里唯一的列宽定义</b>：
    /// 表头与每个数据行都 <c>ColumnDefinitions.Parse(Columns)</c>，所以两边永远同宽。
    /// </summary>
    private const string Columns = "5*,2*,2*,3*";

    /// <summary>单元格内边距：表头与数据行共用，列内的文字起点因此一致。</summary>
    private static readonly Thickness CellPadding = new(8, 6, 8, 6);

    private static readonly IBrush LineBrush = new SolidColorBrush(Color.Parse("#CCCCCC"));

    private sealed record Row(CloudFolderNode? Folder, DocumentListItemDto? Document);

    private readonly List<Row> _rows = new();
    private readonly ListBox _list = new();

    public CloudContentsList()
    {
        // 行必须从"原点"开始画，才可能和 ListBox 外面的表头对齐：
        // 容器自己不留边框/内边距，ListBoxItem 的 Fluent 默认内边距（12,9,12,12）一并压掉。
        _list.Padding = default;
        _list.BorderThickness = default;
        _list.CornerRadius = default;
        _list.Styles.Add(new Style(selector => selector.OfType<ListBoxItem>())
        {
            Setters = { new Setter(TemplatedControl.PaddingProperty, default(Thickness)) },
        });

        // 滚动条走 overlay（不占宽度）：否则一出现纵向滚动条，数据行就比表头窄十几像素，列立刻错位。
        ScrollViewer.SetAllowAutoHide(_list, true);

        _list.SelectionChanged += (_, _) => SyncSelection();
        _list.DoubleTapped += (_, _) => Activated?.Invoke(this, EventArgs.Empty);

        var table = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("Auto,*"),
            Children =
            {
                BuildHeader(),
                _list,
            },
        };
        Grid.SetRow(_list, 1);

        Control = new Border
        {
            BorderBrush = LineBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4),
            // 列表自己是直角背景，靠这里裁进圆角边框内，四角不会冒出一小块底色
            ClipToBounds = true,
            Child = table,
        };
    }

    /// <summary>底层控件（表头 + 列表的整块表格），交给调用方摆放。</summary>
    public Control Control { get; }

    /// <summary>选中的子目录；选中的是文档时为 null。</summary>
    public CloudFolderNode? SelectedFolder { get; private set; }

    /// <summary>选中的文档；选中的是目录时为 null。</summary>
    public DocumentListItemDto? SelectedDocument { get; private set; }

    /// <summary>当前目录的直属子目录数。</summary>
    public int FolderCount { get; private set; }

    /// <summary>当前目录的直属文档数。</summary>
    public int DocumentCount { get; private set; }

    /// <summary>选中项变化。</summary>
    public event EventHandler? SelectionChanged;

    /// <summary>双击了某一行。</summary>
    public event EventHandler? Activated;

    /// <summary>铺一个目录的直属内容：目录树里拿子目录，服务端拿文档。</summary>
    public void Load(CloudFolderNode folder, IEnumerable<DocumentListItemDto>? documents)
    {
        var items = (documents ?? Enumerable.Empty<DocumentListItemDto>())
            .OrderBy(document => document.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();

        _rows.Clear();
        _rows.AddRange(folder.Children.Select(child => new Row(child, null)));
        _rows.AddRange(items.Select(document => new Row(null, document)));
        FolderCount = folder.Children.Count;
        DocumentCount = items.Count;

        // 一行一个 Grid（列宽与表头同一份定义）；SelectedIndex 与 _rows 仍一一对应
        _list.ItemsSource = _rows.Select(BuildRow).ToList();
    }

    /// <summary>清空（加载失败时用）。</summary>
    public void Clear()
    {
        _rows.Clear();
        FolderCount = 0;
        DocumentCount = 0;
        _list.ItemsSource = new List<Control>();
    }

    /// <summary>表头：四列标题，与数据行共用列宽定义与单元格内边距。</summary>
    private static Control BuildHeader()
    {
        var header = NewRowGrid();
        AddCell(header, 0, S.CloudColumnName, FontWeight.SemiBold);
        AddCell(header, 1, S.CloudColumnType, FontWeight.SemiBold);
        AddCell(header, 2, S.CloudColumnSize, FontWeight.SemiBold);
        AddCell(header, 3, S.CloudColumnModified, FontWeight.SemiBold);

        return new Border
        {
            BorderBrush = LineBrush,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Child = header,
        };
    }

    /// <summary>数据行：名称 / 类型 / 大小 / 修改时间。目录没有大小与修改时间，两列<b>留空</b>而不是写 0。</summary>
    private static Control BuildRow(Row row)
    {
        var grid = NewRowGrid();

        if (row.Folder is { } folder)
        {
            // 名字沿用树上那套写法（含"空目录"标记）；计数信息放进 tooltip，不占列
            AddCell(grid, 0, CloudFolderTree.DescribeNode(folder), tip: CloudFolderTree.DescribeFolder(folder));
            AddCell(grid, 1, S.CloudTypeFolder);
            AddCell(grid, 2, string.Empty);
            AddCell(grid, 3, string.Empty);
            return grid;
        }

        var document = row.Document!;
        AddCell(grid, 0, document.Name, tip: document.Name);
        AddCell(grid, 1, document.Format);
        AddCell(grid, 2, CloudFolderTree.FormatSize(document.Size));
        AddCell(grid, 3, CloudFolderTree.DescribeTime(document.UpdatedAt));
        return grid;
    }

    private static Grid NewRowGrid() => new() { ColumnDefinitions = ColumnDefinitions.Parse(Columns) };

    /// <summary>
    /// 往行里放一个单元格 —— 内边距、省略号、tooltip 只有这一处实现，表头与数据行共用。
    /// 长了就省略（tooltip 里能看全），不会把相邻列挤歪。
    /// </summary>
    private static void AddCell(Grid grid, int column, string text, FontWeight? weight = null, string? tip = null)
    {
        var cell = new TextBlock
        {
            Text = text,
            Margin = CellPadding,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };

        if (weight is { } fontWeight)
        {
            cell.FontWeight = fontWeight;
        }

        if (!string.IsNullOrEmpty(tip))
        {
            ToolTip.SetTip(cell, tip);
        }

        grid.Children.Add(cell);
        Grid.SetColumn(cell, column);
    }

    private void SyncSelection()
    {
        var index = _list.SelectedIndex;
        var row = index >= 0 && index < _rows.Count ? _rows[index] : null;

        SelectedFolder = row?.Folder;
        SelectedDocument = row?.Document;
        SelectionChanged?.Invoke(this, EventArgs.Empty);
    }
}

/// <summary>
/// 云端目录浏览器：左栏整棵目录树、右栏当前目录的直属内容 —— 保存/打开两个对话框共用的中间件。
/// </summary>
/// <remarks>
/// <para>
/// 目录树由 <see cref="CloudFolderTree"/> 组出来（<b>组树逻辑只有那一份</b>），本类只负责
/// "选中目录 → 拉该层内容 → 把结果和错误抛给对话框"这套导航，因此两个对话框的空目录、
/// 层级排序、错误处理不会各走各的。
/// </para>
/// <para>
/// 只读不写：建目录、删文档这类写操作仍由对话框自己做，本类不掺和。
/// </para>
/// </remarks>
internal sealed class CloudBrowserPane
{
    private readonly RemoteDocumentStore _store;
    private readonly CloudFolderTreeView _folders = new();
    private readonly CloudContentsList _contents = new();
    private readonly TextBlock _location = new()
    {
        FontWeight = FontWeight.SemiBold,
        TextWrapping = TextWrapping.Wrap,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private string _path;
    private CloudFolderNode? _node;

    /// <param name="store">云端存储。</param>
    /// <param name="folderTreeTitle">目录树那一栏的标题（对话框自己的措辞）。</param>
    /// <param name="initialPath">首次加载要选中的目录；null/空 = 根。</param>
    /// <param name="currentFolderAction">
    /// 可选动作槽：渲染在"当前目录"那一行的右侧（保存对话框的"新建目录"就挂在这里）。
    /// 为 null 时布局与不带槽时完全一致。
    /// </param>
    public CloudBrowserPane(
        RemoteDocumentStore store,
        string folderTreeTitle,
        string? initialPath = null,
        Control? currentFolderAction = null)
    {
        _store = store;
        _path = RemoteDocumentStore.NormalizePath(initialPath);

        // 程序化选中同样会走到这个回调 —— 先把 _path 摆好，回调据此判定"这是我自己点的"
        _folders.SelectionChanged += async (_, _) => await SelectFromTreeAsync();
        _contents.SelectionChanged += (_, _) => SelectionChanged?.Invoke(this, EventArgs.Empty);
        _contents.Activated += async (_, _) => await ActivateAsync();

        var treePane = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("Auto,*"),
            RowSpacing = 6,
            Children =
            {
                new TextBlock { Text = folderTreeTitle },
                _folders.Control,
            },
        };
        Grid.SetRow(_folders.Control, 1);

        var contentsPane = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("Auto,*"),
            RowSpacing = 6,
            Children =
            {
                BuildContentsHeader(currentFolderAction),
                _contents.Control,
            },
        };
        Grid.SetRow(_contents.Control, 1);

        var panes = new Grid
        {
            ColumnDefinitions = ColumnDefinitions.Parse("240,12,*"),
            Children = { treePane, contentsPane },
        };
        Grid.SetColumn(contentsPane, 2);

        View = panes;
    }

    /// <summary>
    /// "当前目录"那一行：左侧是目录标题，右侧是可选的<b>动作槽</b>（保存对话框把"新建目录"整行挂在这里）。
    /// 槽占了右侧空间时，标题改单行省略 —— 完整路径仍在 tooltip 里，不会被静默藏起来。
    /// </summary>
    private Control BuildContentsHeader(Control? action)
    {
        if (action == null)
        {
            return _location;
        }

        _location.TextWrapping = TextWrapping.NoWrap;
        _location.TextTrimming = TextTrimming.CharacterEllipsis;

        var header = new Grid
        {
            ColumnDefinitions = ColumnDefinitions.Parse("*,Auto"),
            ColumnSpacing = 8,
            Children = { _location, action },
        };
        Grid.SetColumn(action, 1);
        return header;
    }

    /// <summary>标题行显示当前目录；tooltip 始终给完整路径。</summary>
    private void ShowLocation(CloudFolderNode folder)
    {
        var text = CloudFolderTree.DescribeLocation(folder);
        _location.Text = text;
        ToolTip.SetTip(_location, text);
    }

    /// <summary>左树 + 右列表两栏，交给对话框摆进自己的窗口。</summary>
    public Control View { get; }

    /// <summary>当前目录路径（根 = 空串）—— 保存流程"落到哪个目录"取的就是它。</summary>
    public string CurrentPath => _path;

    /// <summary>当前目录的节点；尚未加载出来时为 null。</summary>
    public CloudFolderNode? CurrentFolder => _node;

    /// <summary>当前目录的直属子目录数。</summary>
    public int FolderCount => _contents.FolderCount;

    /// <summary>当前目录的直属文档数。</summary>
    public int DocumentCount => _contents.DocumentCount;

    /// <summary>最近一次列文档带回来的配额。</summary>
    public QuotaDto? Quota { get; private set; }

    /// <summary>右栏选中的子目录。</summary>
    public CloudFolderNode? SelectedFolder => _contents.SelectedFolder;

    /// <summary>右栏选中的文档。</summary>
    public DocumentListItemDto? SelectedDocument => _contents.SelectedDocument;

    /// <summary>开始拉数据（对话框可以显示"处理中"）。</summary>
    public event EventHandler? LoadStarted;

    /// <summary>当前目录的内容已就绪。</summary>
    public event EventHandler? Loaded;

    /// <summary>拉数据失败，错误码交给对话框走 <see cref="CloudErrorText"/>。</summary>
    public event EventHandler<string?>? Failed;

    /// <summary>右栏选中项变化。</summary>
    public event EventHandler? SelectionChanged;

    /// <summary>双击了右栏里的文档（目录的下钻由本类自己完成）。</summary>
    public event EventHandler? DocumentActivated;

    /// <summary>重新拉整棵目录树，再回到当前目录（初始加载、刷新、删除之后都走它）。</summary>
    public async Task ReloadAsync()
    {
        LoadStarted?.Invoke(this, EventArgs.Empty);

        var folders = await _store.ListFoldersAsync();
        if (!folders.Ok || folders.Value == null)
        {
            Fail(folders.ErrorCode);
            return;
        }

        _folders.Load(CloudFolderTree.Build(folders.Value.Items));
        await SelectAsync(_path);
    }

    /// <summary>选中某个目录：树上选中并展开到它，右栏换成它的直属内容；路径不在树上则退回根。</summary>
    public async Task SelectAsync(string? path)
    {
        _path = RemoteDocumentStore.NormalizePath(path);

        var node = _folders.Select(_path);
        if (node == null)
        {
            return; // 目录树还没加载出来
        }

        _path = node.Path;
        ShowLocation(node);
        await LoadContentsAsync(node);
    }

    private async Task SelectFromTreeAsync()
    {
        var node = _folders.SelectedNode;
        if (node == null || node.Path == _path)
        {
            return;
        }

        _path = node.Path;
        ShowLocation(node);
        await LoadContentsAsync(node);
    }

    private async Task LoadContentsAsync(CloudFolderNode folder)
    {
        LoadStarted?.Invoke(this, EventArgs.Empty);

        // 契约：缺省 path 表示"不做路径过滤"，所以"只看本层"必须把 path 显式送出去（根 = 空串）
        var documents = await _store.ListAsync(path: folder.Path);
        if (!documents.Ok || documents.Value == null)
        {
            Fail(documents.ErrorCode);
            return;
        }

        _node = folder;
        Quota = documents.Value.Quota;
        _contents.Load(folder, documents.Value.Items);
        Loaded?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>双击：目录 → 下钻；文档 → 抛给对话框（保存流程里文档只是参照，不会有人接）。</summary>
    private async Task ActivateAsync()
    {
        if (_contents.SelectedFolder is { } folder)
        {
            await SelectAsync(folder.Path);
            return;
        }

        if (_contents.SelectedDocument != null)
        {
            DocumentActivated?.Invoke(this, EventArgs.Empty);
        }
    }

    private void Fail(string? code)
    {
        // 内容已经不可信：计数归零，别让对话框拿上一次的目录去凑状态栏（错误文案由调用方显示）
        _contents.Clear();
        _node = null;
        Quota = null;
        Failed?.Invoke(this, code);
    }
}
