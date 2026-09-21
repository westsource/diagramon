using System;
using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using AvaloniaWebView;

namespace Diagramon.Services.Embedded;

/// <summary>
/// <see cref="WebView"/>（WebView.Avalonia）的反射封装：导航与脚本执行。
/// </summary>
/// <remarks>
/// <para>
/// 为什么用反射：该包装层的公开面在不同版本间不一致（预览那边已经这么干了，见
/// <c>MainWindow.EnsureWebViewReady</c>），直接按编译期类型调用会随包升级而断。
/// 这里把"找成员"集中到一处，只暴露我们真正需要的能力。
/// </para>
/// <para>
/// <b>只做导航与执行脚本</b>：C# → 页面的消息投递走"执行一段 JS"（已验证可用），
/// drawio → C# 走轮询承载页里的队列 —— 这样不依赖包装层是否暴露消息事件/PostWebMessage API。
/// </para>
/// </remarks>
internal sealed class WebViewBridge
{
    private readonly WebView _control;
    private readonly MethodInfo? _navigateMethod;
    private readonly PropertyInfo? _sourceProperty;
    private readonly PropertyInfo? _urlProperty;
    private readonly MethodInfo? _executeScriptMethod;

    public WebViewBridge()
    {
        _control = new WebView();
        var type = _control.GetType();
        const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

        _navigateMethod = type.GetMethod("Navigate", flags);
        _sourceProperty = type.GetProperty("Source", flags);
        _urlProperty = type.GetProperty("Url", flags);
        _executeScriptMethod = type.GetMethod("ExecuteScriptAsync", flags);

        _control.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
        _control.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
    }

    /// <summary>把 WebView 挂进容器（重复调用无副作用）。</summary>
    public void AttachTo(Border container)
    {
        if (ReferenceEquals(container.Child, _control))
        {
            return;
        }

        container.Child = null;
        container.Child = _control;
    }

    /// <summary>导航到指定 URL（<c>http://127.0.0.1:&lt;端口&gt;/drawio/host.html</c>）。</summary>
    public void Navigate(string url)
    {
        var uri = new Uri(url);

        if (_navigateMethod != null)
        {
            var parameters = _navigateMethod.GetParameters();
            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(string))
            {
                _navigateMethod.Invoke(_control, [url]);
                return;
            }

            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(Uri))
            {
                _navigateMethod.Invoke(_control, [uri]);
                return;
            }
        }

        foreach (var property in new[] { _sourceProperty, _urlProperty })
        {
            if (property == null)
            {
                continue;
            }

            if (property.PropertyType == typeof(Uri))
            {
                property.SetValue(_control, uri);
                return;
            }

            if (property.PropertyType == typeof(string))
            {
                property.SetValue(_control, url);
                return;
            }
        }

        throw new InvalidOperationException("当前 WebView 版本不支持可用导航方式（Navigate/Source/Url）。");
    }

    /// <summary>执行脚本并取回原始返回值（WebView2 会把返回值 JSON 序列化）。失败返回 <c>null</c>。</summary>
    public async Task<string?> ExecuteScriptAsync(string script)
    {
        if (_executeScriptMethod == null)
        {
            return null;
        }

        try
        {
            var invocation = _executeScriptMethod.Invoke(_control, [script]);

            if (invocation is Task<string> typed)
            {
                return await typed;
            }

            if (invocation is Task task)
            {
                await task;
                return task.GetType().GetProperty("Result")?.GetValue(task) as string;
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[drawio] 执行脚本失败: {ex.Message}");
        }

        return null;
    }

    /// <summary>
    /// 执行脚本并把返回值按「字符串值」解码。
    /// </summary>
    /// <remarks>
    /// WebView2 的 <c>ExecuteScriptAsync</c> 返回的是**返回值的 JSON 编码**：返回字符串时会再包一层引号并转义
    /// （方案 §4.5 警告的"双重编码"）。不解这一层，后续 <c>JsonSerializer.Deserialize&lt;List&lt;string&gt;&gt;</c>
    /// 会直接抛错 → 事件被静默丢弃。数字/布尔返回值没有这一层，所以两种形状都要容忍。
    /// </remarks>
    public async Task<string?> ExecuteStringScriptAsync(string script)
    {
        var raw = await ExecuteScriptAsync(script);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!raw.StartsWith('"'))
        {
            return raw;
        }

        try
        {
            return JsonSerializer.Deserialize<string>(raw) ?? raw;
        }
        catch
        {
            return raw;
        }
    }

    /// <summary>当前是否已经挂进可视树（未挂时 <c>Bounds</c> 为 0，导航会失败）。</summary>
    public bool IsAttached => _control.Bounds.Width > 0 && _control.Bounds.Height > 0;

    public bool IsVisible
    {
        get => _control.IsVisible;
        set => _control.IsVisible = value;
    }

    /// <summary>WebView 挂进可视树后回调（宿主据此开始轮询/导航）。</summary>
    /// <remarks>
    /// **必须先订阅再设 <c>Child</c>**：容器若已在可视树上，设置 <c>Child</c> 会立刻触发
    /// <c>AttachedToVisualTree</c>，先设后订阅就会永远等不到那次事件。已经挂载的情况也补一次回调。
    /// </remarks>
    public void OnAttached(Action callback)
    {
        _control.AttachedToVisualTree += (_, _) => Dispatcher.UIThread.Post(callback, DispatcherPriority.Background);

        if (_control.IsAttachedToVisualTree())
        {
            Dispatcher.UIThread.Post(callback, DispatcherPriority.Background);
        }
    }
}
