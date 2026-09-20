# Diagramon - Mermaid Diagram Editor

A local Mermaid diagram editor built with C# Avalonia. Features code editing with syntax highlighting, real-time preview (pan/zoom/fit-to-viewport), syntax validation, high-resolution PNG export and clipboard copy, and an AI assistant for generating diagrams from natural language. **All rendering is done locally — no data uploaded.**

Version **v2.0.260513.0**

## Screenshots

![Main Interface](screenshots/Diagramon_NELcF3ITQN.png)

![AI Assistant](screenshots/Diagramon_fxJXInfYWk.png)

## Features

### Code Editing
- **Syntax Highlighting** - Custom Mermaid syntax highlighting definition (Xshd) covering keywords, directives, node IDs, edge labels, participant names, class members, etc.
- **Find & Replace** - Integrated SearchPanel for code search/replace
- **Multi-tab** - Edit multiple files independently with close buttons and mouse wheel tab switching
- **Debounced Rendering** - Auto-renders after 350ms of inactivity to avoid excessive refreshes
- **Context Menu** - Right-click context menu: Undo, Redo, Cut, Copy, Paste, Select All
- **Close Tab Confirmation** - Save / Don't Save / Cancel dialog when closing unsaved tabs; prompted on app exit for all modified tabs
- **Crash Protection** - Unhandled exceptions are captured to `%LOCALAPPDATA%/Diagramon/crash.log`

### Real-time Preview
- **JavaScript Injection** - Initial load via WebView file navigation; subsequent updates use CoreWebView2.ExecuteScriptAsync for zero-latency script injection
- **Off-screen Rendering** - SVG rendered in an absolutely-positioned off-screen container to avoid layout interference
- **Drag to Pan** - Hold left mouse button and drag to move the diagram
- **Scroll to Zoom** - Zoom from 20% to 3000% via mouse wheel (centered on cursor); zoom level shown in status bar
- **Double-click to Fit** - Auto-fit diagram to viewport on double-click
- **Error Display** - User-friendly error messages shown directly in the preview area
- **Toggle Editor** - Click the triangle button (▶/◀) in the splitter bar to hide/show the editor for full-screen preview
- **Rendering Cache** - LRU cache (32 entries max) + background PNG generation after preview
- **WebView Shortcuts** - Ctrl+S triggers save even when the preview area has focus

### Image Operations
- **Save Image** - Click the floating Save button (top-right of preview area) to export a high-resolution PNG/JPEG image
- **Copy Image** - Click the floating Copy button to copy the diagram to the system clipboard as PNG
- **Adaptive Scaling** - Export automatically calculates optimal scale (1.5x–5.0x) based on diagram complexity (node/edge/subgraph count)

### File Operations
- Create / Open / Save Mermaid files (`.mmd` / `.mermaid`)
- Command-line argument support (`Diagramon.exe example.mmd`)
- Recent files history (up to 10 files) with **history dialog** (File → Recent Files → More...) supporting search filtering and double-click to open
- Save confirmation dialog with Save / Don't Save / Cancel
- Unsaved change detection on application exit, prompting for each modified file
- Auto-record files to recent history on first save

### AI Assistant
- **Natural Language Generation** - Describe your diagram in plain language; AI generates Mermaid code automatically
- **Multi-model Support** - OpenAI, Azure OpenAI, Ollama (local LLMs), Custom API (any OpenAI-compatible backend)
- **Model Selector** - Dropdown to quickly switch between configured models
- **One-click Apply & Revert** - Apply generated code to the editor; revert to undo
- **Persistent Conversations** - Conversation history saved per file (SHA256 hash of file path); storage path is configurable
- **Configurable Parameters** - Independent Temperature, MaxTokens (up to 2,000,000) per model
- **Selectable Messages** - Chat messages (including code) are selectable and copyable
- **Multi-line Input** - Shift+Enter for newline, Enter to send
- **Input Context Menu** - Right-click for Cut/Copy/Paste/Select All
- **Draggable Splitter** - Adjustable splitter between chat history and input area (80px ~ 320px)
- **Settings (⚙)** - Open AI settings dialog for model management
- **Clear History (🗑)** - Clear current conversation with one click
- **API Key Security** - AES-encrypted storage in separate `secure.config` file, isolated from main settings

