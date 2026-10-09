// 界面本地化：en-US / zh-CN。
//
// 首次启动按系统语言探测（`navigator.language`），之后以 settings.json 里的 `language` 为准。
// 静态文案用 `data-i18n="key"` 标注，动态文案走 `DGM.i18n.t(key, vars)`。

(function () {
  const DICT = {
    "zh-CN": {
      file: "文件",
      settings: "设置",
      help: "帮助",
      new: "新建",
      open: "打开",
      save: "保存",
      saveAs: "另存为",
      close: "关闭",
      quit: "退出",
      recentFiles: "最近文件",
      recentMore: "更多…",
      recentEmpty: "（暂无）",
      clearHistory: "清空历史",
      language: "界面语言",
      about: "关于",
      guide: "操作说明",
      checkUpdates: "检查更新",
      untitled: "未命名",
      format: "格式",
      emptyDoc: "（空文档）",
      noDoc: "没有打开的文档",
      exportPng: "保存图片",
      exportPngTip: "保存为图片",
      copyPng: "复制图片",
      copyPngTip: "复制图片到剪贴板",
      layout: "布局",
      ready: "就绪",
      saved: "已保存 {name}",
      opened: "已打开 {n} 个文件",
      savedImage: "已保存图片 {path}",
      imageCopied: "图片已复制到剪贴板",
      openFailed: "打开失败",
      saveFailed: "保存失败",
      exportFailed: "导出失败",
      copyFailed: "复制失败",
      startFailed: "启动失败",
      unsavedTitle: "未保存的更改",
      unsavedBody: "「{name}」有未保存的更改。",
      dontSave: "不保存",
      cancel: "取消",
      quitTitle: "退出 Diagramon",
      quitBody: "有 {n} 个标签页尚未保存，确定退出吗？",
      aboutBody: "多格式图表编辑器：Mermaid / Graphviz DOT / drawio / Excalidraw。\n本地优先，离线渲染。",
      version: "版本",
      platform: "平台",
      historyTitle: "打开历史",
      historySearch: "搜索文件名…",
      converted: "已转换为 {format}（原 Mermaid 标签页保持不变）",
      onlyMermaidConvertible: "只有 Mermaid 文档可以转换",
      canvasNotReady: "画布尚未就绪或导出失败",
      guideBody: "# 操作说明\n\n## 画布手势（四种格式一致）\n- 滚轮：平移\n- Shift+滚轮：水平平移\n- Ctrl+滚轮：以光标为中心缩放\n- 拖拽：平移\n- 双击：适应视图\n\n## 快捷键\n- Ctrl+N 新建 / Ctrl+O 打开 / Ctrl+S 保存 / Ctrl+Shift+S 另存为\n- Ctrl+W 关闭标签页 / Ctrl+Q 退出 / Ctrl+F 查找\n- Ctrl+0 适应视图 / Ctrl+= 放大 / Ctrl+- 缩小\n",
    },
    "en-US": {
      file: "File",
      settings: "Settings",
      help: "Help",
      new: "New",
      open: "Open",
      save: "Save",
      saveAs: "Save As",
      close: "Close",
      quit: "Quit",
      recentFiles: "Recent Files",
      recentMore: "More…",
      recentEmpty: "(none)",
      clearHistory: "Clear history",
      language: "Language",
      about: "About",
      guide: "Operations Guide",
      checkUpdates: "Check for Updates",
      untitled: "Untitled",
      format: "Format",
      emptyDoc: "(empty document)",
      noDoc: "No document open",
      exportPng: "Save Image",
      exportPngTip: "Save as image",
      copyPng: "Copy Image",
      copyPngTip: "Copy image to clipboard",
      layout: "Layout",
      ready: "Ready",
      saved: "Saved {name}",
      opened: "Opened {n} file(s)",
      savedImage: "Image saved to {path}",
      imageCopied: "Image copied to clipboard",
      openFailed: "Open failed",
      saveFailed: "Save failed",
      exportFailed: "Export failed",
      copyFailed: "Copy failed",
      startFailed: "Startup failed",
      unsavedTitle: "Unsaved Changes",
      unsavedBody: "\"{name}\" has unsaved changes.",
      dontSave: "Don't Save",
      cancel: "Cancel",
      quitTitle: "Quit Diagramon",
      quitBody: "{n} tab(s) have unsaved changes. Quit anyway?",
      aboutBody: "Multi-format diagram editor: Mermaid / Graphviz DOT / drawio / Excalidraw.\nLocal-first, offline rendering.",
      version: "Version",
      platform: "Platform",
      historyTitle: "Open History",
      historySearch: "Search file name…",
      converted: "Converted to {format} (original Mermaid tab untouched)",
      onlyMermaidConvertible: "Only Mermaid documents can be converted",
      canvasNotReady: "Canvas is not ready or export failed",
      guideBody: "# Operations Guide\n\n## Canvas gestures (same in all views)\n- Wheel: pan\n- Shift+wheel: pan horizontally\n- Ctrl+wheel: zoom at cursor\n- Drag: pan\n- Double-click: fit to view\n\n## Shortcuts\n- Ctrl+N new / Ctrl+O open / Ctrl+S save / Ctrl+Shift+S save as\n- Ctrl+W close tab / Ctrl+Q quit / Ctrl+F find\n- Ctrl+0 fit / Ctrl+= zoom in / Ctrl+- zoom out\n",
    },
  };

  const SYSTEM = ["en-US", "zh-CN"];
  let lang = "zh-CN";
  const listeners = [];

  function t(key, vars) {
    const table = DICT[lang] || DICT["zh-CN"];
    const raw = table[key] != null ? table[key] : DICT["zh-CN"][key] != null ? DICT["zh-CN"][key] : key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
  }

  /** 系统语言 → 支持的语言码（默认 zh-CN）。 */
  function detect() {
    const candidates = [navigator.language, ...(navigator.languages || [])].filter(Boolean);
    for (const c of candidates) {
      const exact = SYSTEM.find((s) => s.toLowerCase() === String(c).toLowerCase());
      if (exact) return exact;
      const base = String(c).split("-")[0].toLowerCase();
      if (base === "zh") return "zh-CN";
      if (base === "en") return "en-US";
    }
    return "zh-CN";
  }

  /** 把静态文案（`data-i18n`）刷新到当前语言。 */
  function apply(root) {
    const scope = root || document;
    for (const node of scope.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of scope.querySelectorAll("[data-i18n-title]")) {
      node.title = t(node.dataset.i18nTitle);
    }
    document.documentElement.lang = lang;
  }

  DGM.i18n = {
    get lang() {
      return lang;
    },
    t,
    detect,
    apply,
    /** 支持的界面语言。 */
    languages: SYSTEM,
    setLang(code, { persist = true } = {}) {
      const next = SYSTEM.includes(code) ? code : "zh-CN";
      const changed = next !== lang;
      lang = next;
      apply();
      if (persist && DGM.settings) DGM.settings.setLanguage(next);
      for (const fn of listeners) fn(lang);
      return changed;
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
})();
