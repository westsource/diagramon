# Diagramon - Multi-format Diagram Editor

[中文文档](README.zh-CN.md)

A **local-first** multi-format diagram editor: **Mermaid**, **Graphviz DOT**, **D2**, **drawio** and
**Excalidraw** in one window — edit, live-preview and convert between them, with AI on a channel you
choose. Rendering, validation and conversion all run on your machine, and no diagram is ever sent to a
server.

Version **3.11.2** · Official website <https://www.diagramon.com>

## Screenshots

![Main window](screenshots/01-main-light.png)

![AI image recognition](screenshots/02-ai-vision.png)

![drawio canvas](screenshots/03-drawio-canvas.png)

![Excalidraw canvas](screenshots/04-excalidraw-canvas.png)

![Dark theme](screenshots/05-dark-preview.png)

![Cloud documents](screenshots/06-cloud-docs.png)

![Account and AI credits](screenshots/07-cloud-account.png)

![D2 preview](screenshots/08-d2-preview.png)

## Problems it solves

**1. One diagram, five tools.** You write Mermaid in an editor and open mermaid.live to see it; halfway
through you want to drag a box, so you rebuild the thing in drawio; DOT and D2 mean two more browser tabs.
Every move is copy-paste-realign-check-the-styling again.

**2. Online diagram tools want your content first.** Architecture and flow diagrams carry real service
names, internal hostnames and customer names. Online editors upload before they render — a leak before a
picture. Purely offline tools, on the other hand, have no AI at all, so polishing a description means
writing prompts somewhere else and pasting back.

**3. AI you cannot audit.** Diagram tools usually ship the whole document to one fixed service: you cannot
see what was sent, how much of it, or what it cost; your own model or self-hosted gateway cannot be
plugged in; the key lives in the browser.

**4. Canvas files do not fit a repository.** A dragged-together diagram arrives as a compressed blob or a
wall of JSON; a diff tells you nothing and code review cannot look at it.

**5. Converters break diagrams and stay quiet about it.** Borders go missing, styling is lost, an arrow
points the wrong way — and the tool reports "success".

## How we solve them

1. **One window, five formats, conversions between them.** Text and canvas formats open side by side;
   Mermaid / DOT / D2 convert into drawio / Excalidraw and stay editable, and D2 converts into drawio with
   its geometry intact.
2. **Everything renders locally.** The Mermaid, Graphviz and D2 engines ship inside the installer (packaged
   JS, WASM, the official D2 wasm build), and drawio / Excalidraw run on their own bundled runtimes.
   **No subprocess is ever spawned and no external request is ever made** — it works offline.
3. **What lands on disk is always text.** A `.drawio` file is mxfile XML and a `.excalidraw` file is scene
   JSON; the canvas is just a view of it, so changes stay diffable, committable and reviewable.
4. **AI on the channel you pick.** Members use the official gateway (the credential is the login token, so
   you fill in nothing); BYOK talks straight to your own OpenAI-compatible service, Ollama or self-hosted
   endpoint. Keys live inside the Rust process only (DPAPI on Windows) and never reach the front end.
   Content goes to a model only when you actively use AI, and only to the endpoint you chose.
5. **Lossy conversions say so.** Every result carries a list of what did not migrate, and both sides are
   counted afterwards — if nodes or edges went missing, you are told how many.

## Features

### Editing
- **Five formats, many tabs** — `Mermaid` (`.mmd` / `.mermaid`), `Graphviz DOT` (`.dot` / `.gv`), `D2`
  (`.d2`), `drawio` (`.drawio`) and `Excalidraw` (`.excalidraw`) side by side; overflowing tabs scroll into
  view, respond to the wheel and fade at both ends, and `Ctrl+Tab` / `Ctrl+PgUp` cycle through them
- **Engine-level syntax checking** — problems are parsed and reported by the graphics engines themselves,
  with the real line (and column, for Mermaid); clicking a problem jumps the caret to that spot and marks
  the line. D2 is really compiled by its bundled wasm; drawio / Excalidraw get structural validation. An
  unavailable engine or an oversized document is labelled **degraded** — "not checked" is never reported as
  "passed"
- **Outline and current scope** — nodes and the `subgraph` / `cluster` / D2 container tree are derived from
  the body; clicking scrolls the source there. Canvas documents get a group/node outline that selects and
  centres the item. The status bar shows the enclosing container at the caret
- **Find & replace, undo/redo, context menu, command palette** (`Ctrl+Shift+P` / `F1`)
- **Tab behaves like mainstream editors** — spaces to the next tab stop, block indent for a selection,
  `Shift+Tab` outdents, one key press is one undo step
- **Large-document guard rails** — opening, saving or rendering a diagram beyond 400 KB / 5,000 lines asks
  once instead of silently dragging the engine down