### Settings
- **Language** - File → Settings → Language to switch between en-US and zh-CN; auto-detected on first launch
- **AI Model Management** - File → Settings → AI Settings (or click ⚙ in AI panel) to add/edit/delete models:
  - Name, Provider (OpenAI / Azure OpenAI / Ollama / Custom)
  - API Key (DPAPI encrypted), Base URL (auto-cleaned of trailing paths like `/chat/completions`)
  - Model ID, Max Tokens (default 4096, max 2,000,000), Temperature (default 0.7)
  - Azure OpenAI: Endpoint, Deployment Name
- **Conversation Storage Path** - Configurable directory for AI conversation history (default: `%APPDATA%/Diagramon/Conversations`)
- **Auto-save Layout** - Editor width, preview zoom, AI panel expansion state and height auto-saved to `%APPDATA%/Diagramon/settings.json`

### Updates
- **Auto Check** - Checks for updates on startup (24-hour cooldown, configurable); manifest URL is customizable
- **Download** - Direct download with live progress bar, or open in default browser
- **Skip Version** - Skip a specific version permanently
- **Manual Check** - Help → Check for Updates (grouped with About)

### About
- Help → About: App name, description, author (道荣 & 黄超), current version
- Help → Mermaid Documentation: Opens Mermaid.js official docs in browser

### UI Features
- **Draggable Splitter** - Adjustable editor/preview ratio (editor: 320px ~ 860px; preview: min 480px)
- **One-click Toggle** - Click the triangle button (▶/◀) in the splitter to hide/show the editor
- **Fluent Theme** - Modern Windows UI style
- **Auto-save Layout** - Editor ratio, zoom level, AI panel state auto-saved
- **Status Bar** - Left: status messages; Right: zoom percentage
- **Access Keys** - Menu and buttons support Alt+underlined-letter shortcuts
- **Tab Close Buttons** - Each tab has a × close button

### Technical Details
- Preview rendering uses `CoreWebView2.ExecuteScriptAsync` for JS injection, bypassing file:// URL cache and navigation issues; initial load via Navigate to local HTML file
- AI Base URL auto-cleaned (removes trailing `/chat/completions`, `/v1/chat/completions`, `/api/chat`, etc.)
- Preview temp files cleaned at startup (only keeps files from the last 7 days)
- API Keys stored in AES-encrypted `secure.config`, separate from main settings
- Render cache uses LRU strategy (max 32 entries) with SHA256 content hashing
- Export scale adapts based on element count (nodes/edges/subgraphs determine 1.5x ~ 5.0x)
- Code editor uses AvaloniaEdit with custom Mermaid syntax highlighting (Xshd definition)
- Mermaid CLI bundled in `tools/` directory; no Node.js installation required
- Build-time Avalonia path separator compatibility workaround for .NET 10 SDK
- Debug builds auto-copy WebView2Loader.dll to output directory

## Tech Stack

- **Language**: C# (.NET 10)
- **UI Framework**: Avalonia UI 11.3.0, Fluent Theme
- **Architecture**: MVVM (CommunityToolkit.Mvvm 8.4.0)
- **Code Editor**: AvaloniaEdit 11.4.1
- **Preview Rendering**: Mermaid.js via WebView (WebView.Avalonia 11.0.0.1)
- **Image Export**: Mermaid CLI (embedded Node.js tool for high-res PNG)
- **WebView**: WebView.Avalonia 11.0.0.1 (CoreWebView2)
- **Icon Font**: Inter Font

## Requirements

### Development
- .NET 10 SDK

### Running Packaged Version
- Windows (WebView2 runtime required; pre-installed on Windows 10/11)
- No Node.js or other dependencies needed — Self-Contained double-click to run

## Building

### Development Mode

```bash
dotnet restore
dotnet run
```

Open file via command-line argument:

```bash
dotnet run -- example.mmd
```

### Publishing Self-Contained

Use the publish scripts:

```powershell
.\publish1-build.ps1
.\publish2-release.ps1
```

Or manual dotnet publish:

