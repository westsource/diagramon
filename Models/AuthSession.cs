using CommunityToolkit.Mvvm.ComponentModel;

namespace Diagramon.Models;

/// <summary>
/// 会话状态。
/// </summary>
/// <remarks>
/// <b>只有两态</b>，且两态下本地功能都完整可用 —— **未登录是启动默认态，不是异常**。
/// 令牌不存在 / 过期 / 被吊销，对用户呈现为同一个状态：未登录。
/// </remarks>
public partial class AuthSession : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsSignedIn))]
    [NotifyPropertyChangedFor(nameof(IsCloudEntryVisible))]
    [NotifyPropertyChangedFor(nameof(DisplayName))]
    private UserDto? _user;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCloudStorage))]
    private MembershipDto? _membership;

    /// <summary>
    /// 来自 <c>GET /v1/config</c> 的 <c>featureFlags.cloudEnabled</c>。
    /// 只在成功取到配置时更新 —— 取不到配置不应该把已知的开关翻回去。
    /// </summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsCloudEntryVisible))]
    private bool _cloudEnabled;

    public bool IsSignedIn => User != null;

    /// <summary>
    /// 云端入口是否可见。契约：**登录态 AND featureFlags.cloudEnabled** ——
    /// 不是网络可用性，也不是服务端可达性。
    /// </summary>
    public bool IsCloudEntryVisible => IsSignedIn && CloudEnabled;

    /// <summary>是否已获得云端存储权益。免费计划 <c>cloudStorage=false</c>，此时入口可见但动作应提示升级。</summary>
    public bool HasCloudStorage => Membership?.CloudStorage == true;

    public string DisplayName => User?.DisplayName ?? User?.Email ?? User?.Phone ?? string.Empty;

    /// <summary>回到未登录态（不是错误态）。</summary>
    public void Clear()
    {
        User = null;
        Membership = null;
    }
}
