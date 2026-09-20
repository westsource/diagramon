using System;
using System.Collections.Generic;
using System.Linq;
using Avalonia.Controls;
using Diagramon.Models;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 云端目录树上的一个节点（根节点也在内）。
/// </summary>
/// <remarks>
/// 节点只代表目录 —— 目录里的文档仍然按"当前层"单独请求服务端，不铺进树里。
/// </remarks>
internal sealed class CloudFolderNode
{
    internal CloudFolderNode(string path, string name)
    {
        Path = path;
        Name = name;
    }

    /// <summary>库内相对路径；空串 = 根目录。</summary>
    public string Path { get; }

    /// <summary>末段名（不含父路径）；根节点为空串。</summary>
    public string Name { get; }

    /// <summary>是否就是根节点。</summary>
    public bool IsRoot => Path.Length == 0;

    /// <summary>直属文档数（服务端给的计数）。</summary>
    public int DocumentCount { get; internal set; }

    /// <summary>
    /// 是否还有下级 —— 以<b>组出来的子节点</b>为准，服务端另有报告时取并集，
    /// 免得列表万一不全就把"其实还有下级"的目录显示成叶子。
    /// </summary>
    public bool HasChildren => Children.Count > 0 || ReportedChildren;

    /// <summary>服务端报告的是否有子目录。</summary>
    internal bool ReportedChildren { get; set; }

    /// <summary>子目录，按名字排序。</summary>
    public List<CloudFolderNode> Children { get; } = new();
}

/// <summary>
/// 云端目录树 —— <b>扁平 folder 列表 → 树</b>的唯一实现，两个云对话框共用。
/// </summary>
/// <remarks>
/// <para>
/// 服务端 <c>GET /v1/folders</c> 回的是扁平列表（显式 folders 行 ∪ 文档路径隐含的目录，按 path 排序），
/// <b>不含根</b>；这里把根补出来，并且不依赖返回顺序 —— 中间层缺了就按需补一个空壳节点。
/// </para>
/// <para>
/// 展示文案（目录行/文档行/空目录提示）也收在这里，免得同一个目录在两个对话框里显示成不同的话。
/// </para>
/// </remarks>
internal sealed class CloudFolderTree
{
    private static readonly Strings S = Strings.Instance;
    private readonly Dictionary<string, CloudFolderNode> _index = new(StringComparer.Ordinal);

    private CloudFolderTree()
    {
        Root = new CloudFolderNode(string.Empty, string.Empty);
        _index[string.Empty] = Root;
    }

    /// <summary>根节点（空路径）—— 服务端不返回根，由这里补。</summary>
    public CloudFolderNode Root { get; }

    /// <summary>组树：输入服务端的扁平目录列表，输出含根的一棵有序树。</summary>
    public static CloudFolderTree Build(IEnumerable<FolderDto>? folders)
    {
        var tree = new CloudFolderTree();

        foreach (var folder in folders ?? Enumerable.Empty<FolderDto>())
        {
            var path = RemoteDocumentStore.NormalizePath(folder.Path);
            var node = path.Length == 0 ? tree.Root : tree.Ensure(path);

            node.DocumentCount = folder.DocumentCount;
            node.ReportedChildren = folder.HasChildren;
        }

        Sort(tree.Root);
        return tree;
    }

    /// <summary>按路径取节点；路径不在树上返回 null。</summary>
    public CloudFolderNode? Find(string? path)
    {
        var normalized = RemoteDocumentStore.NormalizePath(path);
        return _index.TryGetValue(normalized, out var node) ? node : null;
    }

    /// <summary>从根到该节点的链（含两端），用来逐级展开。</summary>
    public List<CloudFolderNode> PathTo(CloudFolderNode node)
    {
        var chain = new List<CloudFolderNode> { Root };
        if (node.IsRoot)
        {
            return chain;
        }

        var accumulated = string.Empty;
        foreach (var segment in node.Path.Split('/'))
        {
            accumulated = accumulated.Length == 0 ? segment : $"{accumulated}/{segment}";
            if (!_index.TryGetValue(accumulated, out var step))
            {
                break;
            }

            chain.Add(step);
        }

        return chain;
    }

