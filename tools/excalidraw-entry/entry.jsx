// Diagramon 离线 Excalidraw bundle 入口。
// 由 esbuild 打成经典脚本 tools/excalidraw/app.js（IIFE，全局名 ExcalidrawApp）。
// 承载页 tools/excalidraw-host/index.html 的契约：
//   const api = await window.ExcalidrawApp.mount(el, onChange)   // 返回 Excalidraw api
//   const png = await window.ExcalidrawApp.exportPng({ scale: 2, transparent: true })
//   const converted = await window.ExcalidrawApp.convertMermaid('graph TD; A-->B;')
//                   -> { elements, files }   // files 里的位图必须一并交给画布（见函数内注释）
//   window.ExcalidrawApp.ready
//
// 全局对象就是本模块的导出命名空间（esbuild --global-name=ExcalidrawApp 的返回值），
// 所以这里必须用 export 声明；自己再写 window.ExcalidrawApp = ... 会被 IIFE 的返回值覆盖成空对象。
import React from "react";
import { createRoot } from "react-dom/client";
import {
  Excalidraw,
  convertToExcalidrawElements,
  serializeAsJSON,
  exportToBlob,
} from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "./m2e-shim.js";

// 本脚本自身所在目录（= tools/excalidraw/），懒加载的 mermaid.js 相对它解析。
// 字体资源目录由承载页设置 window.EXCALIDRAW_ASSET_PATH 决定，本 bundle 不碰它。
const SELF_DIR = new URL(
  "./",
  (document.currentScript && document.currentScript.src) || document.baseURI,
);

/** 挂载完成后为 true。 */
export let ready = false;

/** Excalidraw 原生 imperative API（mount 完成前为 null）。 */
let nativeApi = null;
/** 懒加载 ./mermaid.js 的句柄；失败后允许重试。 */
let mermaidLoader = null;

function requireApi() {
  if (!nativeApi) {
    throw new Error("Excalidraw is not mounted yet");
  }
  return nativeApi;
}

/**
 * 把原生 API 的方法逐个绑定到普通对象上（承载页直接调 updateScene），
 * 再补一个 Excalidraw 库函数形式的 serializeAsJSON({ type })。
 */
function wrapApi(native) {
  const api = {};
  for (const key in native) {
    const value = native[key];
    api[key] = typeof value === "function" ? value.bind(native) : value;
  }
  api.serializeAsJSON = (options) =>
    serializeAsJSON(
      native.getSceneElements(),
      native.getAppState(),
      native.getFiles(),
      (options && options.type) || "local",
    );
  return api;
}

function loadMermaidBundle() {
  if (window.ExcalidrawMermaid) {
    return Promise.resolve();
  }
  if (!mermaidLoader) {
    mermaidLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("mermaid.js", SELF_DIR).href;
      script.onload = () => {
        if (window.ExcalidrawMermaid) {
          resolve();
        } else {
          mermaidLoader = null;
          reject(new Error("mermaid.js did not expose window.ExcalidrawMermaid"));
        }
      };
      script.onerror = () => {
        mermaidLoader = null;
        reject(new Error("failed to load ./mermaid.js"));
      };
      document.head.appendChild(script);
    });
  }
  return mermaidLoader;
}

/**
 * 挂载 <Excalidraw/> 到 container，返回 api。
 * @param {HTMLElement} container
 * @param {(elements: unknown[], appState: object, files: object) => void} [onChange]
 */
export function mount(container, onChange) {
  if (!container) {
    return Promise.reject(new Error("mount: container is empty"));
  }
  return new Promise((resolve, reject) => {
    const root = createRoot(container);
    const props = {
      initialData: { appState: { viewBackgroundColor: "#ffffff" } },
      excalidrawAPI: (native) => {
        nativeApi = native;
        const api = wrapApi(native);
        ready = true;
        resolve(api);
      },
    };
    if (typeof onChange === "function") {
      props.onChange = (elements, appState, files) => onChange(elements, appState, files);
    }
    try {
      root.render(
        React.createElement(
          "div",
          { style: { width: "100%", height: "100%" } },
          React.createElement(Excalidraw, props),
        ),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("failed to read exported PNG"));
    reader.readAsDataURL(blob);
  });
}

/**
 * 当前场景导出为 PNG。
 * @param {{ scale?: number, transparent?: boolean }} [options]
 * @returns {Promise<string>} data URI（data:image/png;base64,…）
 */
export async function exportPng(options) {
  const opts = options || {};
  const native = requireApi();
  const appState = native.getAppState();
  const blob = await exportToBlob({
    elements: native.getSceneElements(),
    appState: Object.assign({}, appState, {
      exportBackground: opts.transparent === false,
      exportScale: opts.scale > 0 ? opts.scale : appState.exportScale || 1,
    }),
    files: native.getFiles(),
    mimeType: "image/png",
    quality: 1,
  });
  return await blobToDataUri(blob);
}

/**
 * Mermaid 源码 -> Excalidraw 元素。
 * @param {string} source
 * @param {object} [config] 透传给 mermaid-to-excalidraw
 * @returns {Promise<{ elements: unknown[], files: object }>}
 *   `files` = 图片元素的真正字节（键是 fileId）。**必须一并返回给调用方**，
 *   否则一旦上游走了位图兜底，画布上就只剩一个悬空 fileId。
 */
export async function convertMermaid(source, config) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("convertMermaid: mermaid source is empty");
  }
  await loadMermaidBundle();
  const parsed = await parseMermaidToExcalidraw(source, config);
  // **id 要保留**：上游骨架里的 `id` 就是 Mermaid 的节点 id（`"A"`），而 Excalidraw 把标签
  // 拆成**独立 text 元素**、不与矩形绑定 —— 一旦换成随机 id，"哪个矩形是哪个节点"就只能靠
  // 文字与坐标反推。代价是多次导入同一张图会撞 id：那由调用方加前缀解决（本应用是整份替换，
  // 同一画布内不会混用），不要在这里把语义锚点毁掉。
  const elements = convertToExcalidrawElements(parsed.elements, {
    regenerateIds: false,
  });
  // **files 要原样带出**：上游碰到不支持的语法（实测 subgraph 必现）不是报错，而是把整张图
  // 渲染成一张位图放进 `files[fileId]`。丢了它 = 用户看到一块空白画布且没有任何提示。
  return { elements: elements, files: parsed.files || {} };
}