```bash
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

## Usage

### Opening Files
- Menu: File → Open (Ctrl+O)
- Command line: `Diagramon.exe example.mmd`
- Recent files: File → Recent Files → **More...** button for searchable history dialog
- Supports `.mmd` and `.mermaid` extensions

### Editing Code

Enter or modify Mermaid code in the left editor panel. The right preview area updates automatically after a 350ms debounce delay. Ctrl+F for find/replace.

- Right-click for context menu: Undo / Redo / Cut / Copy / Paste / Select All
- Unsaved tab close prompts Save / Don't Save / Cancel

### Saving Files

- Save: File → Save (Ctrl+S)
- Save As: File → Save As (Ctrl+Shift+S)

### Exporting Images

- Click the floating **Save** button (top-right of preview area) to save a PNG/JPEG image file
- Click the floating **Copy** button to copy the diagram to clipboard as PNG
- Export scale is automatically calculated based on diagram complexity

### Preview Controls

- **Pan**: Hold left mouse button and drag in the preview area
- **Zoom**: Scroll mouse wheel (centered on cursor); zoom level shown in status bar
- **Fit to Viewport**: Double-click the preview area
- **Toggle Editor**: Click the triangle button (▶/◀) in the splitter bar

### AI Assistant

1. Click the "AI Assistant" button at the bottom to expand the panel
2. Describe the diagram you want in the input box (e.g., "Draw a user login flowchart"); Shift+Enter for newline, Enter to send
3. Use the model selector dropdown to choose between configured models
4. AI generates the corresponding Mermaid code
5. Click "Apply Code" to insert into the editor; "Revert" to undo
6. Click the settings icon (⚙) to manage model configurations
7. Right-click in the input text box for Cut/Copy/Paste/Select All
8. Chat messages are selectable and copyable; the chat history/input area ratio is adjustable
9. Click the trash icon (🗑) to clear the current conversation

### Settings

- **Language**: File → Settings → Language (en-US or zh-CN). Auto-detected on first launch
- **AI Model Management**: File → Settings → AI Settings (or click ⚙ in AI panel):
  - Name, Provider (OpenAI / Azure OpenAI / Ollama / Custom)
  - API Key (DPAPI encrypted), Base URL (auto-cleaned), Model ID
  - Max Tokens (1~2,000,000), Temperature (0.0~2.0)
  - Azure OpenAI: Endpoint, Deployment Name
- **Conversation Path**: Configurable storage directory for AI conversation history
- **Auto-save Layout**: Editor width, preview zoom, AI panel state/height auto-saved
- All settings are auto-saved to `%APPDATA%/Diagramon/settings.json`

### Updates

- **Auto Check**: On startup, Diagramon automatically checks for updates (24-hour cooldown, configurable)
- **Skip Version**: Skip a specific version; no further notifications for that version
- **Manual Check**: Help → Check for Updates
- **Download**: Direct download with real-time progress, or via default browser
- **Skip Version**: Permanently skip a specific version

### About

- Help → About: App name, features, author (道荣 & 黄超), version
- Help → Mermaid Documentation: Opens mermaid.js.org in browser

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New File |
| Ctrl+O | Open File |
| Ctrl+S | Save File |
| Ctrl+Shift+S | Save As |
| Ctrl+F | Find/Replace |
| Ctrl+W | Close Current Tab |
| Ctrl+Q | Exit |
| Ctrl+Z | Undo |
| Ctrl+Y / Ctrl+Shift+Z | Redo |
| Ctrl+X | Cut |
| Ctrl+C | Copy |
| Ctrl+V | Paste |
| Ctrl+A | Select All |

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) file for details.

## Acknowledgments

This project uses the following open-source projects:

- [Avalonia UI](https://avaloniaui.net/) - Cross-platform UI framework
- [AvaloniaEdit](https://github.com/AvaloniaUI/AvaloniaEdit) - Code editor control (with SearchPanel)
- [Mermaid.js](https://mermaid.js.org/) - Mermaid diagram rendering engine (preview)
- [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) - Mermaid diagram rendering engine (high-res PNG export)
- [WebView.Avalonia](https://github.com/AvaloniaUI/AvaloniaWebView) - WebView control
- [CommunityToolkit.Mvvm](https://learn.microsoft.com/dotnet/communitytoolkit/mvvm/) - MVVM toolkit
- [Inter Font](https://rsms.me/inter/) - UI font

