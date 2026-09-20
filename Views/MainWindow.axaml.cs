using System;
using System.Collections.Generic;
using System.IO;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Input;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform;
using Avalonia.Threading;
using Avalonia.VisualTree;
using AvaloniaEdit;
using AvaloniaEdit.Search;
using AvaloniaWebView;
using Diagramon.Models;
using Diagramon.ViewModels;
using Diagramon.Views;

namespace Diagramon.Views;

public partial class MainWindow : Window
{
    private TextEditor? _codeEditor;
    private Border? _previewWebHost;
    private MainViewModel? _viewModel;
    private Grid? _workspaceGrid;
    private Border? _splitterBorder;
    private Border? _previewGrid;
    private WebView? _previewWebViewControl;
    private MethodInfo? _webViewNavigateMethod;
    private PropertyInfo? _webViewSourceProperty;
    private PropertyInfo? _webViewUrlProperty;
    private MethodInfo? _webViewExecuteScriptMethod;
    private object? _coreWebView2;
    private MethodInfo? _coreWebView2ExecuteScriptMethod;
    private string? _pendingPreviewHtml;
    private string? _previewTempDir;
    private string? _previewHtmlPath;
    private bool _webViewAttached;
    private bool _webViewInitTried;
    private bool _webViewPageLoaded;
    private DispatcherTimer? _zoomPollTimer;
    private bool _isClosing;

    private Delegate? _webViewAccelKeyHandler;

    [DllImport("user32.dll")]
    private static extern short GetKeyState(int nVirtKey);
    private const int VK_CONTROL = 0x11;

    private bool _isDraggingSplitter;
    private bool _splitterDragStarted;
    private double _splitterStartX;
    private double _editorStartWidth;

    private bool _isDraggingAIPanelSplitter;
    private bool _aiPanelSplitterDragStarted;
    private double _aiPanelSplitterStartY;
    private double _aiPanelStartHeight;

    private const double MinEditorWidth = 320;
    private const double MaxEditorWidth = 860;
    private const double MinPreviewWidth = 480;
    private const double MinAIPanelHeight = 50;

    public MainWindow()
    {
        CleanupStalePreviewFiles();
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
        AttachPreviewHandlers();
        Closing += OnClosing;
        KeyBindings.AddRange(CreateEditorKeyBindings());
    }

    private void OnTabPointerWheelChanged(object? sender, PointerWheelEventArgs e)
    {
        if (DataContext is not MainViewModel viewModel) return;

        if (e.Delta.Y < 0)
        {
            if (viewModel.SelectedTabIndex < viewModel.Tabs.Count - 1)
                viewModel.SelectedTabIndex++;
        }
        else if (e.Delta.Y > 0)
        {
            if (viewModel.SelectedTabIndex > 0)
                viewModel.SelectedTabIndex--;
        }

        e.Handled = true;
    }

    private void HookWebViewAcceleratorKey()
    {
        try
        {
            var controllerProp = _coreWebView2?.GetType().GetProperty("Controller");
            var controller = controllerProp?.GetValue(_coreWebView2);
            if (controller == null) return;

            var evt = controller.GetType().GetEvent("AcceleratorKeyPressed");
            if (evt == null) return;

            var method = typeof(MainWindow).GetMethod(nameof(OnWebViewAcceleratorKeyPressed),
                BindingFlags.NonPublic | BindingFlags.Instance, null,
                [typeof(object), typeof(object)], null);
            if (method == null) return;

            var delegateType = evt.EventHandlerType!;
            var invokeMethod = delegateType.GetMethod("Invoke")!;
            var invokeParams = invokeMethod.GetParameters();

            var senderParam = Expression.Parameter(typeof(object), "sender");
            var argsParam = Expression.Parameter(invokeParams[1].ParameterType, "args");
            var callExpr = Expression.Call(Expression.Constant(this), method!,
                senderParam, Expression.Convert(argsParam, typeof(object)));
            var lambda = Expression.Lambda(delegateType, callExpr, senderParam, argsParam);
            _webViewAccelKeyHandler = lambda.Compile();
            evt.AddEventHandler(controller, _webViewAccelKeyHandler);
        }
        catch
        {
        }
    }

