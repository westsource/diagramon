# Diagramon - Mermaid Diagram Editor

A local Mermaid diagram editor built with C# Avalonia, featuring code editing, syntax highlighting, real-time preview with zoom/pan/fit, syntax validation, image export and copy, and an AI assistant for generating diagrams via natural language. All rendering is done locally — no data uploaded.

**Version**: 2.0.260503.3

## Screenshots

![Main Interface](screenshots/Diagramon_NELcF3ITQN.png)

![AI Assistant](screenshots/Diagramon_fxJXInfYWk.png)

## Features

### Code Editing
- **Syntax Highlighting** - Mermaid syntax highlighting with line numbers via a custom `MermaidHighlightingProvider`
- **Multi-tab** - Edit multiple files independently with automatic tab switching; each tab has a close button; tab close confirmation for unsaved changes with Save/Don't Save/Cancel dialog
- **Debounced Rendering** - Auto-renders after 350ms of inactivity to avoid excessive refreshes
- **Context Menu** - Full right-click context menu in the code editor: Undo, Redo, Cut, Copy, Paste, Select All, with keyboard shortcuts
- **Close Tab Confirmation** - Closing an unsaved tab prompts Save / Don't Save / Cancel; on app exit, all modified tabs are prompted

### Real-time Preview
- **JavaScript Injection Updates** - Initial load via WebView file navigation; subsequent updates use `ExecuteScriptAsync` to inject JavaScript directly, bypassing file caching and navigation issues
- **Global renderDiagram Function** - The `renderDiagram(code)` function is exposed globally for zero-latency script injection updates
- **Drag to Pan** - Hold left mouse button and drag to move the diagram
- **Scroll to Zoom** - Zoom from 0.2x to 30x via mouse wheel (zoom centers on cursor position); zoom level displayed in status bar
- **Double-click to Fit** - Auto-fit diagram to viewport on double-click
- **Error Display** - User-friendly error messages shown directly in the preview area when diagram syntax is invalid
- **Zoom Controls** - Zoom In, Zoom Out, Reset Zoom commands available
- **Status Bar** - Bottom bar shows status messages and current zoom percentage
- **Toggle Editor** - Click the triangle button (▶/◀) in the splitter bar to hide/show the editor for full-screen preview
- **Rendering Cache** - LRU cache (32 entries max) + background PNG generation after preview

### Image Operations
- **Save Image** - Click the floating Save button (top-right corner of preview area) to export a high-resolution PNG image
- **Copy Image** - Click the floating Copy button (top-right corner of preview area) to copy diagram to system clipboard as PNG
- **Adaptive Scaling** - Export automatically calculates the optimal scale (1.5x–5.0x) based on diagram complexity (element count: nodes, edges, subgraphs)

### File Operations
- Create / Open / Save Mermaid files (.mmd / .mermaid)
- Command-line argument support for opening files
- Recent files history (up to 10 files)
- Save confirmation dialog with Save/Don't Save/Cancel when closing unsaved tabs
- Unsaved change detection on application exit, prompting for each modified file
- Close Current Tab with Ctrl+W

### AI Assistant
- **Natural Language Generation** - Describe your diagram in plain language; AI generates Mermaid code automatically
- **Multi-model Support** - Configurable models: OpenAI, Azure OpenAI, Ollama (local LLMs), and Custom API endpoints
- **Model Selector** - Dropdown in the AI input area to quickly switch between configured models
- **One-click Apply** - Apply AI-generated code to the editor instantly, with "Revert" to undo
- **Conversation History** - Persisted to disk per-file (keyed by file path hash), supports continuous multi-turn conversations; storage path configurable
- **Configurable Parameters** - Temperature, MaxTokens, and other settings configurable per model
- **Selectable Messages** - Chat message text (including code) is selectable and copyable
- **Multi-line Input** - Shift+Enter for newline, Enter to send
- **Draggable Splitter** - Adjustable-height splitter between chat history and input area
- **Input Box Context Menu** - Right-click context menu: Cut/Copy/Paste/SelectAll
- **Settings Icon (⚙)** - Opens AI Settings dialog to manage models, API keys, and conversation storage path
- **API Key Security** - API keys stored encrypted via AES, separate from main settings

### Settings
- **Language Switching** - File → Settings → Language submenu; dynamically switch between available languages (en-US, zh-CN). System language auto-detected on first launch
- **AI Model Management** - File → Settings → AI Settings opens a full configuration dialog for adding, editing, and deleting AI model configs:
  - Name, Provider (OpenAI / Azure OpenAI / Ollama / Custom)
  - API Key, Base URL, Model ID
  - Max Tokens (default 4096), Temperature (default 0.7)
- **Conversation Storage Path** - Configurable directory for AI conversation history files
- **Auto-save Layout** - Editor/preview ratio, preview zoom, AI panel state (expanded/collapsed), AI panel height, and other settings automatically saved to `%APPDATA%/Diagramon/settings.json`

### Update
- **Auto Check on Startup** - Checks for updates automatically on startup (24-hour cooldown between checks, configurable)
- **Manual Check** - Help → Check for Updates menu item
- **Download Progress** - Real-time download progress display with percentage and progress bar
- **Skip Version** - Skip a specific version; won't be prompted again for that version

### About
- **Help → About** - Displays application name, description, author (黄超/道荣), and current version
- **Help → Mermaid Documentation** - Opens `https://mermaid.js.org/intro/` in the default web browser