### Preview and export
- **Source / split / preview** (`Ctrl+1/2/3`), with the source pane hideable
- **One gesture vocabulary** — wheel to pan, `Shift+wheel` horizontally, `Ctrl+wheel` zooms anchored at the
  cursor, drag to pan, double-click to fit
- **"Fit" means content** — fitting uses the diagram's own bounding box in both dimensions (drawio's page
  frame is deliberately ignored); the view refits when panels, splitters or the window resize (can be
  turned off); the status bar shows the active view's zoom only
- **Layout and look on the fly** — DOT offers six layouts, D2 offers `dagre` / `elk` / `tala`, Mermaid
  offers `dagre` and `elk`; Mermaid look is `classic` / `neo` / `handDrawn`. The controls sit in the
  preview top bar, the choice is **remembered per file**, and the diagram re-renders immediately
- **Export** — PNG at a selectable scale or straight to the clipboard; bitmaps carry the same background
  as the preview, and a diagram past Chromium's canvas limit has its scale reduced with a note instead of
  producing an empty image
- **Render output is sanitized before mounting**, and the shell document ships a CSP that allows no inline
  script

### Canvas editing (drawio / Excalidraw)
- **The canvas *is* the editor** — drag and connect directly; neither format offers the source triple
- **Edits write back automatically** into the tab body and raise the dirty flag; saving first asks the
  canvas for its latest body, so edits inside its autosave debounce are never lost
- **Undo history survives** — switching tabs never destroys the carrier page
- **Offline by construction** — both runtimes ship inside the installer and make zero external requests

### Format conversion
- **Directions** — `Mermaid → DOT` / `Mermaid → D2` / `DOT → D2` / `Mermaid → drawio` /
  `Mermaid → Excalidraw` / `D2 → drawio` (geometry preserved, and the result stays draggable and editable)
- **One-way semantics** — the product opens in a new tab and the original file's bytes never change
- **Lossy is spelled out** — the result carries `notes` listing exactly what did not migrate, shown in the
  dialog
- **Post-conversion reconciliation** — nodes and edges are counted on both sides; a shortfall is reported as
  "N nodes / M edges missing", and when a side cannot be counted the app says exactly that
- **AI-enhanced conversion** (optional, off by default) — offered when the result is lossy or fails
  validation; one initial fix plus up to 3 correction rounds, stops early after two identical errors, and
  shows what will be sent on first use
- **`Mermaid → drawio` can re-layout with ELK**; unavailable directions are still listed, with a reason
- **The details that used to break output are handled** — edge endpoint markers, nodes named like DOT
  keywords, D2's stroke-width range, parentheses inside rounded labels, and more

### Workspace and files
- **Open a folder** — explorer tree (only extensions this app knows; `.git` / `node_modules` / `target` are
  skipped), sortable by name or last-modified time in either direction, folders-first option; Chinese names
  sort by pinyin and numbers compare numerically ("diagram 2" before "diagram 10")
- **Whole-workspace search** (`Ctrl+Shift+H` / `Alt+2`) — results stream in with line/column, click to jump,
  cancellable
- **File watching** — external changes are picked up; a collision with unsaved local edits raises a banner
  to choose "use disk version / keep mine"
- **Single instance + file associations** — double-clicking a diagram file opens it in the running window
- **Autosave is off by default**, switchable in Settings (500–60000 ms); unsaved documents have a draft
  store where one corrupt file cannot take down the others
- **Path guarding** — create/rename/delete inside a workspace are root-validated and reject `..` and
  absolute paths; an optional mode limits all reads and writes to the workspace

### AI assistant
- **One timeline, four intents** — generate, vision, review and explain share one chronological
  conversation per document; each message carries an intent, shown before sending on a four-stop slider
  that you can override
- **Optional intent classification** — `Auto / Official / Custom / Off`; failures, signed-out state and low
  confidence fall back to local rules and never block sending; send is locked while a verdict is in flight,
  so a double-click cannot bill twice
- **Output format selector** — Follow current / Mermaid / DOT / D2 / drawio / Excalidraw; a different target
  opens a new tab in that format
- **Two kinds of credentials, kept separate** — the membership gateway (credential = login token) and local
  BYOK (OpenAI-compatible / Ollama / custom)
- **Vision has four entry points** — pick a file, paste with `Ctrl+V`, drop a file into the dialog, or drag
  out a region of the screen; up to two images, compressed to ≤1568 px in memory only, never written to
  disk or into the conversation record
- **External files work as context** — up to 8 files of 256 KiB each, UTF-8 text only; reference files and
  the current diagram source are worded separately in the prompt
- **Review works on the whole document** — the full source goes up and the complete modified source comes
  back, so Apply can never leave half a diagram; the last non-empty fenced block is used
- **The AI only fixes what the AI wrote** — auto-repair fires only while the body is still exactly the
  version the AI applied
