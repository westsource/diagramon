using System;
using System.Linq;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Diagramon.Services;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 登录对话框。
/// </summary>
/// <remarks>
/// <para>
/// <b>只由用户主动打开</b> —— 启动路径不得构造它（未登录是正常状态，见 §8.0 首要约束）。
/// 关闭时无论成功与否都不影响本地功能：调用方用 <see cref="Succeeded"/> 决定是否更新提示。
/// </para>
/// <para>
/// <b>注册不在客户端做</b>：「没有账号？去官网注册」**链接**直接把用户送去官网注册页（见
/// <see cref="OnRegisterOnWebClick"/>）。此前这里有一套"切到注册模式"的内嵌表单，
/// 与网页端是同一件事的第二份实现 —— 邮箱激活、重发、条款文案都要两处同步，已删除。
/// </para>
/// </remarks>
public sealed class LoginDialog : Window
{
    /// <summary>服务端错误码：账号未激活。与 <c>invalid_credentials</c> 严格区分。</summary>
    private const string ErrorCodeEmailNotVerified = "email_not_verified";

    /// <summary>窗口高度。</summary>
    private const double SignInHeight = 330;

    private static readonly Strings S = Strings.Instance;
    private static readonly IBrush ErrorBrush = new SolidColorBrush(Color.Parse("#C42B1C"));
    private static readonly IBrush InfoBrush = new SolidColorBrush(Color.Parse("#0F7B0F"));

    private readonly AuthService _auth;
    private readonly TextBox _emailBox;
    private readonly TextBox _passwordBox;

    private readonly TextBlock _errorText;
    private readonly Button _primaryButton;
    private readonly HyperlinkButton _registerLink;
    private readonly Button _resendButton;

    private readonly StackPanel _formPanel;

    /// <summary>本次会话是否已登录成功。</summary>
    public bool Succeeded => _auth.Session.IsSignedIn;