### UI Features
- **Draggable Splitter** - Editor/preview ratio adjustable via drag (editor min 320px, max 860px; preview min 480px)
- **Built-in Toggle Button** - Triangle button (▶/◀) in the splitter bar to hide/show the editor
- **Fluent Theme** - Modern UI style
- **Auto-save Layout** - Editor ratio, zoom level, AI panel state, and other settings auto-saved
- **Status Bar** - Status messages and zoom percentage displayed at bottom
- **Tab Close Button** - Each tab has a close "×" button

### Technical Details
- Preview uses `CoreWebView2.ExecuteScriptAsync` for JavaScript injection, bypassing file:// URL caching and navigation restrictions
- AI configuration Base URL is automatically sanitized (removes trailing `/chat/completions` or `/v1/chat/completions`)
- Preview temporary files are cleaned up by creation time (only keep last 7 days)
- **Rendering Cache**: LRU cache (32 entries max) caches rendered PNG images by content hash (SHA256)
- **Background PNG Generation**: After validation, a background task generates high-quality PNG at adaptive scale for save/copy
- **Secure Storage**: API keys stored encrypted (AES) in a separate `secure.config` file
- **Adaptive Export Scale**: Scale calculated based on diagram element count (1.5x for simple, up to 5.0x for complex)

## Tech Stack

- **Language**: C# (.NET 10)
- **UI Framework**: Avalonia UI 11.3
- **Architecture**: MVVM (CommunityToolkit.Mvvm)
- **Code Editor**: AvaloniaEdit
- **Preview Rendering**: Mermaid.js (real-time via WebView)
- **Image Export**: Mermaid CLI 11.12.0 (embedded, for high-res image export)
- **WebView**: WebView.Avalonia

## Requirements

### Development Environment
- .NET 10 SDK
- Avalonia templates

### Running Packaged Version
- Windows (requires WebView2 runtime, pre-installed on Windows 10/11)
- No Node.js or other dependencies required — self-contained, just run the executable

## Building

### Development Mode

```bash
dotnet restore
dotnet run
```

Open file via command line:

```bash
dotnet run -- example.mmd
```

### Publish Self-Contained Version

Use the included publish script:

```powershell
.\publish.ps1
```

Or manually:

```bash
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

> Note: Mermaid CLI tools are embedded as resources — no need to manually copy the `tools` directory.

## Usage

### Opening Files

- Menu: File → Open (Ctrl+O)
- Command line: `Diagramon.exe example.mmd`
- Recent files: File → Recent Files

Supports .mmd and .mermaid extensions.

### Editing Code

Enter or modify Mermaid code in the left editor panel. The right preview area updates automatically after a brief debounce delay (350ms).

- Right-click in the editor for the context menu: Undo / Redo / Cut / Copy / Paste / Select All
- Closing an unsaved tab prompts Save / Don't Save / Cancel

### Saving Files

- Save: File → Save (Ctrl+S)
- Save As: File → Save As (Ctrl+Shift+S)

### Exporting Images

- Click the **Save** button (floating popup, top-right corner of the preview area) to save a PNG image file
- Click the **Copy** button (floating popup, top-right corner of the preview area) to copy the diagram image to the clipboard
- Export scale is automatically calculated based on diagram complexity

### Preview Controls

- **Pan**: Hold left mouse button and drag in the preview area
- **Zoom**: Scroll mouse wheel (zoom centers on cursor position); zoom level shown in the status bar
- **Fit to Viewport**: Double-click the preview area
- **Toggle Editor**: Click the triangle button (▶/◀) in the splitter bar between editor and preview
- **Status Bar**: Bottom bar shows current zoom percentage on the right

### AI Assistant

1. Click the "AI Assistant" button at the bottom to expand the panel
2. Describe the diagram you want in the input box (e.g., "Draw a user login flowchart"); Shift+Enter for newline, Enter to send
3. Use the model selector dropdown next to the send button to choose between configured models
4. AI will generate the corresponding Mermaid code
5. Click "Apply Code" to insert the generated code into the editor; "Revert" to undo
6. Click the settings icon (⚙) to open the Settings dialog for managing model configurations
7. Right-click in the input text box for Cut/Copy/Paste/SelectAll options
8. Chat messages are selectable and copyable; the chat history/input area ratio is adjustable via the drag splitter
9. Click the trash icon (🗑) to clear the current conversation history

### Settings

- **Language**: File → Settings → Language → select your preferred language (en-US or zh-CN). Auto-detected on first launch
- **AI Settings**: File → Settings → AI Settings (or click ⚙ in the AI panel). Here you can:
  - Add new AI model configurations (name, provider, API key, base URL, model ID, max tokens, temperature)
  - Edit or delete existing model configs
  - Set the conversation history storage path
- All settings are auto-saved to `%APPDATA%/Diagramon/settings.json`

### Updates

- **Auto Check**: On startup, Diagramon automatically checks for updates (24-hour cooldown)
- **Skip Version**: Skip a specific version; no further notifications for that version
- **Manual Check**: Help → Check for Updates
- **Download**: When an update is available, click "Download Update" with real-time progress display

### About

- Help → About: View application name, description, author, and version
- Help → Mermaid Documentation: Opens Mermaid.js official documentation in your browser

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+N | New File |
| Ctrl+O | Open File |
| Ctrl+S | Save File |
| Ctrl+Shift+S | Save As |
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
- [AvaloniaEdit](https://github.com/AvaloniaUI/AvaloniaEdit) - Code editor control
- [Mermaid.js](https://mermaid.js.org/) - Mermaid diagram rendering engine (preview)
- [Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) - Mermaid diagram rendering engine (export)
- [WebView.Avalonia](https://github.com/AvaloniaUI/AvaloniaWebView) - WebView control
- [CommunityToolkit.Mvvm](https://learn.microsoft.com/dotnet/communitytoolkit/mvvm/) - MVVM toolkit
