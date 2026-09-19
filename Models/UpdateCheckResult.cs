namespace Diagramon.Models;

public class UpdateCheckResult
{
    public bool HasUpdate { get; set; }
    public string? LatestVersion { get; set; }
    public string? DownloadUrl { get; set; }
    public string? ReleaseNotes { get; set; }
    public string? ZipFileName { get; set; }
    public long ZipFileSize { get; set; }
    public string? PublishedAt { get; set; }
}
