using System;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Services;
using Diagramon.Services.Localization;
using Diagramon.Services.Remote;

namespace Diagramon.Views;

/// <summary>
/// 登录 / 注册对话框。
/// </summary>
/// <remarks>
/// <b>只由用户主动打开</b> —— 启动路径不得构造它（未登录是正常状态，见 §8.0 首要约束）。
/// 关闭时无论成功与否都不影响本地功能：调用方用 <see cref="Succeeded"/> 决定是否更新提示。
/// </remarks>
public sealed class LoginDialog : Window
{
    /// <summary>服务端错误码：账号未激活。与 <c>invalid_credentials</c> 严格区分。</summary>
    private const string ErrorCodeEmailNotVerified = "email_not_verified";

    private static readonly Strings S = Strings.Instance;
    private static readonly IBrush ErrorBrush = new SolidColorBrush(Color.Parse("#C42B1C"));
    private static readonly IBrush InfoBrush = new SolidColorBrush(Color.Parse("#0F7B0F"));

    private readonly AuthService _auth;
    private readonly TextBox _emailBox;
    private readonly TextBox _passwordBox;
    private readonly TextBlock _errorText;
    private readonly Button _primaryButton;
    private readonly Button _switchButton;
    private readonly Button _resendButton;

    /// <summary>注册后"待邮箱激活"面板：替换掉整个表单区（此时表单已无事可做）。</summary>
    private readonly StackPanel _formPanel;
    private readonly StackPanel _pendingPanel;
    private readonly TextBlock _pendingBody;
    private readonly TextBlock _pendingTtl;

    private bool _isRegisterMode;

    /// <summary>是否停在"待激活"状态。用于让 <see cref="SetBusy"/> 不去复活已隐藏的主按钮。</summary>
    private bool _pendingMode;

    /// <summary>本次会话是否已通过登录/注册进入已登录态。</summary>
    public bool Succeeded => _auth.Session.IsSignedIn;

