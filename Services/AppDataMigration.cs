using System;
using System.Diagnostics;
using System.IO;

namespace Diagramon.Services;

/// <summary>
/// 一次性迁移：把旧产品名（Mermaider）留下的本地数据搬进新目录（Diagramon）。
/// </summary>
/// <remarks>
/// <para>
/// <b>为什么需要</b>：改名后 <c>%APPDATA%</c> / <c>%LOCALAPPDATA%</c> 下的目录名一并改变。
/// 不迁移的话，老用户会「设置全丢 + 被静默登出」——<c>secure.config</c> 里存着 refresh token。
/// </para>
/// <para>
/// <b>为什么能安全照搬</b>：<c>secure.config</c> 用 DPAPI 加密，密钥由 Windows 按当前用户账户派生，
/// <b>与文件路径无关</b>，因此整目录复制后仍能解密。
/// </para>
/// <para>
/// <b>只做一次</b>：新目录一旦存在就完全不碰——否则旧数据会被反复灌回去、覆盖新状态。
/// 旧的 <c>Mermaider</c> 目录<b>保留不删</b>：降级回旧版本时还能用，而且删除用户数据不该由程序擅自决定。
/// </para>
/// </remarks>
public static class AppDataMigration
{
    /// <summary>旧目录名（改名前的产品名）。</summary>
    public const string LegacyFolderName = "Mermaider";

    /// <summary>当前目录名。</summary>
    public const string CurrentFolderName = "Diagramon";

    /// <summary>
    /// 在**任何**路径被读取之前调用（<see cref="Program.Main"/> 的第一句）。
    /// </summary>
    public static void Run()
    {
        Migrate(Environment.SpecialFolder.ApplicationData);
        Migrate(Environment.SpecialFolder.LocalApplicationData);
    }

    private static void Migrate(Environment.SpecialFolder scope)
    {
        try
        {
            var root = Environment.GetFolderPath(scope);
            if (string.IsNullOrEmpty(root))
            {
                return;
            }

            var legacy = Path.Combine(root, LegacyFolderName);
            var current = Path.Combine(root, CurrentFolderName);

            // 新目录已在、或压根没有旧数据 → 什么都不做
            if (Directory.Exists(current) || !Directory.Exists(legacy))
            {
                return;
            }

            CopyDirectory(legacy, current);
        }
        catch (Exception ex)
        {
            // 迁移失败不能让应用起不来：最坏就是退回「设置丢失 + 需重新登录」，
            // 与完全不迁移的结果相同，因此这里刻意吞掉异常。
            Debug.WriteLine($"AppData 迁移失败（scope={scope}）：{ex}");
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);

        foreach (var file in Directory.GetFiles(source))
        {
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), overwrite: false);
        }

        foreach (var directory in Directory.GetDirectories(source))
        {
            CopyDirectory(directory, Path.Combine(destination, Path.GetFileName(directory)));
        }
    }
}
