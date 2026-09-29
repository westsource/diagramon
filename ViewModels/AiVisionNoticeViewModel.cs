using System.Linq;

using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

using Diagramon.Services.Localization;

using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;

namespace Diagramon.ViewModels;

/// <summary>
/// 「图片会上传到服务端」的首次告知（D25）。
/// </summary>
/// <remarks>
/// <para>
/// 告知的是<b>一件真实发生的事</b>：这张图会离开本机。所以文案不写"为了改善体验"这类含糊话，
/// 直接说清楚去哪、存不存、继续代表什么 —— 含糊的隐私提示等于没提示。
/// </para>
/// <para>
/// "不再提示"写进 <c>settings.json</c>：告知是"对这台机器上的这个用户说过一次"，
/// 重启再弹就是骚扰。
/// </para>
/// </remarks>
public partial class AiVisionNoticeViewModel : ViewModelBase
{
    private static readonly Strings S = Strings.Instance;

    /// <summary>用户是否点了"继续"（取消/关窗都是 false）。</summary>
    public bool Confirmed { get; private set; }

    [ObservableProperty]
    private bool _doNotAskAgain;

    public string Title => S.AiVisionNoticeTitle;
    public string Body => S.AiVisionNoticeBody;
    public string DoNotAskText => S.AiVisionNoticeDoNotAsk;
    public string ContinueButton => S.AiVisionNoticeContinue;
    public string CancelButton => S.CancelButton;

    [RelayCommand]
    private void Continue()
    {
        Confirmed = true;
        CloseDialog(true);
    }

    [RelayCommand]
    private void Cancel() => CloseDialog(false);

    private void CloseDialog(bool result)
    {
        if (Avalonia.Application.Current?.ApplicationLifetime
            is IClassicDesktopStyleApplicationLifetime lifetime
            && lifetime.Windows.FirstOrDefault(w => w is Views.AiVisionNoticeDialog) is Views.AiVisionNoticeDialog dialog)
        {
            dialog.Close(result);
        }
    }
}
