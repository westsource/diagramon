namespace Diagramon.ViewModels;

/// <summary>
/// 布局选择器的一条（显示名已本地化）。定义在顶层而不是嵌在 <c>MainViewModel</c> 里：
/// XAML 的编译期绑定要按类型名解析 <c>x:DataType</c>，嵌套类型不好写。
/// </summary>
public sealed record LayoutChoice(string Id, string DisplayName);

/// <summary>File → New 子菜单的一条格式项。</summary>
public sealed record NewTabChoice(string FormatId, string DisplayName);