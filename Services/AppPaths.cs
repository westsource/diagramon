using System;
using System.IO;
using System.Linq;

namespace Diagramon.Services;

/// <summary>
/// 应用根与 <c>tools/</c> 的定位（方案 §4.4「路径解析」）。
/// </summary>
/// <remarks>
/// 开发期运行时目录是 <c>bin/&lt;Config&gt;/net10.0</c>、发布期是程序旁，两者与 <c>tools/</c>
/// 的相对深度不同，所以按候选项逐个回退。**所有需要 <c>tools/</c> 下资源的组件都必须走这里**
/// （mmdc、Graphviz WASM、drawio），不要再各写一份回退列表。
/// </remarks>
public static class AppPaths
{
    /// <summary>当前程序所在目录。</summary>
    public static string BaseDirectory => AppContext.BaseDirectory;

    /// <summary>按优先级列出的 <c>tools/</c> 候选目录（不保证存在）。</summary>
    private static string[] ToolsDirectories()
    {
        var appDir = BaseDirectory;
        return
        [
            Path.Combine(appDir, "tools"),
            Path.Combine(appDir, "..", "..", "..", "tools"),
            Path.Combine(appDir, "..", "..", "..", "..", "..", "tools"),
        ];
    }

    /// <summary>在 <c>tools/</c> 下按相对路径查找文件；找不到返回 <c>null</c>。</summary>
    public static string? FindInTools(params string[] relativeParts)
    {
        foreach (var root in ToolsDirectories())
        {
            var candidate = Path.Combine([root, .. relativeParts]);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>在 <c>tools/</c> 下按相对路径查找目录；找不到返回 <c>null</c>。</summary>
    public static string? FindToolsDirectory(params string[] relativeParts)
    {
        foreach (var root in ToolsDirectories())
        {
            var candidate = Path.Combine([root, .. relativeParts]);
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }
}