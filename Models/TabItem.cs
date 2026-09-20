using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Avalonia.Media.Imaging;
using AvaloniaEdit.Document;

namespace Diagramon.Models;

public partial class TabItem : ObservableObject
{
    [ObservableProperty]
    private string _header = "未命名.mmd";

    [ObservableProperty]
    private bool _isModified;

    private TextDocument? _document;
    public TextDocument Document
    {
        get
        {
            if (_document == null)
            {
                _document = new TextDocument();
                _document.TextChanged += (s, e) =>
                {
                    OnPropertyChanged(nameof(Content));
                    ContentChanged?.Invoke(this, EventArgs.Empty);
                };
            }
            return _document;
        }
    }

    public string Content
    {
        get => Document.Text;
        set
        {
            if (Document.Text != value)
            {
                Document.Text = value;
            }
        }
    }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(LocalFilePath))]
    private IDocumentLocation? _location;

    /// <summary>
    /// 本地文件路径；云端文档为 null。
    /// 仅"本地专属"操作使用（File.Exists、按路径保存），其余一律走 <see cref="Location"/>。
    /// </summary>
    public string? LocalFilePath => Location is LocalDocumentLocation local ? local.FilePath : null;

    /// <summary>
    /// 云端文档的当前版本，用于 <c>If-Match</c> 乐观锁。
    /// 仅当 <see cref="Location"/> 是 <see cref="CloudDocumentLocation"/> 时有意义。
    /// </summary>
    [ObservableProperty]
    private int? _cloudVersion;

    [ObservableProperty]
    private Bitmap? _previewImage;

    [ObservableProperty]
    private double _previewRenderScale = 1.0;

    [ObservableProperty]
    private string? _errorMessage;

    [ObservableProperty]
    private bool _hasError;

    [ObservableProperty]
    private string _webPreviewHtml = string.Empty;

    [ObservableProperty]
    private bool _isSelected;

    [ObservableProperty]
    private byte[]? _cachedPngBytes;

    /// <summary>生成 CachedPngBytes 时使用的导出倍率;-1 表示无有效缓存。</summary>
    [ObservableProperty]
    private double _cachedPngScale = -1;

    public string Title => IsModified ? $"{Header} *" : Header;

    public event EventHandler? ContentChanged;

    public void UpdateHeader()
    {
        if (Location != null)
        {
            Header = System.IO.Path.GetFileName(Location.DisplayPath);
        }
        OnPropertyChanged(nameof(Title));
    }
}