    public LoginDialog(AuthService auth)
    {
        _auth = auth;

        Title = S.AuthTitle;
        Width = 440;
        Height = SignInHeight;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        _emailBox = new TextBox { Watermark = S.AuthEmail, Margin = new Thickness(0, 0, 0, 12) };
        _passwordBox = new TextBox { PasswordChar = '•', Watermark = S.AuthPassword, Margin = new Thickness(0, 0, 0, 12) };
        _errorText = new TextBlock { Foreground = ErrorBrush, TextWrapping = TextWrapping.Wrap, IsVisible = false, Margin = new Thickness(0, 0, 0, 8) };

        // 页脚这一行要能装下四个控件（链接 + 重发 + 登录 + 取消）而对话框只有 440 宽：谁都不设 MinWidth，
        // 一切按内容自适应 —— 定了最小值就会在"邮箱未激活"那个状态下把某个控件挤出窗口（见行尾注释）。
        _primaryButton = new Button
        {
            Content = S.AuthSignIn,
            IsDefault = true,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _primaryButton.Click += OnPrimaryClick;

        // 注册是**跳去另一个地方**的导航动作，不是这个对话框自己的动作者：所以是链接而不是
        // 第三个按钮 —— 否则「去注册」看起来与「登录 / 取消」平级，用户会以为点它会在这里完成注册。
        // 用 HyperlinkButton 而不是 TextBlock：它仍是 Button（键盘可达、有 IsEnabled、主题自带链接外观）。
        // 纵向**与按钮同框同一中心**：Stretch 让它撑到按钮行的高度，再去掉主题给链接模板的 1px 边框 ——
        // 那圈边框会把链接文字整体下压 1px，于是三个控件同框而文字不共线（实测 textCenter 294 vs 295）。
        _registerLink = new HyperlinkButton
        {
            Content = S.AuthRegisterOnWeb,
            Padding = new Thickness(0),
            BorderThickness = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
        };
        _registerLink.Click += OnRegisterOnWebClick;

        _resendButton = new Button
        {
            Content = S.AuthResend,
            IsVisible = false,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _resendButton.Click += OnResendClick;

        var closeButton = new Button
        {
            Content = S.AuthClose,
            IsCancel = true,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        closeButton.Click += (_, _) => Close();

        _emailBox.TextChanged += (_, _) => UpdatePrimaryEnabled();
        _passwordBox.TextChanged += (_, _) => UpdatePrimaryEnabled();

        _formPanel = new StackPanel
        {
            Children =
            {
                Label(S.AuthEmail),
                _emailBox,
                Label(S.AuthPassword),
                _passwordBox,
                _errorText,
            },
        };

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto"),
            Margin = new Thickness(20),
            Children =
            {
                _formPanel,
                // 页脚一行的宽度预算：内容宽 400px（440 去掉左右各 20 的 Margin），要同时装下
                // 「去注册链接 + 重发 + 登录 + 取消」——重发只在邮箱未激活时出现。四个控件都按内容自适应
                // （谁都没有 MinWidth），实测最挤的那一态占 394px；一旦有人加上最小值，就会把行尾的
                // 取消挤出窗口（链接 140 / 重发 130 / 登录 46 / 取消 46 + 三个 8px 间距 + 链接 8px 右边距）。
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 8,
                    Margin = new Thickness(0, 16, 0, 0),
                    Children = { _registerLink, _resendButton, _primaryButton, closeButton },
                },
            },
        };

        UpdatePrimaryEnabled();
        Opened += (_, _) => _emailBox.Focus();
    }

    private static TextBlock Label(string text) => new()
    {
        Text = text,
        FontSize = 13,
        Margin = new Thickness(0, 0, 0, 4),
    };

    /// <summary>
    /// 「没有账号？去官网注册」→ <b>打开系统浏览器跳到官网注册页</b>。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 注册**不在客户端做**：邮箱激活、重发、以及条款/隐私文案都在网页端，
    /// 客户端再实现一份就是第三个要同步的地方（服务端 / 网页 / 桌面端）。
    /// </para>
    /// <para>
    /// 地址**由配置的服务端地址推导**（<see cref="AuthService.ServiceSiteUrl"/> + <c>/register</c>），
    /// 不硬编码域名 —— 联调、私有部署、自建换服务器时这个链接自动跟着走。
    /// </para>
    /// <para>
    /// 打不开浏览器时**把地址显示出来**让用户自己复制：静默失败等于按了没反应。
    /// </para>
    /// </remarks>
    private async void OnRegisterOnWebClick(object? sender, RoutedEventArgs e)
    {
        var url = $"{_auth.ServiceSiteUrl}/register";

        try
        {
            var launcher = TopLevel.GetTopLevel(this)?.Launcher;
            if (launcher is not null && await launcher.LaunchUriAsync(new Uri(url)))
            {
                return;
            }

            ShowError(string.Format(S.AuthRegisterOpenFailedFormat, url));
        }
        catch (Exception ex)
        {
            // 例如系统没有默认浏览器 / 关联被劫持：把地址与原因一起给出来
            ShowError($"{string.Format(S.AuthRegisterOpenFailedFormat, url)}（{ex.Message}）");
        }
    }

    /// <summary>空输入直接禁用主按钮 —— 这是可用性提示，不是校验（密码规则以服务端为准，避免两端漂移）。</summary>
    private void UpdatePrimaryEnabled()
    {
        _primaryButton.IsEnabled = HasInput();
    }

    private bool HasInput() =>
        !string.IsNullOrWhiteSpace(_emailBox.Text) && !string.IsNullOrEmpty(_passwordBox.Text);

    private async void OnPrimaryClick(object? sender, RoutedEventArgs e)
    {
        var email = _emailBox.Text?.Trim() ?? string.Empty;
        var password = _passwordBox.Text ?? string.Empty;
        if (email.Length == 0 || password.Length == 0) return;

        // **登录不做任何前置校验**：客户端拦一次就多一条会与服务端漂移的规则，
        // 而规则一漂移就会出现"本地拦住了服务端本来接受的输入"——用户连明确错误都拿不到。
        SetBusy(true);

        try
        {
            if (await _auth.LoginAsync(email, password))
            {
                Close();
                return;
            }

            // 未激活是**可以自救**的失败：密码没错，只是没点邮件里的链接。
            // 给出重发入口，否则用户只会一直重试密码。
            if (_auth.LastErrorCode == ErrorCodeEmailNotVerified)
            {
                _resendButton.IsVisible = true;
            }

            ShowError(DescribeError(_auth.LastErrorCode));
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnResendClick(object? sender, RoutedEventArgs e)
    {
        var email = _emailBox.Text?.Trim() ?? string.Empty;
        if (email.Length == 0) return;

        SetBusy(true);

        try
        {
            // 服务端恒返回 204：成功只代表"请求已受理"，**不代表邮件确实发出去了**，
            // 因此文案不承诺"已发往该邮箱"。
            if (await _auth.ResendVerificationAsync(email))
            {
                ShowInfo(S.AuthResent);
            }
            else
            {
                ShowError(DescribeError(_auth.LastErrorCode));
            }
        }
        finally
        {
            SetBusy(false);
        }
    }



    private void SetBusy(bool busy)
    {
        _emailBox.IsEnabled = !busy;
        _passwordBox.IsEnabled = !busy;
        _registerLink.IsEnabled = !busy;
        _resendButton.IsEnabled = !busy;

        _primaryButton.Content = busy ? S.AuthWorking : S.AuthSignIn;
        _primaryButton.IsEnabled = !busy && HasInput();

        if (busy)
        {
            HideError();
        }
    }

    private void ShowError(string message) => ShowMessage(message, ErrorBrush);

    private void ShowInfo(string message) => ShowMessage(message, InfoBrush);

    private void ShowMessage(string message, IBrush brush)
    {
        _errorText.Foreground = brush;
        _errorText.Text = message;
        _errorText.IsVisible = true;
    }

    private void HideError()
    {
        _errorText.IsVisible = false;
        _errorText.Text = null;
    }

    /// <summary>
    /// 把服务端错误码映射成本地化文案；<c>validation_error</c> 再按 <c>details.fields</c> 细化。
    /// </summary>
    /// <remarks>
    /// 服务端在 422 里已经指明了是哪个字段出错，但单看 <c>validation_error</c> 分不出
    /// "邮箱格式错"还是别的。不细化的话用户只能看到笼统的"输入不合法"，不知道改哪里。
    /// </remarks>
    private string DescribeError(string? code)
    {
        if (code == "validation_error" && _auth.LastErrorFields.Contains("email"))
        {
            return S.AuthErrorEmailFormat;
        }

        if (code == "weak_password")
        {
            // 服务端按分支只给**一个**边界值：给 maxLength 即"过长"，给 minLength 即"过短"。
            // 文案带服务端给的数字，而不是硬编码的"至少 8 位"——硬编码在规则变动后会说谎。
            if (_auth.LastErrorMaxLength is { } maxLength)
            {
                return string.Format(S.AuthErrorPasswordTooLongFormat, maxLength);
            }

            if (_auth.LastErrorMinLength is { } minLength)
            {
                return string.Format(S.AuthErrorPasswordTooShortFormat, minLength);
            }

            return S.AuthErrorWeakPassword;   // 服务端没带数值：退回不带数字的通用文案
        }

        return code switch
        {
            "invalid_credentials" => S.AuthErrorInvalidCredentials,
            ErrorCodeEmailNotVerified => S.AuthErrorEmailNotVerified,
            "email_taken" or "phone_taken" => S.AuthErrorEmailTaken,
            "rate_limited" => S.AuthErrorRateLimited,
            "validation_error" => S.AuthErrorValidation,
            ApiClient.NetworkError => S.AuthErrorNetwork,
            _ => S.AuthErrorGeneric,
        };
    }
}
