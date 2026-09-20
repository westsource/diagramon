using System;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using Diagramon.Services.Localization;

namespace Diagramon.Models;

public partial class RecentFileItem : ObservableObject
{
    /// <summary>本地文件或云端文档的位置；「更多...」条目没有位置。</summary>
    public IDocumentLocation? Location { get; }

    [ObservableProperty]
    private DateTime _lastOpenedTime;

    public string FileName => Location == null ? string.Empty : Path.GetFileName(Location.DisplayPath);

    public string DisplayName => IsMoreItem ? Strings.Instance.MenuRecentFilesMore : FileName;

    public bool IsMoreItem { get; init; }

    public RecentFileItem()
    {
    }

    /// <summary>本地路径或云端文档名，用于菜单项的悬停提示。</summary>
    public string DisplayPath => Location?.DisplayPath ?? string.Empty;

    public RecentFileItem(IDocumentLocation location)
    {
        Location = location;
    }

    public static RecentFileItem CreateMoreItem() => new() { IsMoreItem = true };
}

public class RecentFileEntry
{
    public string FilePath { get; set; } = string.Empty;
    public DateTime LastOpenedTime { get; set; }
}
