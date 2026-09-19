using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;

namespace Diagramon.Models;

public partial class RecentFileItem : ObservableObject
{
    public IDocumentLocation Location { get; }

    public string FileName => Path.GetFileName(Location.DisplayPath);

    /// <summary>本地路径或云端文档名，用于菜单项的悬停提示。</summary>
    public string DisplayPath => Location.DisplayPath;

    public RecentFileItem(IDocumentLocation location)
    {
        Location = location;
    }
}
