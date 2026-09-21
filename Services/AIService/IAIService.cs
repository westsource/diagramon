using System.Collections.Generic;
using System.Threading.Tasks;
using Diagramon.Models;

namespace Diagramon.Services.AIService;

public interface IAIService
{
    string ProviderName { get; }
    bool IsConfigured { get; }
    Task<AIMessage> GenerateAsync(string prompt, string? currentCode, List<AIMessage> history, string formatId);
}
