using System;
using System.Threading;
using System.Threading.Tasks;
using Diagramon.Models;

namespace Diagramon.Services;

public interface IUpdateService
{
    Task<UpdateCheckResult> CheckForUpdateAsync();
    Task DownloadUpdateAsync(string downloadUrl, string destinationPath, IProgress<double> progress, CancellationToken cancellationToken);
    string GetCurrentVersion();
}
