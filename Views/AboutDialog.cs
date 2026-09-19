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
        Height = 300;
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
