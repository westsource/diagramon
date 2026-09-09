using System;
using CommunityToolkit.Mvvm.ComponentModel;
using Avalonia.Media.Imaging;
using AvaloniaEdit.Document;

namespace Mermaider.Models;

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
    private string? _filePath;

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
        if (FilePath != null)
        {
            Header = System.IO.Path.GetFileName(FilePath);
        }
        OnPropertyChanged(nameof(Title));
    }
}
