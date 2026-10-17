// 懒加载 bundle：只把官方 Mermaid -> Excalidraw 转换器挂到全局。
// 由 esbuild 单独打成 tools/excalidraw/mermaid.js（IIFE）。
// 刻意不加 --global-name：esbuild 在没有 export 时会返回空对象并覆盖同名全局，
// 这里的全局由本文件自己赋值。
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";

window.ExcalidrawMermaid = { parseMermaidToExcalidraw: parseMermaidToExcalidraw };