## Open and save

- New: File → New, then pick a format (Mermaid / Graphviz DOT / drawio / Excalidraw)
- Open: File → Open (Ctrl+O), or pick from Recent Files (the tooltip shows the path; frequently used files can be pinned)
- From the command line: `Diagramon.exe example.mmd` (`.mmd` `.mermaid` `.dot` `.gv` `.drawio` `.excalidraw`)
- Save: Ctrl+S; Save As: Ctrl+Shift+S; a `*` in the tab title means unsaved changes
- Closing a tab (Ctrl+W) or quitting (Ctrl+Q) with unsaved changes asks save / discard / cancel first
- Saved files enter Recent Files, and they also decide where Ctrl+S writes next

## Editing

- The text is the single source of truth: the Mermaid / DOT / drawio / Excalidraw source *is* the file on disk; the canvas is only a view of it
- Syntax highlighting follows the format; Ctrl+F opens find & replace; Ctrl+Z / Ctrl+Y undo & redo; Ctrl+X / C / V / A cut / copy / paste / select all
- The triangle button (▶/◀) on the splitter hides the editor for a full-width preview; the strip under the editor expands/collapses the AI assistant

## Canvas gestures (identical in all four views)

- Wheel = pan; Shift+wheel = horizontal pan
- Ctrl+wheel = zoom, anchored at the cursor; trackpad pinch takes the same path
- Drag = pan (the preview panes are read-only, so the left button pans; inside a canvas the left button selects - pan with the middle button or space+drag)
- Double-click = fit to view; Ctrl+0 = fit to view; Ctrl+= zoom in one step; Ctrl+- zoom out one step
- "Fit" follows each format's own whole picture: the preview panes and Excalidraw fill the view with the content, drawio fills it with the page
- The percentage at the right of the status bar shows the zoom of the active view and follows both the wheel and the shortcuts above

## Image export and copy

- The floating buttons at the bottom-right of the preview area: top = save preview image (PNG), bottom = copy preview image to the clipboard
- Scaling lives in Settings → Image Scale Settings: use a fixed scale, or let it pick one from the diagram complexity (1.5x – 5x)
- Mermaid exports through the Mermaid CLI (mmdc); DOT rasterizes inside the preview page (zero subprocess, transparent PNG);
  drawio / Excalidraw rasterize in-page as well (zero subprocess too)

## Per-format notes

- Mermaid: rendering and "save preview image" use the bundled Node and Chrome headless - nothing extra to install
- Graphviz DOT: rendering happens in-page through Graphviz WASM; the layout engine (dot / neato / fdp / sfdp / twopi / circo) is picked at the right of the status bar and switching does not reload the engine
- drawio: the canvas *is* the editor and the editor/preview panes step aside; canvas edits are written back into the text after a 1.5 s autosave debounce; Save / Save As first pull the canvas' current XML,
  so edits made inside that debounce window are never lost; the canvas' own Save button is switched off, leaving the app's save (Ctrl+S) as the single entry;
  File → Convert to drawio diagram hands the current Mermaid source to drawio's own parser and opens the result in a new tab (one-way)
- Excalidraw: library-style integration (instantiated inside our own carrier page); the document persists only a small slice of appState - the viewport is page-level transient,
  so switching back pulls the view back to the content when it is off-screen; File → Convert to Excalidraw diagram runs mermaid-to-excalidraw (one-way)

## AI assistant

- Settings → AI Settings picks a provider: bring your own key (OpenAI / Azure OpenAI / Ollama / any OpenAI-compatible endpoint) or the membership cloud gateway
- BYOK keeps your API key on this machine; the membership gateway is metered in credits and uses the current access token, fetched per request and never persisted
- Image recognition is supported: hand a screenshot or a local image to the model and get diagram code back for the current format (one generation, undoable)
- A render error can be fixed by the AI once; code or images only leave your machine when you explicitly ask for it

## Membership and cloud documents

- Account → Sign in / Sign out; once signed in you can save to and open from the cloud
- Cloud documents are uploaded per document and explicitly: nothing you open is uploaded automatically, and concurrent writes to the same name surface a conflict instead of silently overwriting

## Keyboard shortcuts

- Ctrl+N new / Ctrl+O open / Ctrl+S save / Ctrl+Shift+S save as / Ctrl+W close tab / Ctrl+Q quit
- Ctrl+Z undo / Ctrl+Y (or Ctrl+Shift+Z) redo / Ctrl+X cut / Ctrl+C copy / Ctrl+V paste / Ctrl+A select all / Ctrl+F find & replace
- Ctrl+0 fit to view / Ctrl+= zoom in one step / Ctrl+- zoom out one step
- When the focus is inside the preview pane or a canvas (keys land on the WebView first), the carrier page forwards the "application-level" shortcuts above back to the host;
  editing keys such as undo and cut still belong to the canvas itself, to preserve its own edit history

## Offline and privacy

- Rendering (Mermaid / Graphviz / drawio / Excalidraw) happens entirely on this machine: the runtimes ship with the app, pages are served from an in-process loopback origin, zero external requests
- Only when you explicitly use the AI are code or images sent to the chosen model service; an offline guard blocks any unexpected network access from a page and reports it in the status bar

## When something goes wrong

- Unhandled exceptions are written to `%LOCALAPPDATA%\Diagramon\crash.log` (timestamp and call stack)
- The WebView2 runtime is required (Windows 10/11 usually ships it); when missing, the status bar says so explicitly
- If a canvas or preview pane stays blank or reports missing assets: the drawio, Excalidraw and Graphviz assets come from the fetch scripts under `tools\`
  (`fetch-drawio.ps1` / `fetch-excalidraw.ps1` / `fetch-graphviz.ps1`) - missing assets never degrade silently
- Status-bar errors are worded by whose problem it is: syntax/render errors, missing assets, AI upstream errors, network and offline blocks
