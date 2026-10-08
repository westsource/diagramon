using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Services.Localization;

namespace Diagramon.Views;

/// <summary>
/// 「操作说明」窗口：把随包的帮助文档（<c>Assets/Help/help.&lt;lang&gt;.md</c>）读成可滚动的正文。
/// </summary>
/// <remarks>
/// <para>
/// 为什么是独立窗口而不是弹窗式对话框：帮助是要**对照着操作**看的，需要能滚动、能缩放窗口、
/// 必要时还能同时开着主界面，所以做成可调整大小的普通窗口（<see cref="AboutDialog"/> 那种"看完就关"
/// 的小对话框不适合这一档内容量）。
/// </para>
/// <para>
/// 渲染只做**极轻的结构化**：<c>## </c> 开头的行当小标题（半粗 + 上间距），<c>- </c> 开头保持条目缩进，
/// 空行留间距，其余按段落自动换行。刻意不引 Markdown 依赖 —— 文档是我们自己写的，格式约定就这两条。
/// </para>
/// </remarks>
public sealed class HelpDialog : Window
{
    private static readonly Strings S = Strings.Instance;

    public HelpDialog(string markdown)
    {
        Title = S.HelpTitle;
        Width = 680;
        Height = 640;
        MinWidth = 420;
        MinHeight = 320;
        CanResize = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        var body = new StackPanel
        {
            Margin = new Thickness(28, 24, 28, 24),
            Spacing = 2,
        };

        foreach (var rawLine in (markdown ?? string.Empty).Replace("\r\n", "\n").Split('\n'))
        {
            var line = rawLine.TrimEnd();
            if (string.IsNullOrWhiteSpace(line))
            {
                body.Children.Add(new TextBlock { Text = string.Empty, Height = 10 });
                continue;
            }

            if (line.StartsWith("## ", StringComparison.Ordinal))
            {
                body.Children.Add(new TextBlock
                {
                    Text = line[3..],
                    FontSize = 16,
                    FontWeight = FontWeight.SemiBold,
                    Margin = new Thickness(0, 14, 0, 6),
                    TextWrapping = TextWrapping.Wrap,
                });
                continue;
            }

            if (line.StartsWith("- ", StringComparison.Ordinal))
            {
                body.Children.Add(new TextBlock
                {
                    Text = "•  " + line[2..],
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(12, 0, 0, 3),
                });
                continue;
            }

            body.Children.Add(new TextBlock
            {
                Text = line,
                TextWrapping = TextWrapping.Wrap,
            });
        }

        // 文档缺失时不留白屏：给一句能解释"为什么是空的"的话
        if (body.Children.Count == 0)
        {
            body.Children.Add(new TextBlock
            {
                Text = S.HelpUnavailable,
                TextWrapping = TextWrapping.Wrap,
                Foreground = Brushes.Gray,
            });
        }

        var closeButton = new Button
        {
            Content = S.HelpClose,
            MinWidth = 88,
            IsDefault = true,
            IsCancel = true,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center,
        };
        closeButton.Click += (_, _) => Close();

        Content = new Grid
        {
            RowDefinitions = new RowDefinitions("*,Auto"),
            Children =
            {
                new ScrollViewer
                {
                    Content = body,
                    HorizontalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Disabled,
                    VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
                },
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Margin = new Thickness(24, 0, 24, 18),
                    Children = { closeButton },
                },
            },
        };
    }
}
