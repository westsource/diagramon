// esbuild --alias:@excalidraw/mermaid-to-excalidraw=<本文件> 的别名目标。
// 主 bundle 因此不含 mermaid（约 3.5 MB），实现从 ./mermaid.js 懒加载；
// Excalidraw 库内部对 mermaid-to-excalidraw 的引用同样落到这里。
export async function parseMermaidToExcalidraw(definition, config) {
  const converter = window.ExcalidrawMermaid;
  if (!converter) {
    throw new Error(
      "Mermaid converter is not loaded. Load ./mermaid.js before calling convertMermaid.",
    );
  }
  return converter.parseMermaidToExcalidraw(definition, config);
}