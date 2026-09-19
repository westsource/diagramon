using System.IO;

namespace Diagramon.Models;

public class MermaidDocument
{
    public string Content { get; set; } = string.Empty;
    public string? FilePath { get; set; }
    public string FileName => FilePath != null ? Path.GetFileName(FilePath) : "未命名.mmd";
    public bool IsModified { get; set; }
    public string Title => IsModified ? $"{FileName} *" : FileName;
}
