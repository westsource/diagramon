using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Diagramon.Models;
using Diagramon.Services.Localization;

namespace Diagramon.Views;

public sealed class RecentHistoryDialog : Window
{
    private static readonly Strings S = Strings.Instance;
    private readonly ListBox _listBox;
    private readonly TextBox _searchBox;
    private readonly TextBlock _noResultsText;
    private readonly List<HistoryListItem> _allItems;

    public RecentHistoryDialog(List<RecentFileEntry> history)
    {
        Title = S.RecentHistoryTitle;
        Width = 680;
        Height = 460;
        CanResize = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        MinWidth = 400;
        MinHeight = 250;

        var headerText = new TextBlock
        {
            Text = S.RecentHistoryTitle,
            FontSize = 18,
            FontWeight = FontWeight.SemiBold,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 0, 8)
        };

        // Build the full list of items
        _allItems = history.Select(e => new HistoryListItem
        {
            FilePath = e.FilePath,
            FileName = Path.GetFileName(e.FilePath),
            LastOpenedDisplay = e.LastOpenedTime.ToString("yyyy-MM-dd HH:mm:ss")
        }).ToList();

        // Search text box
        _searchBox = new TextBox
        {
            Watermark = S.RecentHistorySearchPlaceholder,
            Margin = new Thickness(0, 0, 0, 8)
        };
        _searchBox.TextChanged += OnSearchTextChanged;

        // "No results" label (hidden by default)
        _noResultsText = new TextBlock
        {
            Text = S.RecentHistorySearchNoResults,
            Foreground = new SolidColorBrush(Color.Parse("#888888")),
            FontSize = 13,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 24, 0, 0),
            IsVisible = false
        };

        var listGrid = new Grid
        {
            RowDefinitions = new RowDefinitions("Auto,Auto,*,Auto")
        };

        var headerRow = new Border
        {
            Background = new SolidColorBrush(Color.Parse("#F0F0F0")),
            Padding = new Thickness(12, 8),
            Child = new Grid
            {
                ColumnDefinitions = new ColumnDefinitions("*,Auto"),
                Children =
                {
                    new TextBlock
                    {
                        Text = S.RecentHistoryFileName,
                        FontWeight = FontWeight.SemiBold,
                        VerticalAlignment = VerticalAlignment.Center
                    },
                    new TextBlock
                    {
                        Text = S.RecentHistoryOpenTime,
                        FontWeight = FontWeight.SemiBold,
                        HorizontalAlignment = HorizontalAlignment.Right,
                        VerticalAlignment = VerticalAlignment.Center,
                        [Grid.ColumnProperty] = 1
                    }
                }
            }
        };
        Grid.SetRow(headerRow, 1);

        _listBox = new ListBox
        {
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent
        };
        Grid.SetRow(_listBox, 2);

        _listBox.DoubleTapped += OnListBoxDoubleTapped;

        _listBox.ItemsSource = _allItems;
        _listBox.ItemTemplate = new FuncDataTemplate<HistoryListItem>((item, _) =>
        {
            if (item == null) return null;

            var grid = new Grid
            {
                ColumnDefinitions = new ColumnDefinitions("*,Auto"),
                Margin = new Thickness(12, 6, 12, 6)
            };

            var nameBlock = new TextBlock
            {
                Text = item.FileName,
                VerticalAlignment = VerticalAlignment.Center
            };
            ToolTip.SetTip(nameBlock, item.FilePath);
            Grid.SetColumn(nameBlock, 0);

            var timeBlock = new TextBlock
            {
                Text = item.LastOpenedDisplay,
                Foreground = new SolidColorBrush(Color.Parse("#888888")),
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            Grid.SetColumn(timeBlock, 1);

            grid.Children.Add(nameBlock);
            grid.Children.Add(timeBlock);
            return grid;
        });

        // Place children in the grid rows
        Grid.SetRow(_searchBox, 0);
        listGrid.Children.Add(_searchBox);
        listGrid.Children.Add(headerRow);
        listGrid.Children.Add(_listBox);
        Grid.SetRow(_noResultsText, 3);
        listGrid.Children.Add(_noResultsText);

        var okButton = new Button
        {
            Content = S.CancelButton,
            MinWidth = 88,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            IsDefault = true
        };
        okButton.Click += (_, _) => Close();

        var rootPanel = new DockPanel
        {
            Margin = new Thickness(20, 16, 20, 16),
            LastChildFill = true
        };

        var bottomPanel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
            Children = { okButton }
        };

        DockPanel.SetDock(headerText, Dock.Top);
        DockPanel.SetDock(bottomPanel, Dock.Bottom);

        rootPanel.Children.Add(headerText);
        rootPanel.Children.Add(bottomPanel);
        rootPanel.Children.Add(listGrid);

        Content = rootPanel;
    }

    private void OnSearchTextChanged(object? sender, TextChangedEventArgs e)
    {
        var filter = _searchBox.Text?.Trim() ?? string.Empty;

        List<HistoryListItem> filtered;
        if (string.IsNullOrEmpty(filter))
        {
            filtered = _allItems;
        }
        else
        {
            filtered = _allItems
                .Where(item =>
                    item.FileName.Contains(filter, StringComparison.OrdinalIgnoreCase) ||
                    item.FilePath.Contains(filter, StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        _listBox.ItemsSource = filtered;
        _noResultsText.IsVisible = filtered.Count == 0 && !string.IsNullOrEmpty(filter);
    }

    private void OnListBoxDoubleTapped(object? sender, TappedEventArgs e)
    {
        if (_listBox.SelectedItem is HistoryListItem item)
        {
            Close(item.FilePath);
        }
    }

    private class HistoryListItem
    {
        public string FilePath { get; init; } = string.Empty;
        public string FileName { get; init; } = string.Empty;
        public string LastOpenedDisplay { get; init; } = string.Empty;
    }
}
