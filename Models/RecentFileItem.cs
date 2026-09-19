using System;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using Diagramon.Services.Localization;

namespace Diagramon.Models;

public partial class RecentFileItem : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(FileName))]
    [NotifyPropertyChangedFor(nameof(DisplayName))]
    private string? _filePath;

    [ObservableProperty]
    private DateTime _lastOpenedTime;

    public string FileName => FilePath != null ? Path.GetFileName(FilePath) : string.Empty;

    public string DisplayName => IsMoreItem ? Strings.Instance.MenuRecentFilesMore : FileName;

    public bool IsMoreItem { get; init; }

    public RecentFileItem()
    {
    }

    public RecentFileItem(string filePath)
    {
        _filePath = filePath;
    }

    public static RecentFileItem CreateMoreItem() => new() { IsMoreItem = true };
}

public class RecentFileEntry
{
    public string FilePath { get; set; } = string.Empty;
    public DateTime LastOpenedTime { get; set; }
}
