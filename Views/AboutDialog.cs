using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Services.Localization;

namespace Diagramon.Views;

public sealed class AboutDialog : Window
{
    private static readonly Strings S = Strings.Instance;

    public AboutDialog(string appName, string features, string author, string version)
    {
        Title = S.AboutTitle;
        Width = 460;
        // 高度由内容决定，不写死：功能描述是一段会换行的长文（中文 6 行、英文更长），
        // 且整串文案与功能同步改动——写死高度就会在文字变长时把「确定」挤出窗口底边。
        // 宽度仍固定（460 与 340 的文字列宽配套），只有高度跟着内容走。
        SizeToContent = SizeToContent.Height;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        Content = new StackPanel
        {
            Margin = new Thickness(24),
            Spacing = 14,
            Children =
            {
                new TextBlock
                {
                    Text = appName,
                    FontSize = 24,
                    FontWeight = FontWeight.SemiBold
                },
                CreateInfoLine(S.AboutFeatures, features),
                CreateInfoLine(S.AboutAuthor, author),
                CreateInfoLine(S.AboutVersion, version),
                new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Margin = new Thickness(0, 8, 0, 0),
                    Children =
                    {
                        CreateButton(S.AboutOK, (_, _) => Close())
                    }
                }
            }
        };
    }

    private static Control CreateInfoLine(string label, string value)
    {
        return new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 8,
            Children =
            {
                new TextBlock
                {
                    Text = $"{label}:",
                    Width = 48,
                    FontWeight = FontWeight.Medium
                },
                new TextBlock
                {
                    Text = value,
                    TextWrapping = TextWrapping.Wrap,
                    Width = 340
                }
            }
        };
    }

    private static Button CreateButton(string text, EventHandler<RoutedEventArgs> onClick)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 88,
            IsDefault = true,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center
        };
        button.Click += onClick;
        return button;
    }
}
