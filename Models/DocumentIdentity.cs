using System.IO;

namespace Diagramon.Models;

public static class DocumentIdentity
{
    /// <summary>
    /// 把文件路径规范化为稳定身份。
    /// </summary>
    /// <remarks>
    /// 实现必须与 <c>Services/AIConversationService.ComputeFileHash</c> 中的规范化逐字符一致
    /// （<c>Path.GetFullPath(path).ToLowerInvariant()</c>，非法路径返回 null 而不抛），
    /// 否则已有 AI 会话文件会全部失联。
    /// </remarks>
    public static string? Normalize(string? filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath))
        {
            return null;
        }

        try
        {
            return Path.GetFullPath(filePath).ToLowerInvariant();
        }
        catch
        {
            return null;
        }
    }
}