    private void OnWebViewAcceleratorKeyPressed(object? sender, object args)
    {
        try
        {
            var argsType = args.GetType();
            var keyEventKindProp = argsType.GetProperty("KeyEventKind");
            var virtualKeyProp = argsType.GetProperty("VirtualKey");
            var handledProp = argsType.GetProperty("Handled");

            if (keyEventKindProp == null || virtualKeyProp == null || handledProp == null) return;

            var keyEventKind = (int)keyEventKindProp.GetValue(args)!;
            var virtualKey = (int)(uint)virtualKeyProp.GetValue(args)!;

            // KeyEventKind 0 = KeyDown, only intercept on key down
            if (keyEventKind != 0) return;

            // VK_S = 0x53
            if (virtualKey != 0x53) return;

            // Check if Ctrl is held
            if ((GetKeyState(VK_CONTROL) & 0x8000) == 0) return;

            handledProp.SetValue(args, true);

            Dispatcher.UIThread.Post(() =>
            {
                if (DataContext is MainViewModel viewModel)
                {
                    viewModel.SaveFileCommand.Execute(null);
                }
            });
        }
        catch
        {
        }
    }

    private List<KeyBinding> CreateEditorKeyBindings()
    {
        var bindings = new List<KeyBinding>();
        
        bindings.Add(CreateViewModelKeyBinding("Ctrl+N", nameof(MainViewModel.NewFileCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+O", nameof(MainViewModel.OpenFileCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+S", nameof(MainViewModel.SaveFileCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+Shift+S", nameof(MainViewModel.SaveFileAsCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+W", nameof(MainViewModel.CloseCurrentTabCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+Q", nameof(MainViewModel.ExitCommand)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+Z", nameof(UndoEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+Y", nameof(RedoEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+Shift+Z", nameof(RedoEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+X", nameof(CutEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+C", nameof(CopyEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+V", nameof(PasteEditor)));
        bindings.Add(CreateConditionalKeyBinding("Ctrl+A", nameof(SelectAllEditor)));
        
        return bindings;
    }

    private KeyBinding CreateViewModelKeyBinding(string gesture, string commandPropertyName)
    {
        var binding = new KeyBinding();
        binding.Gesture = KeyGesture.Parse(gesture);
        binding.Command = new ViewModelCommand(this, commandPropertyName);
        return binding;
    }

    private KeyBinding CreateConditionalKeyBinding(string gesture, string actionName)
    {
        var binding = new KeyBinding();
        binding.Gesture = KeyGesture.Parse(gesture);
        binding.Command = new ConditionalEditorCommand(this, actionName);
        return binding;
    }

    private static bool IsChildOfSearchPanel(Visual? visual)
    {
        var current = visual;
        while (current != null)
        {
            if (current is SearchPanel)
                return true;
            current = current.GetVisualParent();
        }
        return false;
    }

    private bool IsCodeEditorFocused()
    {
        if (_codeEditor == null) return false;
#pragma warning disable CS8602
        var focusedElement = FocusManager.GetFocusedElement();
#pragma warning restore CS8602
        if (focusedElement == null) return false;
        if (focusedElement is not Visual focused) return false;

        if (IsChildOfSearchPanel(focused))
            return false;

        if (ReferenceEquals(focused, _codeEditor) || ReferenceEquals(focused, _codeEditor.TextArea))
            return true;

        var parent = focused.GetVisualParent();
        while (parent != null)
        {
            if (ReferenceEquals(parent, _codeEditor) || ReferenceEquals(parent, _codeEditor.TextArea))
                return true;
            parent = parent.GetVisualParent();
        }

        return false;
    }

    private class ConditionalEditorCommand : ICommand
    {
        private readonly MainWindow _window;
        private readonly MethodInfo? _method;

        public ConditionalEditorCommand(MainWindow window, string actionName)
        {
            _window = window;
            _method = window.GetType().GetMethod(actionName);
        }

#pragma warning disable CS0067
        public event EventHandler? CanExecuteChanged;
#pragma warning restore CS0067

        public bool CanExecute(object? parameter)
        {
            return _window.IsCodeEditorFocused() && _method != null;
        }

        public void Execute(object? parameter)
        {
            if (_method != null && _window.IsCodeEditorFocused())
            {
                _method.Invoke(_window, null);
            }
        }
    }

    private class ViewModelCommand : ICommand
    {
        private readonly MainWindow _window;
        private readonly string _commandPropertyName;

        public ViewModelCommand(MainWindow window, string commandPropertyName)
        {
            _window = window;
            _commandPropertyName = commandPropertyName;
        }

#pragma warning disable CS0067
        public event EventHandler? CanExecuteChanged;
#pragma warning restore CS0067

        public bool CanExecute(object? parameter)
        {
            var command = GetCommand();
            return command?.CanExecute(parameter) ?? true;
        }

        public void Execute(object? parameter)
        {
            var command = GetCommand();
            command?.Execute(parameter);
        }

        private ICommand? GetCommand()
        {
            var viewModel = _window._viewModel;
            if (viewModel == null) return null;
            
            var property = viewModel.GetType().GetProperty(_commandPropertyName);
            return property?.GetValue(viewModel) as ICommand;
        }
    }

    private void InitializeComponent()
    {
        AvaloniaXamlLoader.Load(this);
    }

    private void AttachPreviewHandlers()
    {
        _codeEditor = this.FindControl<TextEditor>("CodeEditor");
        _previewWebHost = this.FindControl<Border>("PreviewWebHost");
        _workspaceGrid = this.FindControl<Grid>("WorkspaceGrid");
        _splitterBorder = this.FindControl<Border>("SplitterBorder");
        _previewGrid = this.FindControl<Border>("PreviewGrid");

        if (_codeEditor != null)
        {
            SearchPanel.Install(_codeEditor);
            _codeEditor.TextChanged += (_, _) => RefreshEditorState();
            _codeEditor.TextArea.SelectionChanged += (_, _) => RefreshEditorState();
            _codeEditor.PropertyChanged += (_, e) =>
            {
                if (e.Property.Name == nameof(TextEditor.Document))
                {
                    Dispatcher.UIThread.Post(RefreshEditorState, DispatcherPriority.Background);
                }
            };
        }

    }

    private void ResetPreviewOffset()
    {
        // WebView 预览不再支持拖拽偏移
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (_viewModel != null)
        {
            _viewModel.PropertyChanged -= OnViewModelPropertyChanged;
        }

        _viewModel = DataContext as MainViewModel;

        if (_viewModel != null)
        {
            _viewModel.PropertyChanged += OnViewModelPropertyChanged;
            Dispatcher.UIThread.Post(() =>
            {
                RefreshEditorState();
                UpdateWorkspaceLayout();
                UpdateWebPreview();
            }, DispatcherPriority.Background);
        }
    }

    private void OnViewModelPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(MainViewModel.CurrentTab) or nameof(MainViewModel.SelectedTabIndex))
        {
            Dispatcher.UIThread.Post(RefreshEditorState, DispatcherPriority.Background);
            Dispatcher.UIThread.Post(() =>
            {
                ResetPreviewOffset();
                UpdatePreviewFitScale();
                UpdateWebPreview();
            }, DispatcherPriority.Background);
        }
        else if (e.PropertyName == nameof(MainViewModel.CurrentPreviewHtml))
        {
            Dispatcher.UIThread.Post(UpdateWebPreview, DispatcherPriority.Background);
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (DataContext is MainViewModel viewModel)
        {
            viewModel.SaveSettings();
        }
    }

    private async void OnClosing(object? sender, WindowClosingEventArgs e)
    {
        if (_isClosing)
        {
            return;
        }

        if (DataContext is MainViewModel viewModel && viewModel.HasUnsavedChanges)
        {
            e.Cancel = true;
            _isClosing = true;

            var canClose = await viewModel.ConfirmCloseAsync();
            if (canClose)
            {
                viewModel.SaveSettings();
                Close();
            }
            else
            {
                _isClosing = false;
            }
        }
    }

    private void OnSplitterPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            _isDraggingSplitter = true;
            _splitterDragStarted = false;
            _splitterStartX = e.GetPosition(this).X;
            _editorStartWidth = _viewModel?.EditorPanelWidth ?? 640;
        }
    }

    private void OnSplitterPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_isDraggingSplitter || _viewModel == null || _workspaceGrid == null)
            return;

        var currentX = e.GetPosition(this).X;
        var deltaX = currentX - _splitterStartX;

        if (!_splitterDragStarted)
        {
            if (Math.Abs(deltaX) < 3)
                return;
            _splitterDragStarted = true;
            e.Pointer.Capture(_splitterBorder);
        }

        var totalWidth = _workspaceGrid.Bounds.Width;
        var splitterWidth = 5;

        var newEditorWidth = _editorStartWidth + deltaX;
        var usableWidth = totalWidth - splitterWidth;

        newEditorWidth = Math.Clamp(newEditorWidth, MinEditorWidth, MaxEditorWidth);

        if (usableWidth - newEditorWidth < MinPreviewWidth)
        {
            newEditorWidth = Math.Max(MinEditorWidth, usableWidth - MinPreviewWidth);
        }

        _viewModel.EditorPanelWidth = newEditorWidth;
        _viewModel.EditorPreviewRatio = totalWidth > 0 ? newEditorWidth / totalWidth : 0.5;
        e.Handled = true;
    }

    private void OnSplitterPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (_isDraggingSplitter)
        {
            var wasDragStarted = _splitterDragStarted;
            _isDraggingSplitter = false;
            _splitterDragStarted = false;
            e.Pointer.Capture(null);
            if (wasDragStarted)
                e.Handled = true;
        }
    }

    private void OnToggleTriangleTapped(object? sender, TappedEventArgs e)
    {
        if (_viewModel != null)
        {
            _viewModel.ToggleEditorVisibilityCommand.Execute(null);
            e.Handled = true;
        }
    }

    private void OnAIPanelTogglePointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (_viewModel?.AiAssistant != null)
        {
            _viewModel.AiAssistant.ToggleCommand.Execute(null);
            e.Handled = true;
        }
    }

    private void OnAIPanelSplitterPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
        {
            _isDraggingAIPanelSplitter = true;
            _aiPanelSplitterDragStarted = false;
            _aiPanelSplitterStartY = e.GetPosition(this).Y;
            _aiPanelStartHeight = _viewModel?.AiAssistant?.PanelHeight ?? 200;
        }
    }

