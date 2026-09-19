using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Services.Localization;

namespace Diagramon.Views;

public enum SaveChangesDialogResult
{
    Cancel = 0,
    Save = 1,
    DontSave = 2
}

public sealed class SaveChangesDialog : Window
{
    private static readonly Strings S = Strings.Instance;

    public SaveChangesDialog(string tabTitle)
    {
        Title = S.SaveChangesTitle;
        Width = 420;
        Height = 160;
        CanResize = false;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        var message = new TextBlock
        {
            Text = string.Format(S.SaveChangesMessage, tabTitle),
            TextWrapping = TextWrapping.Wrap,
            FontSize = 14
        };

        var saveButton = CreateButton(S.SaveButton, true, (_, _) => Close(SaveChangesDialogResult.Save));
        var dontSaveButton = CreateButton(S.DontSaveButton, false, (_, _) => Close(SaveChangesDialogResult.DontSave));
        var cancelButton = CreateButton(S.CancelButton, false, (_, _) => Close(SaveChangesDialogResult.Cancel));

        Content = new Grid
        {
            RowDefinitions = RowDefinitions.Parse("*,Auto"),
            Margin = new Thickness(20, 20, 20, 16),
            Children =
            {
                message,
                new StackPanel
                {
                    [Grid.RowProperty] = 1,
                    Orientation = Orientation.Horizontal,
                    HorizontalAlignment = HorizontalAlignment.Right,
                    Margin = new Thickness(0, 16, 0, 0),
                    Spacing = 8,
                    Children =
                    {
                        saveButton,
                        dontSaveButton,
                        cancelButton
                    }
                }
            }
        };
    }

    private static Button CreateButton(string text, bool isDefault, EventHandler<RoutedEventArgs> onClick)
    {
        var button = new Button
        {
            Content = text,
            MinWidth = 88,
            IsDefault = isDefault,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            VerticalContentAlignment = VerticalAlignment.Center
        };
        button.Click += onClick;
        return button;
    }
}