    /// <summary>
    /// 树上的一行：名字（根显"根目录"）；空目录补一个标记 —— 否则一个空目录和"没加载出来"长得一样。
    /// </summary>
    public static string DescribeNode(CloudFolderNode folder)
    {
        var name = folder.IsRoot ? S.CloudPathRoot : folder.Name;
        return folder.HasChildren || folder.DocumentCount > 0 ? name : $"{name}    {S.CloudFolderEmpty}";
    }

    /// <summary>目录行的文字：名字 + 计数；空目录明确标出，否则和"加载失败"看起来一样。</summary>
    public static string DescribeFolder(CloudFolderNode folder)
    {
        var name = folder.Name + "/";

        if (!folder.HasChildren && folder.DocumentCount == 0)
        {
            return $"{name}    {S.CloudFolderEmpty}";
        }

        var text = $"{name}    {string.Format(S.CloudFolderDocsFormat, folder.DocumentCount)}";
        return folder.HasChildren ? $"{text}    {S.CloudFolderSubdirs}" : text;
    }

    /// <summary>当前目录的标题：根说"根目录"，其余直接显路径。</summary>
    public static string DescribeLocation(CloudFolderNode folder)
    {
        return string.Format(S.CloudPathCurrentFormat, folder.IsRoot ? S.CloudPathRoot : folder.Path);
    }

    /// <summary>目录里什么都没有时的提示（根上说的是"库里还没有东西"）。</summary>
    public static string DescribeEmptyContents(CloudFolderNode folder)
    {
        return folder.IsRoot ? S.CloudEmpty : S.CloudPathNoContent;
    }

    /// <summary>配额摘要：已用 / 总量。</summary>
    public static string DescribeQuota(QuotaDto quota)
    {
        return $"{FormatSize(quota.UsedBytes)} / {FormatSize(quota.QuotaBytes)}";
    }

    /// <summary>取路径上的节点，缺哪级补哪级。</summary>
    private CloudFolderNode Ensure(string path)
    {
        if (_index.TryGetValue(path, out var existing))
        {
            return existing;
        }

        var slash = path.LastIndexOf('/');
        var parent = Ensure(slash < 0 ? string.Empty : path[..slash]);
        var node = new CloudFolderNode(path, slash < 0 ? path : path[(slash + 1)..]);

        parent.Children.Add(node);
        _index[path] = node;
        return node;
    }

    private static void Sort(CloudFolderNode node)
    {
        node.Children.Sort((left, right) =>
            string.Compare(left.Name, right.Name, StringComparison.CurrentCultureIgnoreCase));

        foreach (var child in node.Children)
        {
            Sort(child);
        }
    }

    /// <summary>人类可读的字节数（自适单位，一路到 GB —— 云端配额正是这个量级）。</summary>
    public static string FormatSize(long bytes) =>
        bytes < 1024 ? $"{bytes} B"
        : bytes < 1024 * 1024 ? $"{bytes / 1024.0:0.#} KB"
        : bytes < 1024L * 1024 * 1024 ? $"{bytes / (1024.0 * 1024.0):0.##} MB"
        : $"{bytes / (1024.0 * 1024.0 * 1024.0):0.##} GB";

    /// <summary>
    /// 时间按<b>当前区域的短日期 + 短时间</b>显示（不写死 pattern，换区域/换语言都跟着走）。
    /// ISO 串解析不出来就留空 —— 把原始串（<c>2026-09-19T15:15:33+00:00</c>）怼到用户脸上比空白更糟。
    /// </summary>
    public static string DescribeTime(string? iso) =>
        DateTimeOffset.TryParse(iso, out var time) ? time.ToLocalTime().ToString("g") : string.Empty;
}

