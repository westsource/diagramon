// AI 助手面板（BYOK）：模型选择、生成/识图、应用/回退、对话持久化、渲染失败自动回修。

(function () {
  const t = (k, v) => DGM.i18n.t(k, v);
  const invoke = (cmd, args) => DGM.invoke(cmd, args);

  const state = {
    open: false,
    snapshot: null,
    /** 当前文档的对话（含 system 提示不当消息显示）。 */
    messages: [],
    /** 当前文档的对话存档键（无路径的未保存文档为 null，只活在内存里）。 */
    key: null,
    /** 最近一次"应用"前的正文，用于回退。 */
    lastBeforeApply: null,
    busy: false,
    /** 刚应用过 AI 代码，等一次渲染结果来决定是否自动回修。 */
    awaitingRenderCheck: false,
    repairing: false,
  };

  const el = {};

  function pick() {
    el.panel = document.getElementById("ai-panel");
    el.model = document.getElementById("ai-model");
    el.messages = document.getElementById("ai-messages");
    el.text = document.getElementById("ai-text");
    el.send = document.getElementById("ai-send");
    el.image = document.getElementById("ai-image");
    el.imageFile = document.getElementById("ai-image-file");
    el.settings = document.getElementById("ai-settings");
    el.clear = document.getElementById("ai-clear");
    el.close = document.getElementById("ai-close");
    el.toggle = document.getElementById("btn-ai");
  }

  const activeTab = () => DGM.app.state.tabs.find((x) => x.id === DGM.app.state.activeId) || null;
  const currentModel = () => {
    const s = state.snapshot;
    if (!s || !s.models.length) return null;
    return s.models.find((m) => m.id === s.selectedModelId) || s.models[0];
  };

  function status(msg, warn) {
    DGM.app.status(msg, warn);
  }

  // ---------------------------------------------------------------- 状态同步

  async function refresh() {
    state.snapshot = await invoke("ai_state");
    renderModels();
    renderSendEnabled();
  }

  function renderModels() {
    const s = state.snapshot;
    el.model.innerHTML = "";
    if (!s || !s.models.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = t("aiNoModels");
      el.model.appendChild(opt);
      el.model.disabled = true;
      return;
    }
    el.model.disabled = false;
    for (const m of s.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name || m.id}${s.modelsWithKey.includes(m.id) ? "" : " (无密钥)"}`;
      el.model.appendChild(opt);
    }
    el.model.value = currentModel().id;
  }

  function renderSendEnabled() {
    const model = currentModel();
    const tab = activeTab();
    const supported = tab && (tab.format === "mermaid" || tab.format === "dot");
    el.send.disabled = state.busy || !model || !supported;
    el.image.disabled = state.busy || !model || !supported;
    el.text.disabled = !supported;
  }

  // ---------------------------------------------------------------- 消息渲染

  function renderMessages() {
    el.messages.innerHTML = "";
    if (!state.messages.length) {
      const hint = document.createElement("div");
      hint.className = "ai-msg system";
      hint.textContent = t("aiNoModels");
      if (state.snapshot && state.snapshot.models.length) {
        hint.textContent = t("aiInputTitle");
      }
      el.messages.appendChild(hint);
      return;
    }
    for (const m of state.messages) {
      const node = document.createElement("div");
      node.className = `ai-msg ${m.role}`;
      node.textContent = m.text;
      if (m.role === "assistant" && m.code) {
        const actions = document.createElement("div");
        actions.className = "ai-msg-actions";
        const apply = document.createElement("button");
        apply.textContent = t("aiApply");
        apply.addEventListener("click", () => applyCode(m.code));
        const revert = document.createElement("button");
        revert.textContent = t("aiRevert");
        revert.disabled = state.lastBeforeApply == null;
        revert.addEventListener("click", revertCode);
        actions.appendChild(apply);
        actions.appendChild(revert);
        node.appendChild(actions);
      }
      el.messages.appendChild(node);
    }
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function addMessage(role, text, extra) {
    const msg = { role, text, ...(extra || {}) };
    state.messages.push(msg);
    renderMessages();
    return msg;
  }

  /** 临时的"生成中…"占位：只在 DOM 里，不进 state.messages（否则会被存档并污染上下文）。 */
  function showThinking() {
    const node = document.createElement("div");
    node.className = "ai-msg system";
    node.textContent = t("aiThinking");
    el.messages.appendChild(node);
    el.messages.scrollTop = el.messages.scrollHeight;
    return node;
  }

  function addError(text) {
    const node = document.createElement("div");
    node.className = "ai-msg error";
    node.textContent = text;
    el.messages.appendChild(node);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  // ---------------------------------------------------------------- 对话存档

  async function keyForTab(tab) {
    if (!tab || !tab.path) return null;
    try {
      return await invoke("ai_conversation_key", { path: tab.path });
    } catch (e) {
      return null;
    }
  }

  async function persist() {
    if (!state.key) return;
    try {
      await invoke("ai_conversation_save", { key: state.key, messages: sanitize(state.messages) });
    } catch (e) {
      /* 存档失败不该打断使用 */
    }
  }

  /** 存档时去掉仅用于界面的字段（code）。 */
  function sanitize(messages) {
    return messages.map((m) => ({ role: m.role, text: m.code ? `${m.text}` : m.text }));
  }

  async function loadConversation(tab) {
    state.key = await keyForTab(tab);
    state.messages = [];
    state.lastBeforeApply = null;
    if (state.key) {
      try {
        const stored = await invoke("ai_conversation_load", { key: state.key });
        state.messages = (stored || []).map((m) => ({ ...m }));
      } catch (e) {
        state.messages = [];
      }
    }
    renderMessages();
  }

  // ---------------------------------------------------------------- 生成

  function historyForRequest() {
    return state.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, text: m.code || m.text, imageDataUrl: null }));
  }

  async function send() {
    const tab = activeTab();
    const model = currentModel();
    if (!tab || !model) return status(t("aiNeedModel"), true);
    const instruction = el.text.value.trim();
    if (!instruction) return;

    state.busy = true;
    renderSendEnabled();
    addMessage("user", instruction);
    el.text.value = "";
    const thinking = showThinking();

    try {
      const code = await invoke("ai_generate", {
        modelId: model.id,
        format: tab.format,
        currentCode: DGM.editor.getValue(),
        instruction,
        history: historyForRequest().slice(0, -1),
      });
      thinking.remove();
      addMessage("assistant", code, { code });
      await persist();
    } catch (e) {
      thinking.remove();
      addError(`${t("aiGenerationFailed")}: ${e && e.message ? e.message : e}`);
    } finally {
      state.busy = false;
      renderSendEnabled();
    }
  }

  async function sendImage(dataUrl) {
    const tab = activeTab();
    const model = currentModel();
    if (!tab || !model) return status(t("aiNeedModel"), true);

    if (!state.snapshot.visionNoticeAccepted) {
      const ok = await DGM.dialogs.show({
        title: t("aiVisionNotice"),
        body: t("aiVisionNoticeBody"),
        buttons: [
          { id: "go", label: t("aiSend"), kind: "primary" },
          { id: "cancel", label: t("cancel"), kind: "cancel" },
        ],
      });
      if (ok !== "go") return;
      state.snapshot.visionNoticeAccepted = true;
      await invoke("ai_settings_save", {
        ai: settingsPayload({ visionNoticeAccepted: true }),
      });
    }

    state.busy = true;
    renderSendEnabled();
    const thinking = showThinking();
    try {
      const code = await invoke("ai_generate_from_image", {
        modelId: model.id,
        format: tab.format,
        imageDataUrl: dataUrl,
        history: historyForRequest(),
      });
      thinking.remove();
      addMessage("assistant", code, { code });
      await persist();
    } catch (e) {
      thinking.remove();
      addError(`${t("aiGenerationFailed")}: ${e && e.message ? e.message : e}`);
    } finally {
      state.busy = false;
      renderSendEnabled();
    }
  }

  // ---------------------------------------------------------------- 应用 / 回退

  function applyCode(code) {
    state.lastBeforeApply = DGM.editor.getValue();
    state.awaitingRenderCheck = true;
    DGM.app.setActiveBody(code);
    status(t("aiApplied"));
  }

  function revertCode() {
    if (state.lastBeforeApply == null) return;
    DGM.app.setActiveBody(state.lastBeforeApply);
    state.awaitingRenderCheck = false;
    status(t("aiReverted"));
  }

  /** 预览报错回调：应用过 AI 代码且开了自动回修时，请求模型修一次（只修一次）。 */
  async function handleRenderError(errorText) {
    const s = state.snapshot;
    if (!s || !s.renderFeedbackRetry || !state.awaitingRenderCheck || state.repairing) return;
    const tab = activeTab();
    const model = currentModel();
    if (!tab || !model) return;

    state.awaitingRenderCheck = false;
    state.repairing = true;
    status(t("aiRepairing"));
    try {
      const fixed = await invoke("ai_repair", {
        modelId: model.id,
        format: tab.format,
        code: DGM.editor.getValue(),
        errorText,
      });
      state.lastBeforeApply = DGM.editor.getValue();
      DGM.app.setActiveBody(fixed);
      addMessage("assistant", fixed, { code: fixed });
      await persist();
      status(t("aiApplied"));
    } catch (e) {
      addError(`${t("aiGenerationFailed")}: ${e && e.message ? e.message : e}`);
    } finally {
      state.repairing = false;
    }
  }

  // ---------------------------------------------------------------- 设置

  function settingsPayload(patch) {
    const s = state.snapshot;
    return {
      models: s.models,
      selectedModelId: s.selectedModelId,
      conversationStoragePath: s.conversationStoragePath,
      renderFeedbackRetry: s.renderFeedbackRetry,
      visionNoticeAccepted: s.visionNoticeAccepted,
      ...(patch || {}),
    };
  }

  function modelCard(model, ready) {
    const card = document.createElement("div");
    card.className = "ai-model-card";

    const label = (text, node) => {
      const l = document.createElement("label");
      l.textContent = text;
      l.appendChild(node);
      return l;
    };
    const input = (value, type) => {
      const i = document.createElement("input");
      i.type = type || "text";
      i.value = value == null ? "" : String(value);
      return i;
    };

    const form = document.createElement("div");
    form.className = "ai-form";

    const name = input(model.name);
    const provider = document.createElement("select");
    for (const p of ["openai", "custom", "ollama"]) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = p;
      provider.appendChild(o);
    }
    provider.value = model.provider;
    provider.addEventListener("change", async () => {
      const base = baseUrl.querySelector("input");
      base.placeholder = await invoke("ai_default_base_url", { provider: provider.value });
    });

    const baseUrl = label(t("aiBaseUrl"), input(model.baseUrl));
    const modelId = label(t("aiModelId"), input(model.modelId));
    const maxTokens = label(t("aiMaxTokens"), input(model.maxTokens, "number"));
    const temperature = label(t("aiTemperature"), input(model.temperature, "number"));
    temperature.querySelector("input").step = "0.1";

    const keyBox = document.createElement("input");
    keyBox.type = "password";
    keyBox.placeholder = ready ? t("aiKeyStored") : t("aiKeyMissing");
    const clearKey = document.createElement("input");
    clearKey.type = "checkbox";
    const clearLabel = document.createElement("label");
    clearLabel.style.flexDirection = "row";
    clearLabel.style.alignItems = "center";
    clearLabel.style.gap = "6px";
    clearLabel.appendChild(clearKey);
    clearLabel.appendChild(document.createTextNode(t("aiKeyClear")));

    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(maxTokens);
    row.appendChild(temperature);

    form.appendChild(name);
    form.appendChild(provider ? label(t("aiProvider"), provider) : name);
    form.appendChild(baseUrl);
    form.appendChild(modelId);
    form.appendChild(row);
    form.appendChild(label(t("aiApiKey"), keyBox));
    form.appendChild(clearLabel);
    card.appendChild(form);

    return {
      node: card,
      read: () => ({
        id: model.id,
        name: name.value.trim() || model.id,
        provider: provider.value,
        baseUrl: baseUrl.querySelector("input").value.trim(),
        modelId: modelId.querySelector("input").value.trim(),
        maxTokens: Number(maxTokens.querySelector("input").value) || 4096,
        temperature: Number(temperature.querySelector("input").value) || 0.7,
        apiKey: keyBox.value,
        clearKey: clearKey.checked,
      }),
    };
  }

  async function openSettings() {
    if (!state.snapshot) await refresh();
    const draft = state.snapshot.models.map((m) => ({ ...m }));
    const editors = [];

    await DGM.dialogs.show({
      title: t("aiSettings"),
      bodyClass: "guide",
      build: (body) => {
        const wrap = document.createElement("div");
        wrap.className = "ai-form";
        const list = document.createElement("div");
        editors.length = 0;

        const addCard = (model, ready) => {
          const { node, read } = modelCard(model, ready);
          editors.push(read);
          if (draft.length > 1) {
            const del = document.createElement("button");
            del.className = "tb-btn";
            del.textContent = t("aiDeleteModel");
            del.addEventListener("click", () => {
              const idx = editors.indexOf(read);
              if (idx >= 0) {
                editors.splice(idx, 1);
                draft.splice(idx, 1);
              }
              node.remove();
            });
            node.appendChild(del);
          }
          list.appendChild(node);
        };

        draft.forEach((m) => addCard(m, state.snapshot.modelsWithKey.includes(m.id)));

        const add = document.createElement("button");
        add.className = "tb-btn";
        add.textContent = t("aiAddModel");
        add.addEventListener("click", () => {
          const id = `m${Date.now().toString(36)}`;
          const m = {
            id,
            name: "New Model",
            provider: "openai",
            baseUrl: "https://api.openai.com/v1",
            modelId: "gpt-4o-mini",
            maxTokens: 4096,
            temperature: 0.7,
          };
          draft.push(m);
          addCard(m, false);
        });

        wrap.appendChild(list);
        wrap.appendChild(add);
        body.appendChild(wrap);
      },
      buttons: [
        { id: "save", label: t("save"), kind: "primary" },
        { id: "cancel", label: t("cancel"), kind: "cancel" },
      ],
    }).then(async (choice) => {
      if (choice !== "save") return;
      const models = editors.map((fn) => fn());
      const keys = models.map((m) => ({ id: m.id, apiKey: m.apiKey, clearKey: m.clearKey }));

      const payloadModels = models.map(({ apiKey, clearKey, ...rest }) => rest);
      await invoke("ai_settings_save", {
        ai: settingsPayload({ models: payloadModels, selectedModelId: payloadModels[0] ? payloadModels[0].id : null }),
      });
      for (const k of keys) {
        if (k.apiKey) await invoke("ai_key_set", { modelId: k.id, key: k.apiKey });
        else if (k.clearKey) await invoke("ai_key_delete", { modelId: k.id });
      }
      await refresh();
      status(t("aiSaved"));
    });
  }

  // ---------------------------------------------------------------- 面板开合

  function setOpen(open) {
    state.open = open;
    el.panel.hidden = !open;
    el.toggle.classList.toggle("primary", open);
    if (open) {
      refresh().then(() => {
        renderMessages();
        renderSendEnabled();
      });
    }
  }

  function toggle() {
    setOpen(!state.open);
  }

  /** 标签页切换：换对话上下文。 */
  async function onTabChanged(tab) {
    await loadConversation(tab);
    renderSendEnabled();
  }

  DGM.ai = {
    state,
    init() {
      pick();
      el.toggle.addEventListener("click", toggle);
      el.close.addEventListener("click", () => setOpen(false));
      el.send.addEventListener("click", send);
      el.settings.addEventListener("click", openSettings);
      el.clear.addEventListener("click", async () => {
        state.messages = [];
        state.lastBeforeApply = null;
        renderMessages();
        if (state.key) await invoke("ai_conversation_clear", { key: state.key });
        status(t("aiCleared"));
      });
      el.model.addEventListener("change", async () => {
        await invoke("ai_settings_save", { ai: settingsPayload({ selectedModelId: el.model.value }) });
        await refresh();
      });
      el.text.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      el.image.addEventListener("click", () => el.imageFile.click());
      el.imageFile.addEventListener("change", async () => {
        const file = el.imageFile.files && el.imageFile.files[0];
        if (!file) return;
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        el.imageFile.value = "";
        if (dataUrl) await sendImage(dataUrl);
      });
    },
    toggle,
    open: () => setOpen(true),
    close: () => setOpen(false),
    onTabChanged,
    handleRenderError,
  };
})();
