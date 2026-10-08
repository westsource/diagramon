using System;
using System.Collections.Generic;
using System.Globalization;
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
using Diagramon.Services.Documents;
using Diagramon.Services.Drawio;
using Diagramon.Services.Embedded;
using Diagramon.Services.Excalidraw;
using Diagramon.Services.Localization;
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
    private Panel? _embeddedAppHost;
    private readonly Dictionary<string, IEmbeddedDocumentHost> _embeddedHosts = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 每个内嵌格式**专属**的承载容器（懒创建，常驻）。
    /// </summary>
    /// <remarks>
    /// 不能所有格式共用一个 <see cref="Border"/>：<c>Border.Child</c> 只有一个，后挂的格式会把先挂的
    /// WebView 挤出可视树 —— WebView2 的原生窗口随之销毁，而宿主只在首次 <c>Attach</c> 时挂载，
    /// 切回来就永远是一片空白（新建 drawio 标签 → 新建 Excalidraw 标签 → 切回 drawio 可复现）。
    /// 每个格式一个容器后，WebView 只挂一次、只切显隐，原生窗口被"停到屏外"而不是销毁。
    /// </remarks>
    private readonly Dictionary<string, Border> _embeddedContainers = new(StringComparer.OrdinalIgnoreCase);
    private WebView? _previewWebViewControl;
    private MethodInfo? _webViewNavigateMethod;
    private PropertyInfo? _webViewSourceProperty;
    private PropertyInfo? _webViewUrlProperty;
    private MethodInfo? _webViewExecuteScriptMethod;
    private object? _coreWebView2;
    private MethodInfo? _coreWebView2ExecuteScriptMethod;
    private string? _loadedSurfaceKey;
    private bool _surfaceReady;
    private DispatcherTimer? _surfaceReadyTimer;
    private int _surfaceReadyAttempts;
    private int _navigatedRevision;
    private TaskCompletionSource<bool>? _surfaceReadySignal;
    private bool _webViewAttached;
    private bool _webViewInitTried;
    private DispatcherTimer? _previewPollTimer;
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
        Services.Preview.PreviewSurfaceHost.CleanupStaleFiles();
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

        // 视图：与两个画布的原生键位对齐（Ctrl+0 适应、Ctrl+± 缩放）。
        // 数字键盘的 +/- 与主键盘的 =/+、-/_ 都收，Shift 组合一并认（多数键盘上 "+" 要按 Shift）。
        bindings.Add(CreateViewModelKeyBinding("Ctrl+D0", nameof(MainViewModel.FitViewCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+NumPad0", nameof(MainViewModel.FitViewCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+OemPlus", nameof(MainViewModel.ZoomInCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+Shift+OemPlus", nameof(MainViewModel.ZoomInCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+Add", nameof(MainViewModel.ZoomInCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+OemMinus", nameof(MainViewModel.ZoomOutCommand)));
        bindings.Add(CreateViewModelKeyBinding("Ctrl+Subtract", nameof(MainViewModel.ZoomOutCommand)));

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
        _embeddedAppHost = this.FindControl<Panel>("EmbeddedAppHost");

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
                SyncEmbeddedAppSurface();
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
                UpdateWebPreview();
                SyncEmbeddedAppSurface();
            }, DispatcherPriority.Background);
        }
        else if (e.PropertyName == nameof(MainViewModel.CurrentPreviewRevision))
        {
            Dispatcher.UIThread.Post(UpdateWebPreview, DispatcherPriority.Background);
        }
    }

    private void OnClosed(object? sender, EventArgs e)
    {
        if (DataContext is MainViewModel viewModel)
        {
            viewModel.SaveSettings();
            viewModel.Shutdown();
        }

        foreach (var host in _embeddedHosts.Values)
        {
            (host as IDisposable)?.Dispose();
        }
        _embeddedHosts.Clear();
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

    private void OnWorkspaceSizeChanged(object? sender, SizeChangedEventArgs e)
    {
        UpdateWorkspaceLayout();
        UpdateWebPreview();
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

    /// <summary>
    /// 刷新预览：承载面变了就**导航**（换格式），否则只执行**增量脚本**。
    /// </summary>
    /// <remarks>
    /// 重建页面会把页内渲染器重载一遍（DOT 的 WASM 尤其贵），所以导航是例外、增量是常态。
    /// </remarks>
    private void UpdateWebPreview()
    {
        if (_viewModel == null || _previewWebHost == null)
        {
            return;
        }

        if (!EnsureWebViewReady())
        {
            _viewModel.StatusMessage = Strings.Instance.WebViewInitFailed;
            return;
        }

        if (_previewWebViewControl == null)
        {
            return;
        }

        var surfaceKey = _viewModel.CurrentPreviewSurfaceKey;
        var url = _viewModel.CurrentPreviewUrl;
        if (string.IsNullOrWhiteSpace(surfaceKey) || string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        if (!_webViewAttached)
        {
            // WebView 还没挂到可视树：attach 回调里会再走一遍
            return;
        }

        try
        {
            if (!string.Equals(_loadedSurfaceKey, surfaceKey, StringComparison.Ordinal))
            {
                NavigatePreviewSurface(url, surfaceKey);
                return;
            }

            if (_surfaceReady)
            {
                ExecutePreviewUpdateScript(_viewModel.CurrentUpdateScript);
            }
        }
        catch (Exception ex)
        {
            _viewModel.StatusMessage = string.Format(Strings.Instance.WebViewPreviewFailedFormat, ex.Message);
        }
    }

    /// <summary>导航到新的承载面（只在换格式时发生）。</summary>
    private void NavigatePreviewSurface(string url, string surfaceKey)
    {
        if (_previewWebViewControl == null || string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        _loadedSurfaceKey = surfaceKey;
        _surfaceReady = false;
        _navigatedRevision = _viewModel?.CurrentPreviewRevision ?? 0;

        var previewUri = new Uri(url);

        if (_webViewNavigateMethod != null)
        {
            var parameters = _webViewNavigateMethod.GetParameters();
            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(string))
            {
                _webViewNavigateMethod.Invoke(_previewWebViewControl, new object[] { url });
                StartSurfaceReadyProbe();
                return;
            }

            if (parameters.Length == 1 && parameters[0].ParameterType == typeof(Uri))
            {
                _webViewNavigateMethod.Invoke(_previewWebViewControl, new object[] { previewUri });
                StartSurfaceReadyProbe();
                return;
            }
        }

        foreach (var property in new[] { _webViewSourceProperty, _webViewUrlProperty })
        {
            if (property == null)
            {
                continue;
            }

            if (property.PropertyType == typeof(Uri))
            {
                property.SetValue(_previewWebViewControl, previewUri);
                StartSurfaceReadyProbe();
                return;
            }

            if (property.PropertyType == typeof(string))
            {
                property.SetValue(_previewWebViewControl, url);
                StartSurfaceReadyProbe();
                return;
            }
        }

        throw new InvalidOperationException(Strings.Instance.WebViewNavigationUnsupported);
    }

    /// <summary>
    /// 让内嵌图形编辑器（drawio / Excalidraw）与当前标签页同步：该显示时懒创建承载面并载入文档，
    /// 否则只隐藏（**不销毁** —— 重建要数秒且会丢撤销历史，方案 §4.7）。
    /// </summary>
    /// <remarks>
    /// 每个格式有**自己的**承载容器（<see cref="_embeddedContainers"/>）：WebView2 的原生窗口
    /// 一旦挂进可视树就不能再被搬走，共用容器会让"后打开的格式"把前一个挤出可视树。
    /// </remarks>
    private void SyncEmbeddedAppSurface()
    {
        if (_viewModel == null)
        {
            return;
        }

        var activeFormatId = _viewModel.CurrentFormat.Id;

        // 先隐藏不在用的承载面（不销毁：重建要数秒且丢撤销历史）
        foreach (var existing in _embeddedHosts.Values)
        {
            if (!string.Equals(existing.FormatId, activeFormatId, StringComparison.OrdinalIgnoreCase))
            {
                existing.Hide();

                if (_embeddedContainers.TryGetValue(existing.FormatId, out var inactive))
                {
                    inactive.IsVisible = false;
                }
            }
        }

        if (!_viewModel.IsEmbeddedAppVisible || _embeddedAppHost == null)
        {
            return;
        }

        var tab = _viewModel.CurrentTab;
        if (tab == null)
        {
            return;
        }

        var host = GetOrCreateEmbeddedHost(activeFormatId);
        if (host == null)
        {
            _viewModel.StatusMessage = string.Format(Strings.Instance.ErrorFormat, Strings.Instance.UnknownError);
            return;
        }

        if (!host.IsAvailable)
        {
            _viewModel.StatusMessage = DescribeMissingRuntime(activeFormatId);
            return;
        }

        // 该格式**自己的**容器：WebView 只在这里挂一次，之后只切显隐（见 _embeddedContainers 的注释）
        var container = GetOrCreateEmbeddedContainer(activeFormatId);
        container.IsVisible = true;
        host.Attach(container);

        // 一次性转换请求：这批是"由 Mermaid 转换过来"的标签页时，交给画布自己的 mermaid 导入器
        if (_viewModel.TryTakeMermaidImport(tab, out var mermaidSource))
        {
            host.LoadMermaidSource(tab, mermaidSource);
            _viewModel.EmbeddedZoomFactor = host.ZoomFactor;
            _viewModel.StatusMessage = Strings.Instance.Ready;
            return;
        }

        host.Show(tab);
        // 状态栏读数：刚切到画布时先摆上这个宿主已知的比例，后续变化由 ZoomFactorChanged 推
        _viewModel.EmbeddedZoomFactor = host.ZoomFactor;
        _viewModel.StatusMessage = Strings.Instance.Ready;
    }

    /// <summary>
    /// 按格式取承载宿主（不存在则懒创建）。**新增图形格式只在这里加一行** ——
    /// 这是 Phase 6 要压测的那条边界：承载层不因具体格式而改动。
    /// </summary>
    private IEmbeddedDocumentHost? GetOrCreateEmbeddedHost(string formatId)
    {
        if (_embeddedHosts.TryGetValue(formatId, out var existing))
        {
            return existing;
        }

        IEmbeddedDocumentHost? host = formatId.ToLowerInvariant() switch
        {
            "drawio" => new DrawioDocumentHost(),
            "excalidraw" => new ExcalidrawDocumentHost(),
            _ => null,
        };

        if (host == null)
        {
            return null;
        }

        host.HotkeyPressed += async (_, combo) => await HandleCanvasHotkeyAsync(combo);
        host.ZoomFactorChanged += (_, _) =>
        {
            if (_viewModel != null && string.Equals(host.FormatId, _viewModel.CurrentFormat.Id, StringComparison.OrdinalIgnoreCase))
            {
                _viewModel.EmbeddedZoomFactor = host.ZoomFactor;
            }
        };
        host.ErrorReported += (_, message) =>
        {
            if (_viewModel != null)
            {
                _viewModel.StatusMessage = message;
            }
        };

        _embeddedHosts[formatId] = host;
        return host;
    }

    /// <summary>
    /// 取某个格式专属的承载容器（不存在则懒创建）。容器常驻，之后只切 <c>IsVisible</c>：
    /// 宿主与它的 WebView 绑定一次就不再搬家，原生窗口得以保留（见 <see cref="_embeddedContainers"/>）。
    /// </summary>
    private Border GetOrCreateEmbeddedContainer(string formatId)
    {
        if (_embeddedContainers.TryGetValue(formatId, out var existing))
        {
            return existing;
        }

        var container = new Border { ClipToBounds = true };
        _embeddedAppHost?.Children.Add(container);
        _embeddedContainers[formatId] = container;
        return container;
    }

    /// <summary>资源缺失时的指引文案（按格式给具体脚本名，比"缺资源"这种泛化提示可操作）。</summary>
    private static string DescribeMissingRuntime(string formatId)
    {
        return formatId.ToLowerInvariant() switch
        {
            "drawio" => Strings.Instance.DrawioRendererMissing,
            "excalidraw" => Strings.Instance.ExcalidrawRuntimeMissing,
            _ => Strings.Instance.UnknownError,
        };
    }

    /// <summary>让画布在页面内导出位图（供 <c>MainViewModel</c> 的保存/复制图片使用）。</summary>
    public async Task<RendererResult> ExportEmbeddedImageAsync(string format, double scale, bool transparent)
    {
        var activeFormatId = _viewModel?.CurrentFormat.Id;
        if (activeFormatId == null || !_embeddedHosts.TryGetValue(activeFormatId, out var host))
        {
            return new RendererResult(false, null, Strings.Instance.CanvasHostNotCreated);
        }

        return await host.ExportImageAsync(format, scale, transparent);
    }

    /// <summary>
    /// 落盘前把画布里的最新内容取回正文（供 <c>MainViewModel</c> 的保存动作使用）。
    /// </summary>
    public async Task FlushEmbeddedCanvasAsync()
    {
        var activeFormatId = _viewModel?.CurrentFormat.Id;
        if (activeFormatId == null || !_embeddedHosts.TryGetValue(activeFormatId, out var host))
        {
            return;
        }

        await host.FlushAsync();
    }

    /// <summary>
    /// 把"放大 / 缩小一档"发给**当前**承载面（应用级命令 <c>MainViewModel.ZoomIn/ZoomOut</c> 的落点）。
    /// </summary>
    /// <remarks>
    /// 两条路：内嵌画布走承载面自己的缩放实现（各家范围/锚点不同），预览面走共享视口脚本
    /// （<c>Assets/preview-viewer.js</c> 暴露的 <c>window.__previewViewport</c>）。
    /// </remarks>
    public async Task ZoomActiveViewAsync(double factor)
    {
        if (_viewModel == null)
        {
            return;
        }

        if (_viewModel.IsEmbeddedAppVisible)
        {
            var activeFormatId = _viewModel.CurrentFormat.Id;
            if (_embeddedHosts.TryGetValue(activeFormatId, out var host))
            {
                await host.ZoomAsync(factor);
            }

            return;
        }

        await ExecutePreviewScriptAsync($"window.__previewViewport.zoomBy({factor.ToString("0.####", CultureInfo.InvariantCulture)})");
    }

    /// <summary>把"适应视图"发给当前承载面（预览面 = 页面自己的 fit，画布 = 各家的 fit）。</summary>
    public async Task FitActiveViewAsync()
    {
        if (_viewModel == null)
        {
            return;
        }

        if (_viewModel.IsEmbeddedAppVisible)
        {
            var activeFormatId = _viewModel.CurrentFormat.Id;
            if (_embeddedHosts.TryGetValue(activeFormatId, out var host))
            {
                await host.FitAsync();
            }

            return;
        }

        await ExecutePreviewScriptAsync("window.__previewViewport.fit()");
    }

    /// <summary>把一条脚本投给预览 WebView（渲染器页面与共享视口脚本都在它里面）。</summary>
    private Task ExecutePreviewScriptAsync(string script)
    {
        return InvokeScriptAsync(script);
    }

    /// <summary>
    /// 画布内按下的应用级快捷键（画布持焦点时窗口的 KeyBindings 收不到键，由承载页转发回来）。
    /// </summary>
    private async Task HandleCanvasHotkeyAsync(string combo)
    {
        if (_viewModel == null)
        {
            return;
        }

        switch (combo)
        {
            case "ctrl+s":
                if (_viewModel.CurrentTab is { } tab)
                {
                    await _viewModel.SaveTabAsync(tab);
                }
                break;
            case "ctrl+shift+s":
                _viewModel.SaveFileAsCommand.Execute(null);
                break;
            case "ctrl+o":
                _viewModel.OpenFileCommand.Execute(null);
                break;
            case "ctrl+n":
                _viewModel.NewFileCommand.Execute(null);
                break;
            case "ctrl+w":
                _viewModel.CloseCurrentTabCommand.Execute(null);
                break;
            case "ctrl+q":
                _viewModel.ExitCommand.Execute(null);
                break;
            case "ctrl+0":
                await FitActiveViewAsync();
                break;
            case "ctrl+zoom-in":
                await ZoomActiveViewAsync(MainViewModel.ZoomStepFactor);
                break;
            case "ctrl+zoom-out":
                await ZoomActiveViewAsync(1 / MainViewModel.ZoomStepFactor);
                break;
        }
    }

    /// <summary>
    /// 等承载页**自报就绪**：注入渲染器自己的探测表达式。
    /// </summary>
    /// <remarks>
    /// 不能再用"导航过就算加载完"当判据：换格式导航后页面还在加载，
    /// 这时注入脚本会打进**上一个**页面（例如把 DOT 源码喂给 Mermaid），报错或显示错图。
    /// </remarks>
    private void StartSurfaceReadyProbe()
    {
        StopSurfaceReadyProbe();

        _surfaceReadyAttempts = 0;
        _surfaceReadySignal = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        _surfaceReadyTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(150) };
        _surfaceReadyTimer.Tick += async (_, _) => await ProbeSurfaceReadyAsync();
        _surfaceReadyTimer.Start();
    }

    private async Task ProbeSurfaceReadyAsync()
    {
        _surfaceReadyAttempts++;

        var probe = _viewModel?.CurrentFormat.Renderer.BuildReadyProbeScript();
        var passed = !string.IsNullOrWhiteSpace(probe) && await EvaluateBoolAsync(probe!);

        // 60 次 × 150ms ≈ 9s：超时不当作错误（页面可能已在渲染），只是不再探测
        if (!passed && _surfaceReadyAttempts < 60)
        {
            return;
        }

        _surfaceReady = true;
        StopSurfaceReadyProbe();
        _surfaceReadySignal?.TrySetResult(passed);

        if (_viewModel != null && _viewModel.CurrentPreviewRevision != _navigatedRevision)
        {
            // 导航期间内容又变了：补一次增量更新
            ExecutePreviewUpdateScript(_viewModel.CurrentUpdateScript);
        }
    }

    private void StopSurfaceReadyProbe()
    {
        _surfaceReadyTimer?.Stop();
        _surfaceReadyTimer = null;
    }

    private async Task<bool> WaitForSurfaceReadyAsync(int timeoutMilliseconds)
    {
        if (_surfaceReady)
        {
            return true;
        }

        var signal = _surfaceReadySignal;
        if (signal == null)
        {
            return false;
        }

        var completed = await Task.WhenAny(signal.Task, Task.Delay(timeoutMilliseconds));
        return completed == signal.Task && signal.Task.Result;
    }

    private void ExecutePreviewUpdateScript(string? script)
    {
        if (string.IsNullOrWhiteSpace(script))
        {
            return;
        }

        _ = InvokeScriptAsync(script!);
    }

    /// <summary>执行脚本并取回原始返回值（WebView2 把返回值 JSON 序列化后回传）。</summary>
    private async Task<string?> InvokeScriptAsync(string script)
    {
        try
        {
            var method = _coreWebView2ExecuteScriptMethod;
            var target = _coreWebView2;

            if (method == null || target == null)
            {
                method = _webViewExecuteScriptMethod;
                target = _previewWebViewControl;
            }

            if (method == null || target == null)
            {
                return null;
            }

            var invocation = method.Invoke(target, new object[] { script });

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
        catch
        {
            // 页面未就绪 / 脚本异常：一律当作"取不到值"
        }

        return null;
    }

    private async Task<bool> EvaluateBoolAsync(string script)
    {
        var raw = await InvokeScriptAsync(script);
        return raw != null && raw.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<string?> EvaluateStringAsync(string script)
    {
        var raw = await InvokeScriptAsync(script);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<string>(raw);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 在预览页内栅格化当前内容并取回 PNG（方案 §8.3.4：渲染 → SVG → canvas → PNG，**零子进程**）。
    /// </summary>
    /// <remarks>
    /// 页面按约定把结果写到 <c>window.__export</c>（<c>{ok, dataUri, width, height}</c> 或 <c>{ok:false, error}</c>），
    /// 这里轮询取值 —— 导出是异步的（还要等 SVG 图片解码），不能用"执行完立刻读返回值"。
    /// </remarks>
    public async Task<RendererResult> RenderInPageImageAsync(string exportScript, string surfaceKey)
    {
        if (_viewModel == null || !EnsureWebViewReady() || _previewWebViewControl == null)
        {
            return new RendererResult(false, null, Strings.Instance.PreviewWebViewNotReady);
        }

        if (!string.Equals(_viewModel.CurrentPreviewSurfaceKey, surfaceKey, StringComparison.Ordinal))
        {
            return new RendererResult(false, null, Strings.Instance.PreviewSurfaceFormatMismatch);
        }

        if (!string.Equals(_loadedSurfaceKey, surfaceKey, StringComparison.Ordinal))
        {
            NavigatePreviewSurface(_viewModel.CurrentPreviewUrl, surfaceKey);
        }

        if (!await WaitForSurfaceReadyAsync(10000))
        {
            return new RendererResult(false, null, Strings.Instance.PreviewSurfaceNotReady);
        }

        await InvokeScriptAsync(exportScript);

        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (DateTime.UtcNow < deadline)
        {
            var json = await EvaluateStringAsync("window.__export ? JSON.stringify(window.__export) : null");
            if (!string.IsNullOrEmpty(json))
            {
                return ParseExportResult(json);
            }

            await Task.Delay(150);
        }

        return new RendererResult(false, null, Strings.Instance.InPageExportTimeout);
    }

    /// <summary>
    /// 把一段代码渲染进预览页，并取回**渲染报错原文**（V2-8，方案 §6.10）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 复用与 <see cref="RenderInPageImageAsync"/> **完全相同**的页面级约定与就绪判据：
    /// 注入更新脚本 → 轮询页面变量。区别只在取的是 <c>window.__diagramError</c> 而不是 <c>__export</c>。
    /// </para>
    /// <para>
    /// 页面变量是三态的：<c>undefined</c> = 还在渲染，<c>null</c> = 渲染成功，字符串 = 报错原文。
    /// 必须区分"渲染中"与"成功" —— 只判"有没有值"会把渲染中误判成成功。
    /// </para>
    /// <para>
    /// 返回 <c>null</c> 覆盖两种"不算模型的问题"的情况：渲染成功，或页面没起来/超时。
    /// 后者不该让模型去"修正" —— 那不是它的错。
    /// </para>
    /// </remarks>
    public async Task<string?> RenderPreviewAndGetErrorAsync(string updateScript, string surfaceKey)
    {
        if (_viewModel == null || !EnsureWebViewReady() || _previewWebViewControl == null)
        {
            return null;
        }

        if (!string.Equals(_viewModel.CurrentPreviewSurfaceKey, surfaceKey, StringComparison.Ordinal))
        {
            return null;
        }

        if (!string.Equals(_loadedSurfaceKey, surfaceKey, StringComparison.Ordinal))
        {
            NavigatePreviewSurface(_viewModel.CurrentPreviewUrl, surfaceKey);
        }

        if (!await WaitForSurfaceReadyAsync(10000))
        {
            return null;
        }

        await InvokeScriptAsync(updateScript);

        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            var value = await EvaluateStringAsync(
                "window.__diagramError === undefined ? null : (window.__diagramError || '')");

            // null = 还在渲染（继续等）；"" = 渲染成功；其余 = 报错原文
            if (value != null)
            {
                return value.Length == 0 ? null : value;
            }

            await Task.Delay(150);
        }

        return null;
    }

    private static RendererResult ParseExportResult(string json)
    {
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(json);
            var root = document.RootElement;

            var succeeded = root.TryGetProperty("ok", out var ok)
                && ok.ValueKind == System.Text.Json.JsonValueKind.True;

            if (!succeeded)
            {
                var error = root.TryGetProperty("error", out var errorElement)
                    && errorElement.ValueKind == System.Text.Json.JsonValueKind.String
                    ? errorElement.GetString()
                    : Strings.Instance.InPageExportFailed;

                return new RendererResult(false, null, error);
            }

            var dataUri = root.TryGetProperty("dataUri", out var dataElement) ? dataElement.GetString() : null;
            const string marker = "base64,";
            var separator = dataUri?.IndexOf(marker, StringComparison.Ordinal) ?? -1;

            if (string.IsNullOrEmpty(dataUri) || separator < 0)
            {
                return new RendererResult(false, null, Strings.Instance.ExportMissingPngData);
            }

            var bytes = Convert.FromBase64String(dataUri[(separator + marker.Length)..]);
            return new RendererResult(true, bytes, null);
        }
        catch (Exception ex)
        {
            return new RendererResult(false, null, ex.Message);
        }
    }
    /// <summary>
    /// 轮询预览页的视口状态：缩放比例（状态栏读数）与截下的应用级快捷键。
    /// </summary>
    /// <remarks>
    /// 快捷键走单槽 <c>window.__previewHotkey</c>：预览 WebView 持有焦点时窗口的 KeyBindings 收不到键，
    /// 由页面在捕获阶段记下命中的组合键，这里取走并清空（见 Assets/preview-viewer.js）。
    /// </remarks>
    private void StartPreviewPolling()
    {
        if (_previewPollTimer != null)
            return;

        _previewPollTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _previewPollTimer.Tick += async (_, _) =>
        {
            if (_previewWebViewControl == null || _webViewExecuteScriptMethod == null)
                return;

            try
            {
                var json = await EvaluateStringAsync(
                    "JSON.stringify({ scale: window.__previewScale ?? null, hotkey: window.__previewHotkey ?? '' })");
                if (string.IsNullOrEmpty(json))
                {
                    return;
                }

                using var document = System.Text.Json.JsonDocument.Parse(json);
                var root = document.RootElement;

                if (DataContext is MainViewModel vm &&
                    root.TryGetProperty("scale", out var scaleElement) &&
                    scaleElement.ValueKind == System.Text.Json.JsonValueKind.Number)
                {
                    vm.PreviewZoom = scaleElement.GetDouble();
                }

                if (root.TryGetProperty("hotkey", out var hotkeyElement) &&
                    hotkeyElement.ValueKind == System.Text.Json.JsonValueKind.String &&
                    hotkeyElement.GetString() is { Length: > 0 } combo)
                {
                    await ExecutePreviewScriptAsync("window.__previewHotkey = ''");
                    await HandleCanvasHotkeyAsync(combo);
                }
            }
            catch
            {
            }
        };
        _previewPollTimer.Start();
    }

    private bool EnsureWebViewReady()
    {
        if (_previewWebHost?.Child is WebView existingWebView)
        {
            _previewWebViewControl = existingWebView;
            _webViewAttached = true;
            StartPreviewPolling();
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
                            UpdateWebPreview();
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
                            UpdateWebPreview();
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
            StartPreviewPolling();
            return true;
        }
        catch
        {
            return false;
        }
    }
}

