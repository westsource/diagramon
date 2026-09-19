using System;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Platform.Storage;

namespace Diagramon.Services;

public class FileService
{
    private IStorageProvider? _storageProvider;

    public FileService()
    {
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
            Title = "打开 Mermaid 文件",
            AllowMultiple = false,
            FileTypeFilter = new[]
            {
                new FilePickerFileType("Mermaid 文件")
                {
                    Patterns = new[] { "*.mmd", "*.mermaid" }
                },
                new FilePickerFileType("所有文件")
                {
                    Patterns = new[] { "*.*" }
                }
            }
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

    public async Task<string?> SaveFileAsync(string content, string? defaultName = null)
    {
        if (_storageProvider == null) return null;

        var file = await _storageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = "保存 Mermaid 文件",
            SuggestedFileName = defaultName ?? "未命名.mmd",
            FileTypeChoices = new[]
            {
                new FilePickerFileType("Mermaid 文件")
                {
                    Patterns = new[] { "*.mmd" }
                },
                new FilePickerFileType("Mermaid 文件")
                {
                    Patterns = new[] { "*.mermaid" }
                }
            }
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
