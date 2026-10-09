// 设置的前端持有者：从 Rust 读全量对象，改动后去抖落盘。

(function () {
  const current = {
    language: null,
    editorRatio: null,
    autoCheckUpdate: true,
    skipVersion: null,
    lastUpdateCheck: 0,
    updateManifestUrl: null,
    recentFiles: [],
  };

  let saveTimer = 0;

  async function persistNow() {
    window.clearTimeout(saveTimer);
    try {
      await DGM.invoke("settings_save", { settings: { ...current } });
    } catch (e) {
      if (window.DGM && DGM.app) DGM.app.status(`设置保存失败: ${e && e.message ? e.message : e}`, true);
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(persistNow, 300);
  }

  DGM.settings = {
    get value() {
      return current;
    },

    async load() {
      const loaded = await DGM.invoke("settings_get");
      Object.assign(current, loaded);
      return current;
    },

    /** 立刻落盘（退出前调用）。 */
    flush: persistNow,

    setEditorRatio(ratio) {
      const next = Math.max(0.15, Math.min(0.85, ratio));
      if (current.editorRatio != null && Math.abs(current.editorRatio - next) < 0.005) return;
      current.editorRatio = next;
      scheduleSave();
    },

    setLanguage(code) {
      if (current.language === code) return;
      current.language = code;
      scheduleSave();
    },

    /** 刷新最近文件列表（来自 Rust 侧的权威数据）。 */
    async recent() {
      current.recentFiles = await DGM.invoke("recent_list");
      return current.recentFiles;
    },

    async recentPrune() {
      current.recentFiles = await DGM.invoke("recent_prune");
      return current.recentFiles;
    },

    async recentClear() {
      current.recentFiles = await DGM.invoke("recent_clear");
      return current.recentFiles;
    },
  };
})();
