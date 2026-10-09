// 编辑器 vendor 产物（由 build.mjs 用 esbuild 打成一个 IIFE，挂到 window.DGMEditor）。
//
// 内容：CodeMirror 6 基础套件 + 四种语言的语法支持。
//   * Mermaid / Graphviz DOT —— 本文件自带的行式解析器（CodeMirror 6 无官方支持，
//     旧的 AvaloniaEdit 版用 XSHD；这里按同一份词汇表重写）。
//   * JSON / XML —— 官方 `@codemirror/lang-*`（Excalidraw / drawio 的文本面）。

import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { search, openSearchPanel, closeSearchPanel, searchKeymap } from "@codemirror/search";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";

// ------------------------------------------------------------------ Mermaid

const MERMAID_KEYWORDS = new Set([
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "classDiagram-v2",
  "stateDiagram", "stateDiagram-v2", "erDiagram", "gantt", "pie", "journey",
  "gitGraph", "mindmap", "timeline", "quadrantChart", "xychart-beta",
  "block-beta", "architecture-beta", "C4Context", "C4Container", "C4Component",
  "participant", "actor", "activate", "deactivate", "note", "loop", "alt",
  "else", "opt", "par", "and", "rect", "subgraph", "end", "direction", "class",
  "classDef", "click", "style", "linkStyle", "section", "title", "accTitle",
  "accDescr", "dateFormat", "axisFormat", "excludes", "todayMarker", "state",
  "as", "call", "autonumber", "box", "break", "critical", "option", "TB", "TD",
  "BT", "RL", "LR", "over", "of", "on", "to", "by", "at",
]);

const mermaidParser = {
  startState: () => ({ meta: false }),
  token(stream, state) {
    if (state.meta) {
      if (stream.match(/^.*?\}%%/)) {
        state.meta = false;
      } else {
        stream.skipToEnd();
      }
      return "meta";
    }
    if (stream.match("%%{")) {
      state.meta = true;
      return "meta";
    }
    if (stream.match("%%")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    // 连线：-->、---、-.->、==>、--x、--o、<-->…
    if (stream.match(/^(?:<-->|<--|-->|---|--x|--o|-\.->|-\.-|==>|===|--|->)/)) return "operator";
    if (stream.match(/^(?:\(\(|\)\)|\[\[|\]\]|\[\(|\)\]|\{\{|\}\}|\[|\]|\(|\)|\{|\}|\||:)/)) return "bracket";
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
    if (stream.match(/^\|.*?\|/)) return "string";
    if (stream.match(/^[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff-]*/)) {
      const word = stream.current();
      return MERMAID_KEYWORDS.has(word) ? "keyword" : "variable";
    }
    stream.next();
    return null;
  },
};

// --------------------------------------------------------------------- DOT

const DOT_KEYWORDS = new Set(["strict", "graph", "digraph", "subgraph", "node", "edge"]);

const dotParser = {
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.blockComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.match("/*")) {
      state.blockComment = true;
      return "comment";
    }
    if (stream.match("//") || stream.match(/^#/)) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^(?:->|--)/)) return "operator";
    if (stream.match(/^[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*/)) {
      const word = stream.current();
      return DOT_KEYWORDS.has(word) ? "keyword" : "variable";
    }
    if (stream.match(/^-?(?:\d+\.\d*|\.\d+|\d+)/)) return "number";
    if (stream.match(/^[{}[\];,=:]/)) return "bracket";
    stream.next();
    return null;
  },
};

const mermaidLang = () => new LanguageSupport(StreamLanguage.define(mermaidParser));
const dotLang = () => new LanguageSupport(StreamLanguage.define(dotParser));

const LANGUAGES = {
  mermaid: mermaidLang,
  dot: dotLang,
  drawio: xml,
  excalidraw: json,
};

// ------------------------------------------------------------------ 主题

// 显式的高亮样式：不依赖默认样式表对各 tag 的覆盖（实测 variableName/operator/bracket
// 在默认样式下不产生着色，导致只有关键字被高亮）。颜色走 CSS 变量以跟随明暗主题。
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--hl-keyword, #8250df)", fontWeight: "600" },
  { tag: tags.operator, color: "var(--hl-operator, #cf222e)" },
  { tag: tags.bracket, color: "var(--muted)" },
  { tag: tags.punctuation, color: "var(--muted)" },
  { tag: tags.number, color: "var(--hl-number, #0550ae)" },
  { tag: tags.string, color: "var(--hl-string, #0a3069)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--fg)" },
  { tag: tags.propertyName, color: "var(--hl-number, #0550ae)" },
  { tag: tags.attributeName, color: "var(--hl-operator, #cf222e)" },
  { tag: tags.tagName, color: "var(--hl-keyword, #8250df)" },
  { tag: tags.labelName, color: "var(--hl-string, #0a3069)" },
  { tag: tags.typeName, color: "var(--hl-keyword, #8250df)" },
  { tag: tags.meta, color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg)", color: "var(--fg)" },
  ".cm-scroller": {
    fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Noto Sans Mono CJK SC", monospace',
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { caretColor: "var(--fg)" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
  },
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--fg)" },
});

// ------------------------------------------------------------------ 工厂

function create(host, opts = {}) {
  const language = new Compartment();
  let suppress = false;

  const extensions = [
    basicSetup,
    theme,
    syntaxHighlighting(highlight),
    search({ top: true }),
    keymap.of(searchKeymap),
    language.of((LANGUAGES[opts.language] || LANGUAGES.mermaid)()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && opts.onChange && !suppress) {
        opts.onChange(update.state.doc.toString());
      }
    }),
  ];

  const view = new EditorView({ parent: host, state: EditorState.create({ doc: opts.doc || "", extensions }) });

  return {
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      suppress = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      } finally {
        suppress = false;
      }
    },
    setLanguage(format) {
      const ctor = LANGUAGES[format] || LANGUAGES.mermaid;
      view.dispatch({ effects: language.reconfigure(ctor()) });
    },
    focus: () => view.focus(),
    /** 把某一行滚动到视野中央（渲染报错定位用；不改动选区，避免打断正在输入的用户）。 */
    revealLine(line) {
      const total = view.state.doc.lines;
      const l = Math.max(1, Math.min(Number(line) || 1, total));
      const info = view.state.doc.line(l);
      view.dispatch({ effects: EditorView.scrollIntoView(info.from, { y: "center" }) });
      return l;
    },
    openSearch: () => {
      openSearchPanel(view);
      return true;
    },
    closeSearch: () => {
      closeSearchPanel(view);
      return true;
    },
    destroy: () => view.destroy(),
    view,
  };
}

window.DGMEditor = { create, LANGUAGES: Object.keys(LANGUAGES) };
