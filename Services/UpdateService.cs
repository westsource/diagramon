using System;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;

namespace Diagramon.Services;

public class UpdateService : IUpdateService
{
    private const string DefaultManifestUrl = "https://gitee.com/westsource/diagramon/raw/master/update-manifest.json";

    private readonly HttpClient _httpClient;
    private readonly SettingsService _settingsService;

    public UpdateService(SettingsService settingsService)
    {
        _settingsService = settingsService;
        _httpClient = new HttpClient();
        _httpClient.Timeout = TimeSpan.FromSeconds(15);
        _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("Diagramon");
    }

    public string GetCurrentVersion()
    {
        var attr = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>();
        if (attr != null && !string.IsNullOrWhiteSpace(attr.InformationalVersion))
        {
            var v = attr.InformationalVersion.Split('+')[0].Trim();
            if (!string.IsNullOrEmpty(v)) return v;
        }
        return "1.0.0.0";
    }

    public async Task<UpdateCheckResult> CheckForUpdateAsync()
    {
        var result = new UpdateCheckResult();

        try
        {
            var manifestUrl = _settingsService.Settings.UpdateManifestUrl;
            if (string.IsNullOrWhiteSpace(manifestUrl))
                manifestUrl = DefaultManifestUrl;

            var json = await _httpClient.GetStringAsync(manifestUrl);
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var latestVersion = root.GetProperty("version").GetString() ?? "";

            var currentVersion = GetCurrentVersion();
            result.LatestVersion = latestVersion;

            if (Version.TryParse(latestVersion, out var latestVer) &&
                Version.TryParse(currentVersion, out var currentVer))
            {
                result.HasUpdate = latestVer > currentVer;
            }
            else
            {
                result.HasUpdate = latestVersion != currentVersion;
            }

            if (root.TryGetProperty("downloadUrl", out var downloadUrl))
                result.DownloadUrl = downloadUrl.GetString() ?? "";

            if (root.TryGetProperty("releaseNotes", out var notes))
                result.ReleaseNotes = notes.GetString() ?? "";

            if (root.TryGetProperty("zipFileName", out var fileName))
                result.ZipFileName = fileName.GetString() ?? "";

            if (root.TryGetProperty("zipFileSize", out var fileSize))
                result.ZipFileSize = fileSize.GetInt64();

            if (root.TryGetProperty("publishedAt", out var publishedAt))
                result.PublishedAt = publishedAt.GetString();
        }
        catch
        {
        }

        return result;
    }

    public async Task DownloadUpdateAsync(string downloadUrl, string destinationPath, IProgress<double> progress, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();

        var totalBytes = response.Content.Headers.ContentLength ?? -1;
        await using var contentStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var fileStream = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None, 8192, true);

        var buffer = new byte[8192];
        long bytesRead = 0;
        int bytesReadInChunk;

        while ((bytesReadInChunk = await contentStream.ReadAsync(buffer, 0, buffer.Length, cancellationToken)) > 0)
        {
            await fileStream.WriteAsync(buffer, 0, bytesReadInChunk, cancellationToken);
            bytesRead += bytesReadInChunk;

            if (totalBytes > 0)
            {
                progress.Report((double)bytesRead / totalBytes);
            }
        }
    }
}
