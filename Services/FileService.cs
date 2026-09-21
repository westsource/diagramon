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

    public async Task<string?> SaveFileAsync(string content, string? defaultName = null)
    {
        if (_storageProvider == null) return null;

        var file = await _storageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = S.SaveFileDialogTitle,
            SuggestedFileName = defaultName ?? S.UntitledMermaidFileName,
            FileTypeChoices = _formats.BuildSavePickerTypes()
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
