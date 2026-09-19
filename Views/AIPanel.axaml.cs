using System;
using System.Collections.Generic;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Data.Converters;
using Diagramon.Models;
using Diagramon.ViewModels;

namespace Diagramon.Views;

public partial class AIPanel : UserControl
{
    private bool _isDraggingChatSplitter;
    private bool _chatSplitterDragStarted;
    private double _chatSplitterStartY;
    private double _chatInputStartHeight;

    private const double ChatInputDefaultHeight = 100;
    private const double ChatInputMinHeight = 80;
    private const double ChatInputMaxHeight = 320;

    public AIPanel()
    {
        InitializeComponent();
        Loaded += OnLoaded;
    }

    private void OnLoaded(object? sender, global::Avalonia.Interactivity.RoutedEventArgs e)
    {
        SetupInputTextBoxContextMenu();

        var inputArea = this.FindControl<Border>("ChatInputArea");
        if (inputArea != null)
        {
            inputArea.Height = ChatInputDefaultHeight;
        }
    }

    private void SetupInputTextBoxContextMenu()
    {
        var inputTextBox = this.FindControl<TextBox>("InputTextBox");
        if (inputTextBox == null) return;

        var menu = new ContextMenu();
        
        var cutItem = new MenuItem { Header = "剪切(_X)", HotKey = KeyGesture.Parse("Ctrl+X") };
        cutItem.Click += (_, _) => inputTextBox.Cut();
        
        var copyItem = new MenuItem { Header = "复制(_C)", HotKey = KeyGesture.Parse("Ctrl+C") };
        copyItem.Click += (_, _) => inputTextBox.Copy();
        
        var pasteItem = new MenuItem { Header = "粘贴(_V)", HotKey = KeyGesture.Parse("Ctrl+V") };
        pasteItem.Click += (_, _) => inputTextBox.Paste();
        
        var selectAllItem = new MenuItem { Header = "全选(_A)", HotKey = KeyGesture.Parse("Ctrl+A") };
        selectAllItem.Click += (_, _) => inputTextBox.SelectAll();

        var items = new List<Control>
        {
            cutItem,
            copyItem,
            pasteItem,
            new Separator(),
            selectAllItem
        };
        
        menu.ItemsSource = items;
        inputTextBox.ContextMenu = menu;
    }

    private void OnTogglePointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (DataContext is AIPanelViewModel vm)
        {
            vm.ToggleCommand.Execute(null);
        }
    }

    private void OnInputKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            e.Handled = true;
            if (DataContext is AIPanelViewModel vm && vm.SendCommand.CanExecute(null))
            {
                vm.SendCommand.Execute(null);
            }
        }
    }

    private void OnChatSplitterPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            _isDraggingChatSplitter = true;
            _chatSplitterDragStarted = false;
            _chatSplitterStartY = e.GetPosition(this).Y;
            var inputArea = this.FindControl<Border>("ChatInputArea");
            _chatInputStartHeight = inputArea?.Bounds.Height ?? ChatInputDefaultHeight;
            e.Handled = true;
        }
    }

    private void OnChatSplitterPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_isDraggingChatSplitter) return;

        var currentY = e.GetPosition(this).Y;
        var deltaY = _chatSplitterStartY - currentY;

        if (!_chatSplitterDragStarted)
        {
            if (Math.Abs(deltaY) < 3) return;
            _chatSplitterDragStarted = true;
            if (sender is Control c) e.Pointer.Capture(c);
        }

        var newHeight = Math.Clamp(_chatInputStartHeight + deltaY, ChatInputMinHeight, ChatInputMaxHeight);
        var inputArea = this.FindControl<Border>("ChatInputArea");
        if (inputArea != null)
        {
            inputArea.Height = newHeight;
        }

        e.Handled = true;
    }

    private void OnChatSplitterPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (_isDraggingChatSplitter)
        {
            var wasDragStarted = _chatSplitterDragStarted;
            _isDraggingChatSplitter = false;
            _chatSplitterDragStarted = false;
            e.Pointer.Capture(null);
            if (wasDragStarted) e.Handled = true;
        }
    }
}

public static class AIPanelConverters
{
    public static readonly IValueConverter MessageBackgroundConverter = new FuncValueConverter<MessageRole, IBrush>(
        role => role == MessageRole.User 
            ? new SolidColorBrush(Color.Parse("#E3F2FD")) 
            : new SolidColorBrush(Color.Parse("#FFFFFF"))
    );

    public static readonly IValueConverter MessageAlignmentConverter = new FuncValueConverter<MessageRole, Avalonia.Layout.HorizontalAlignment>(
        role => role == MessageRole.User 
            ? Avalonia.Layout.HorizontalAlignment.Right 
            : Avalonia.Layout.HorizontalAlignment.Left
    );
}
