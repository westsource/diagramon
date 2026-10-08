using System;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Platform.Storage;
using Diagramon.Services.Documents;
using Diagramon.Services.Localization;

namespace Diagramon.Services;

public class FileService
{
    private static readonly Strings S = Strings.Instance;

    private readonly DocumentFormatRegistry _formats;
    private IStorageProvider? _storageProvider;

    public FileService(DocumentFormatRegistry formats)
    {
        _formats = formats;
    }

    public void SetStorageProvider(IStorageProvider storageProvider)
    {
        _storageProvider = storageProvider;
    }

    public async Task<(string? Content, string? FilePath)> OpenFileAsync()
    {
        if (_storageProvider == null) return (null, null);

        var files = await _storageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = S.OpenFileDialogTitle,
            AllowMultiple = false,
            FileTypeFilter = _formats.BuildOpenPickerTypes()
        });

        var file = files.Count > 0 ? files[0] : null;
        if (file == null) return (null, null);

        var content = await file.OpenReadAsync().ContinueWith(t =>
        {
            using var reader = new StreamReader(t.Result);
            return reader.ReadToEnd();
        });

        return (content, file.Path.LocalPath);
    }

    public async Task<string?> OpenFileFromPathAsync(string filePath)
    {
        if (!File.Exists(filePath)) return null;
        return await File.ReadAllTextAsync(filePath);
    }

    /// <summary>
    /// 弹"另存为"对话框并把内容写过去；取消返回 <c>null</c>。
    /// </summary>
    /// <remarks>
    /// 过滤器与缺省扩展名都**跟着当前文档格式走**（<see cref="DocumentFormatRegistry.SuggestSaveFileName"/>）：
    /// 建议文件名带该格式的规范扩展名，对话框的过滤器也以它为首项，因此用户不写扩展名时得到的是
    /// 与内容相符的后缀（drawio 标签页不会再被存成 <c>.mmd</c>）。
    /// </remarks>
    public async Task<string?> SaveFileAsync(string content, IDocumentFormat format, string? suggestedName = null)
    {
        if (_storageProvider == null) return null;

        var fileName = _formats.SuggestSaveFileName(format, suggestedName);
        var defaultExtension = _formats.CanonicalExtension(format).TrimStart('.');

        var file = await _storageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = S.SaveFileDialogTitle,
            SuggestedFileName = fileName,
            // Win32 的 lpstrDefExt 要的是不带点的扩展名；即便某个后端忽略它，
            // 建议文件名本身已经带了正确后缀，结果依然一致。
            DefaultExtension = defaultExtension,
            FileTypeChoices = _formats.BuildSavePickerTypes(format)
        });

        if (file == null) return null;

        await using var stream = await file.OpenWriteAsync();
        await using var writer = new StreamWriter(stream);
        await writer.WriteAsync(content);

        return file.Path.LocalPath;
    }

    public async Task SaveFileToPathAsync(string content, string filePath)
    {
        var directory = Path.GetDirectoryName(filePath);
        if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
        {
            Directory.CreateDirectory(directory);
        }
        await File.WriteAllTextAsync(filePath, content);
    }

    public async Task<string?> SaveImageAsync(byte[] imageData, string? defaultName = null)
    {
        if (_storageProvider == null) return null;

        var file = await _storageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = "保存图片",
            SuggestedFileName = defaultName ?? "diagram.png",
            FileTypeChoices = new[]
            {
                new FilePickerFileType("PNG 图片")
                {
                    Patterns = new[] { "*.png" }
                },
                new FilePickerFileType("JPEG 图片")
                {
                    Patterns = new[] { "*.jpg", "*.jpeg" }
                }
            }
        });

        if (file == null) return null;

        await using var stream = await file.OpenWriteAsync();
        await stream.WriteAsync(imageData);

        return file.Path.LocalPath;
    }
}