- **Explain stays read-only and rendered** — Markdown with streaming, preview/source toggle; model output is
  treated as plain text, so inline HTML/scripts never run and `javascript:` links are not clickable
- **Message-level operations** — retry, edit-and-resend, delete and copy, without clearing the conversation
- **It actually remembers the conversation** — previous turns are carried into the next request
  (auto-trimmed, newest turn always kept)
- **History is persisted per document** — the "All" tab lists every conversation on this machine under three
  ownerships (document / draft / unlinked), searchable, exportable as Markdown, with 30-day pruning for
  unlinked ones; drafts and unlinked conversations are never removed automatically
- **The reasoning is visible — and collapsible** — thinking models stream their chain of thought above the
  bubble, it folds away at the end, and it is stored with the conversation
- **Long-term memory (optional)** — the AI proposes preferences and terminology as **pending** entries that
  only take effect once you confirm them, stored locally
- **Controlled tool loop (experimental)** — up to 5 steps of read document → check grammar → validate, on the
  in-memory document model only; it never touches the filesystem, shell or network
- **Usage is labelled with its source** — only tokens the provider reports are accumulated; unreported
  values show `—`, never `0`, never a local estimate
- **Keys never reach the front end** — they live inside the Rust process (DPAPI, encrypted per user); the
  front end only ever sees `has_key` and a mask

### Cloud
- **Login tokens go into the credential store** (DPAPI) and refresh silently, so a restart does not ask you
  to sign in again
- **Account view** — email, display name, plan, role, storage usage, plus AI entitlement and credit balance
- **Cloud documents** — folder tree (empty folders included), filter, open; the save dialog lets you pick a
  target folder and create a subfolder
- **Gateway `auto` tier** — the server routes by capability and image-input needs
- **An empty `base_url` switches the cloud off entirely**; everything keeps working offline
- **No fake data, ever** — "not configured" means exactly that, "not signed in" means exactly that, and a
  balance is never invented

### Settings and updates
- **Light and dark themes** plus several accent colours, all read from CSS variables
- **Panel state is remembered** — sidebar / AI / bottom panel visibility and widths, source-pane ratio and
  recent files are restored on restart
- **Bilingual UI** — `zh-CN` and `en-US` with exactly the same key set on both sides
- **Built-in auto-update** — minisign signature verification; "up to date", "new version available" and
  "error" stay three distinct outcomes, and a failed check is never reported as "up to date"
- **Close to tray (opt-in)** — ✕ only hides the window; the tray icon brings it back or quits
- **Default Mermaid look** — a global fallback used when a document has no look of its own

## Tech Stack

- **Language / framework**: Rust (edition 2021) + Tauri 2, running in the system WebView (WebView2 on
  Windows)
- **Front end**: no framework, no build chain, no CDN; the editor is a bundled CodeMirror 6
- **Rendering**: Mermaid (packaged JS) · Graphviz (WASM) · D2 (official wasm build) · drawio (pruned
  runtime) · Excalidraw (locally bundled) — all shipped in the installer and run locally
- **AI**: `reqwest` + SSE streaming in Rust; credentials in DPAPI
- **Packaging**: NSIS installer, with the rendering runtimes and front-end assets bundled

Architecture and design decisions (same-origin carriers and the custom protocol, the Rust/WebView split,
where the thresholds come from, conversion semantics, AI architecture, release discipline) are not
expanded here; they live with the internal design documents and the repository's rules file.

## Requirements

- Windows 10 / 11 64-bit with the WebView2 runtime (normally pre-installed)
- **No** VC++ redistributable: the release build statically links the CRT
- The rendering / canvas runtimes (about 105 MB) and the front-end assets are inside the installer —
  nothing extra to download

## License

Apache-2.0, see [`LICENSE`](LICENSE); third-party components and licences are listed in
[`NOTICE`](NOTICE).

## Acknowledgments

- [Tauri](https://tauri.app/) - desktop application framework (Rust + system WebView)
- [CodeMirror](https://codemirror.net/) - code editor
- [Mermaid](https://mermaid.js.org/) - Mermaid diagram rendering engine
- [Graphviz](https://graphviz.org/) / [@hpcc-js/wasm-graphviz](https://github.com/hpcc-systems/wasm-graphviz) - DOT rendering (WASM)
- [D2](https://d2lang.com/) - `.d2` diagrams (official browser wasm build shipped in the installer, MPL-2.0)
- [drawio](https://github.com/jgraph/drawio) - the `.drawio` canvas (pruned runtime shipped in the installer, Apache-2.0)
- [Excalidraw](https://github.com/excalidraw/excalidraw) - the `.excalidraw` hand-drawn canvas (MIT)
- [OpenAI-compatible API](https://platform.openai.com/docs/api-reference) - the chat protocol used by BYOK and the cloud gateway
- [Ollama](https://ollama.com/) - local large language models