    public LoginDialog(AuthService auth)
    {
        _auth = auth;

        Title = S.AuthTitle;
        Width = 440;
        Height = 330;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        _emailBox = new TextBox { Watermark = S.AuthEmail, Margin = new Thickness(0, 0, 0, 12) };
        _passwordBox = new TextBox { PasswordChar = '•', Watermark = S.AuthPassword, Margin = new Thickness(0, 0, 0, 12) };
        _errorText = new TextBlock { Foreground = ErrorBrush, TextWrapping = TextWrapping.Wrap, IsVisible = false, Margin = new Thickness(0, 0, 0, 8) };

        _primaryButton = new Button
        {
            Content = S.AuthSignIn,
            MinWidth = 110,
            IsDefault = true,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _primaryButton.Click += OnPrimaryClick;

        _switchButton = new Button
        {
            Content = S.AuthSwitchToRegister,
            MinWidth = 150,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _switchButton.Click += (_, _) => ToggleMode();

        _resendButton = new Button
        {
            Content = S.AuthResend,
            MinWidth = 150,
            IsVisible = false,
            HorizontalContentAlignment = HorizontalAlignment.Center,
        };
        _resendButton.Click += OnResendClick;

        var closeButton = new Button
        {
            Content = S.AuthClose,
            MinWidth = 88,
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

        _pendingBody = new TextBlock { TextWrapping = TextWrapping.Wrap };
        _pendingTtl = new TextBlock { IsVisible = false, Opacity = 0.7, TextWrapping = TextWrapping.Wrap };
        _pendingPanel = new StackPanel
        {
            IsVisible = false,
            Spacing = 6,
            Children =
            {
                new TextBlock { Text = S.AuthPendingTitle, FontWeight = FontWeight.SemiBold },
                _pendingBody,
                _pendingTtl,
            },
        };

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto"),
            Margin = new Thickness(20),
            Children =
            {
                _formPanel,
                _pendingPanel,
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Spacing = 8,
                    Margin = new Thickness(0, 16, 0, 0),
                    Children = { closeButton, _switchButton, _resendButton, _primaryButton },
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

    private void ToggleMode()
    {
        _isRegisterMode = !_isRegisterMode;
        _primaryButton.Content = _isRegisterMode ? S.AuthRegister : S.AuthSignIn;
        _switchButton.Content = _isRegisterMode ? S.AuthSwitchToSignIn : S.AuthSwitchToRegister;
        HideError();
    }

    /// <summary>空输入直接禁用主按钮 —— 这是可用性提示，不是校验（口令规则以服务端为准，避免两端漂移）。</summary>
    private void UpdatePrimaryEnabled()
    {
        _primaryButton.IsEnabled = !_pendingMode && HasInput();
    }

    private bool HasInput() =>
        !string.IsNullOrWhiteSpace(_emailBox.Text) && !string.IsNullOrEmpty(_passwordBox.Text);

    private async void OnPrimaryClick(object? sender, RoutedEventArgs e)
    {
        var email = _emailBox.Text?.Trim() ?? string.Empty;
        var password = _passwordBox.Text ?? string.Empty;
        if (email.Length == 0 || password.Length == 0) return;

        SetBusy(true);

        try
        {
            if (_isRegisterMode)
            {
                var result = await _auth.RegisterAsync(email, password);
                switch (result.Outcome)
                {
                    case RegisterOutcome.Active:
                        Close();
                        return;
                    case RegisterOutcome.PendingVerification:
                        EnterPendingMode(result);
                        return;
                    default:
                        ShowError(DescribeError(_auth.LastErrorCode));
                        return;
                }
            }

            if (await _auth.LoginAsync(email, password))
            {
                Close();
                return;
            }

            // 未激活是**可以自救**的失败：口令没错，只是没点邮件里的链接。
            // 给出重发入口，否则用户只会一直重试口令。
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

    /// <summary>切到"待邮箱激活"状态：表单已无事可做，整块换成去邮箱的指引。</summary>
    private void EnterPendingMode(RegisterResult result)
    {
        _pendingMode = true;

        var masked = string.IsNullOrEmpty(result.EmailMasked)
            ? _emailBox.Text?.Trim() ?? string.Empty
            : result.EmailMasked;
        _pendingBody.Text = string.Format(S.AuthPendingBodyFormat, masked);

        if (result.VerifyTtlSeconds is > 0)
        {
            _pendingTtl.Text = string.Format(S.AuthPendingTtlFormat, result.VerifyTtlSeconds.Value / 60);
            _pendingTtl.IsVisible = true;
        }

        _formPanel.IsVisible = false;
        _pendingPanel.IsVisible = true;
        _primaryButton.IsVisible = false;
        _switchButton.IsVisible = false;
        _resendButton.IsVisible = true;
        HideError();

        // 表单区换成指引后需要多一点竖向空间
        Height = 380;
    }

    private void SetBusy(bool busy)
    {
        _emailBox.IsEnabled = !busy;
        _passwordBox.IsEnabled = !busy;
        _switchButton.IsEnabled = !busy;
        _resendButton.IsEnabled = !busy;

        // 待激活状态下主按钮已隐藏，别在这里把它复活
        if (!_pendingMode)
        {
            _primaryButton.Content = busy
                ? S.AuthWorking
                : _isRegisterMode ? S.AuthRegister : S.AuthSignIn;
            _primaryButton.IsEnabled = !busy && HasInput();
        }

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

    /// <summary>把服务端的线上错误码映射成本地化文案。未知码一律落到通用文案。</summary>
    private static string DescribeError(string? code) => code switch
    {
        "invalid_credentials" => S.AuthErrorInvalidCredentials,
        ErrorCodeEmailNotVerified => S.AuthErrorEmailNotVerified,
        "email_taken" or "phone_taken" => S.AuthErrorEmailTaken,
        "weak_password" => S.AuthErrorWeakPassword,
        "rate_limited" => S.AuthErrorRateLimited,
        "validation_error" => S.AuthErrorValidation,
        ApiClient.NetworkError => S.AuthErrorNetwork,
        _ => S.AuthErrorGeneric,
    };
}