    private void OnAIPanelSplitterPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_isDraggingAIPanelSplitter || _viewModel?.AiAssistant == null)
            return;

        var currentY = e.GetPosition(this).Y;
        var deltaY = _aiPanelSplitterStartY - currentY;

        if (!_aiPanelSplitterDragStarted)
        {
            if (Math.Abs(deltaY) < 3)
                return;
            _aiPanelSplitterDragStarted = true;
            e.Pointer.Capture(sender as Control);
        }

        var maxAIPanelHeight = Bounds.Height * 0.7;
        var newHeight = _aiPanelStartHeight + deltaY;
        newHeight = Math.Clamp(newHeight, MinAIPanelHeight, maxAIPanelHeight);
        _viewModel.AiAssistant.PanelHeight = newHeight;
        e.Handled = true;
    }

    private void OnAIPanelSplitterPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (_isDraggingAIPanelSplitter)
        {
            var wasDragStarted = _aiPanelSplitterDragStarted;
            _isDraggingAIPanelSplitter = false;
            _aiPanelSplitterDragStarted = false;
            e.Pointer.Capture(null);
            if (wasDragStarted)
                e.Handled = true;
        }
    }

    private void OnResetPreviewClicked(object? sender, RoutedEventArgs e)
    {
        if (DataContext is MainViewModel viewModel)
        {
            viewModel.ResetZoomCommand.Execute(null);
        }

        ResetPreviewOffset();
        UpdatePreviewFitScale();
    }

    private void OnWorkspaceSizeChanged(object? sender, SizeChangedEventArgs e)
    {
        UpdateWorkspaceLayout();
        UpdateWebPreview();
    }

    private void UpdatePreviewFitScale()
    {
        if (DataContext is not MainViewModel viewModel || _previewGrid == null)
        {
            return;
        }

        var viewportSize = _previewGrid.Bounds.Size;
        if (viewportSize.Width > 0 && viewportSize.Height > 0)
        {
            viewModel.UpdatePreviewFitScale(viewportSize);
        }
    }

    private void UpdateWorkspaceLayout()
    {
        if (DataContext is not MainViewModel viewModel)
        {
            return;
        }

        var width = Bounds.Width;
        if (width > 0)
        {
            viewModel.UpdateWorkspaceLayout(width);
        }
    }

    private void OnTabPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (sender is Border border && border.DataContext is Models.TabItem tab && DataContext is MainViewModel viewModel)
        {
            var index = viewModel.Tabs.IndexOf(tab);
            if (index >= 0)
            {
                viewModel.SelectedTabIndex = index;
                Dispatcher.UIThread.Post(() =>
                {
                    ResetPreviewOffset();
                    UpdatePreviewFitScale();
                }, DispatcherPriority.Background);
            }
        }
    }

    public void UndoEditor()
    {
        ExecuteEditorAction(editor =>
        {
            if (editor.CanUndo)
            {
                editor.Undo();
            }
        });
    }

    public void RedoEditor()
    {
        ExecuteEditorAction(editor =>
        {
            if (editor.CanRedo)
            {
                editor.Redo();
            }
        });
    }

    public void CutEditor()
    {
        ExecuteEditorAction(editor => editor.Cut());
    }

    public void CopyEditor()
    {
        ExecuteEditorAction(editor => editor.Copy());
    }

    public void PasteEditor()
    {
        ExecuteEditorAction(editor => editor.Paste());
    }

    public void SelectAllEditor()
    {
        ExecuteEditorAction(editor => editor.SelectAll());
    }

    private void ExecuteEditorAction(Action<TextEditor> action)
    {
        if (_codeEditor == null)
        {
            return;
        }

        _codeEditor.Focus();
        action(_codeEditor);
        RefreshEditorState();
    }

    private void RefreshEditorState()
    {
        if (_viewModel == null || _codeEditor == null)
        {
            return;
        }

        var hasText = !string.IsNullOrEmpty(_codeEditor.Text);
        var hasSelection = _codeEditor.SelectionLength > 0;
        _viewModel.UpdateEditorState(_codeEditor.CanUndo, _codeEditor.CanRedo, hasSelection, hasText);
    }

    private void UpdateWebPreview()
    {
        if (_viewModel == null || _previewWebHost == null)
        {
            return;
        }

        var html = _viewModel.CurrentPreviewHtml;
        if (string.IsNullOrWhiteSpace(html))
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(_viewModel.CurrentTab?.Content))
        {
            if (_previewWebViewControl == null)
            {
                return;
            }
        }

        if (!EnsureWebViewReady())
        {
            _viewModel.StatusMessage = "WebView 初始化失败，无法显示实时预览";
            return;
        }

        if (_previewWebViewControl == null)
        {
            return;
        }

        try
        {
            if (_webViewPageLoaded)
            {
                UpdatePreviewViaScript();
            }
            else
            {
                _pendingPreviewHtml = html;
                TryApplyPendingWebPreview();
            }
        }
        catch (Exception ex)
        {
            _viewModel.StatusMessage = $"WebView 预览失败: {ex.Message}";
        }
    }

    private async void UpdatePreviewViaScript()
    {
        if (_viewModel?.CurrentTab?.Content == null) return;

        var code = _viewModel.CurrentTab.Content;
        var jsonCode = System.Text.Json.JsonSerializer.Serialize(code);
        var script = $"renderDiagram({jsonCode})";

        try
        {
            if (_webViewExecuteScriptMethod != null)
            {
                _webViewExecuteScriptMethod.Invoke(_previewWebViewControl, new object[] { script });
            }
            else if (_coreWebView2ExecuteScriptMethod != null && _coreWebView2 != null)
            {
                _coreWebView2ExecuteScriptMethod.Invoke(_coreWebView2, new object[] { script });
            }
            else
            {
                _webViewPageLoaded = false;
                _pendingPreviewHtml = _viewModel.CurrentPreviewHtml;
                TryApplyPendingWebPreview();
            }
        }
        catch
        {
            _webViewPageLoaded = false;
            _pendingPreviewHtml = _viewModel.CurrentPreviewHtml;
            TryApplyPendingWebPreview();
        }
    }

    private void TryApplyPendingWebPreview()
    {
        if (_previewWebViewControl == null || string.IsNullOrWhiteSpace(_pendingPreviewHtml))
        {
            return;
        }

        if (!_webViewAttached)
        {
            return;
        }

        EnsurePreviewFilesReady();
        if (string.IsNullOrWhiteSpace(_previewHtmlPath))
        {
            throw new InvalidOperationException("预览文件初始化失败。");
        }

        File.WriteAllText(_previewHtmlPath, _pendingPreviewHtml, Encoding.UTF8);
        var previewUri = new Uri(_previewHtmlPath);
        var previewUriString = previewUri.AbsoluteUri;

        if (_webViewNavigateMethod != null)
        {
            var parameters = _webViewNavigateMethod.GetParameters();
            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(string))
            {
                _webViewNavigateMethod.Invoke(_previewWebViewControl, new object[] { previewUriString });
                _pendingPreviewHtml = null;
                _webViewPageLoaded = true;
                return;
            }

            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(Uri))
            {
                _webViewNavigateMethod.Invoke(_previewWebViewControl, new object[] { previewUri });
                _pendingPreviewHtml = null;
                _webViewPageLoaded = true;
                return;
            }
        }

        if (_webViewSourceProperty != null && _webViewSourceProperty.PropertyType == typeof(Uri))
        {
            _webViewSourceProperty.SetValue(_previewWebViewControl, previewUri);
            _pendingPreviewHtml = null;
            _webViewPageLoaded = true;
            return;
        }

        if (_webViewSourceProperty != null && _webViewSourceProperty.PropertyType == typeof(string))
        {
            _webViewSourceProperty.SetValue(_previewWebViewControl, previewUriString);
            _pendingPreviewHtml = null;
            _webViewPageLoaded = true;
            return;
        }

        if (_webViewUrlProperty != null && _webViewUrlProperty.PropertyType == typeof(Uri))
        {
            _webViewUrlProperty.SetValue(_previewWebViewControl, previewUri);
            _pendingPreviewHtml = null;
            _webViewPageLoaded = true;
            return;
        }

        if (_webViewUrlProperty != null && _webViewUrlProperty.PropertyType == typeof(string))
        {
            _webViewUrlProperty.SetValue(_previewWebViewControl, previewUriString);
            _pendingPreviewHtml = null;
            _webViewPageLoaded = true;
            return;
        }

        throw new InvalidOperationException("当前 WebView 版本不支持可用导航方式（Navigate/Source/Url）。");
    }

    private void CleanupStalePreviewFiles()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Diagramon",
            "webpreview");
        if (!Directory.Exists(dir)) return;
        var cutoff = DateTime.Now.AddDays(-7);
        foreach (var oldFile in Directory.GetFiles(dir, "preview*.html"))
        {
            try
            {
                if (File.GetCreationTime(oldFile) < cutoff)
                    File.Delete(oldFile);
            }
            catch { }
        }
    }

    private void EnsurePreviewFilesReady()
    {
        if (!string.IsNullOrWhiteSpace(_previewHtmlPath) && File.Exists(_previewHtmlPath))
        {
            return;
        }

        _previewTempDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Diagramon",
            "webpreview");
        Directory.CreateDirectory(_previewTempDir);

        var scriptPath = Path.Combine(_previewTempDir, "mermaid.min.js");
        if (!File.Exists(scriptPath))
        {
            var scriptUri = new Uri("avares://Diagramon/Assets/mermaid.min.js");
            using var scriptStream = AssetLoader.Open(scriptUri);
            using var fileStream = File.Create(scriptPath);
            scriptStream.CopyTo(fileStream);
        }

        _previewHtmlPath = Path.Combine(_previewTempDir, "preview.html");
    }

    private void StartZoomPolling()
    {
        if (_zoomPollTimer != null)
            return;

        _zoomPollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _zoomPollTimer.Tick += async (_, _) =>
        {
            if (_previewWebViewControl == null || _webViewExecuteScriptMethod == null)
                return;

            try
            {
                var taskResult = _webViewExecuteScriptMethod.Invoke(_previewWebViewControl, new object[] { "scale" });
                string? value = null;
                if (taskResult is Task<string> typedTask)
                {
                    value = await typedTask;
                }
                else if (taskResult is Task task)
                {
                    await task;
                    value = task.GetType().GetProperty("Result")?.GetValue(task)?.ToString();
                }

                if (!string.IsNullOrEmpty(value) &&
                    double.TryParse(value, System.Globalization.NumberStyles.Any,
                    System.Globalization.CultureInfo.InvariantCulture, out var scale) &&
                    DataContext is MainViewModel vm)
                {
                    vm.PreviewZoom = scale;
                }
            }
            catch
            {
            }
        };
        _zoomPollTimer.Start();
    }

    private bool EnsureWebViewReady()
    {
        if (_previewWebHost?.Child is WebView existingWebView)
        {
            _previewWebViewControl = existingWebView;
            _webViewAttached = true;
            StartZoomPolling();
            return true;
        }

        if (_previewWebViewControl != null)
        {
            _webViewAttached = true;
            return true;
        }

        if (_previewWebHost == null)
        {
            return false;
        }

        if (_previewWebHost.Bounds.Width == 0 || _previewWebHost.Bounds.Height == 0)
        {
            // Delay initialization until the container has valid size to avoid orphaned HWND bugs in WebView2
            return false;
        }

        if (_webViewInitTried)
        {
            return false;
        }
        _webViewInitTried = true;

        try
        {
            _previewWebHost.Child = null;
            var webViewControl = new WebView();
            var webViewType = webViewControl.GetType();
            _webViewNavigateMethod = webViewType.GetMethod("Navigate", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            _webViewSourceProperty = webViewType.GetProperty("Source", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            _webViewUrlProperty = webViewType.GetProperty("Url", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            _webViewExecuteScriptMethod = webViewType.GetMethod("ExecuteScriptAsync", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

            var coreWebView2Property = webViewType.GetProperty("CoreWebView2", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (coreWebView2Property != null && coreWebView2Property.PropertyType != typeof(object))
            {
                webViewControl.AttachedToVisualTree += (_, _) =>
                {
                    _webViewAttached = true;
                    Dispatcher.UIThread.Post(async () =>
                    {
                        await Task.Delay(800);
                        try
                        {
                            _coreWebView2 = coreWebView2Property.GetValue(_previewWebViewControl);
                            if (_coreWebView2 != null)
                            {
                                _coreWebView2ExecuteScriptMethod = _coreWebView2.GetType()
                                    .GetMethod("ExecuteScriptAsync", BindingFlags.Public | BindingFlags.Instance);
                                HookWebViewAcceleratorKey();
                            }
                            TryApplyPendingWebPreview();
                        }
                        catch
                        {
                        }
                    }, DispatcherPriority.Background);
                };
            }
            else
            {
                webViewControl.AttachedToVisualTree += (_, _) =>
                {
                    _webViewAttached = true;
                    Dispatcher.UIThread.Post(async () =>
                    {
                        await Task.Delay(500);
                        try
                        {
                            TryApplyPendingWebPreview();
                        }
                        catch
                        {
                        }
                    }, DispatcherPriority.Background);
                };
            }
            webViewControl.HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Stretch;
            webViewControl.VerticalAlignment = Avalonia.Layout.VerticalAlignment.Stretch;
            _previewWebHost.Child = webViewControl;
            _previewWebViewControl = webViewControl;
            StartZoomPolling();
            return true;
        }
        catch
        {
            return false;
        }
    }
}