/// <summary>
/// 左侧目录树控件：把 <see cref="CloudFolderTree"/> 铺成 <see cref="TreeViewItem"/>，
/// 负责展开/折叠与选中 —— 两个云对话框共用同一份实现。
/// </summary>
/// <remarks>
/// 直接用 <see cref="TreeViewItem"/> 当数据项（它自己就是自己的容器），
/// 这样"展开某一层"就是给手上现成的节点赋值，不必等容器被布局创建出来。
/// </remarks>
internal sealed class CloudFolderTreeView
{
    private static readonly Strings S = Strings.Instance;
    private readonly TreeView _tree = new()
    {
        SelectionMode = SelectionMode.Single,
        AutoScrollToSelectedItem = true,
    };

    private readonly Dictionary<string, TreeViewItem> _containers = new(StringComparer.Ordinal);
    private CloudFolderTree? _model;

    public CloudFolderTreeView()
    {
        _tree.SelectionChanged += (_, _) => SelectionChanged?.Invoke(this, EventArgs.Empty);
    }

    /// <summary>底层控件，交给调用方摆放。</summary>
    public TreeView Control => _tree;

    /// <summary>当前选中的目录；还没选中时为 null。</summary>
    public CloudFolderNode? SelectedNode =>
        _tree.SelectedItem is TreeViewItem container ? container.Tag as CloudFolderNode : null;

    /// <summary>选中项变了（鼠标、键盘或 <see cref="Select"/> 都会触发）。</summary>
    public event EventHandler? SelectionChanged;

    /// <summary>铺一棵目录树；重建前已经展开的目录保持展开（刷新时不会整棵折叠回去）。</summary>
    public void Load(CloudFolderTree tree)
    {
        var expanded = _containers
            .Where(pair => pair.Value.IsExpanded)
            .Select(pair => pair.Key)
            .ToList();

        _model = tree;
        _containers.Clear();
        _tree.ItemsSource = new List<TreeViewItem> { BuildItem(tree.Root) };

        foreach (var path in expanded)
        {
            if (_containers.TryGetValue(path, out var container))
            {
                container.IsExpanded = true;
            }
        }
    }

    /// <summary>
    /// 展开到指定目录并选中它；路径不在树上则退到根。返回真正选中的节点（树还没加载时为 null）。
    /// </summary>
    public CloudFolderNode? Select(string? path)
    {
        if (_model == null)
        {
            return null;
        }

        var node = _model.Find(path) ?? _model.Root;

        foreach (var step in _model.PathTo(node))
        {
            if (_containers.TryGetValue(step.Path, out var container))
            {
                container.IsExpanded = true;
            }
        }

        if (!_containers.TryGetValue(node.Path, out var target))
        {
            return node;
        }

        // 展开是为了"看得见"：先把刚展开的层级跑一遍布局实体化（UpdateLayout 是公开 API），
        // 再选中并滚动过去 —— 未实体的项既不会画选中态，也滚不到。
        _tree.UpdateLayout();

        target.IsSelected = true;
        _tree.SelectedItem = target;
        target.BringIntoView();
        return node;
    }

    private TreeViewItem BuildItem(CloudFolderNode node)
    {
        var header = new TextBlock { Text = CloudFolderTree.DescribeNode(node) };
        ToolTip.SetTip(header, Describe(node));

        var container = new TreeViewItem
        {
            Header = header,
            Tag = node,
        };
        _containers[node.Path] = container;

        if (node.Children.Count > 0)
        {
            container.ItemsSource = node.Children.Select(BuildItem).ToList();
        }

        return container;
    }

    /// <summary>树上只写名字（层级已经由缩进表达），计数放进提示气泡。</summary>
    private static string Describe(CloudFolderNode node) =>
        node.IsRoot
            ? $"{S.CloudPathRoot}    {string.Format(S.CloudStatusItemsFormat, node.Children.Count, node.DocumentCount)}"
            : CloudFolderTree.DescribeFolder(node);
}
