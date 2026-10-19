/* ELK 布局引擎离线包入口（tools/fetch-mermaid-elk.ps1 用 esbuild 打成单文件 ESM）。
 *
 * @mermaid-js/layout-elk 的 npm 主入口是 dist/mermaid-layout-elk.core.mjs（"core" 变体）：
 *   - 它**不 import mermaid**（mermaid API 由 registerLayoutLoaders 的回调签名传入），
 *     所以打包不需要任何 external / alias，也不会把第二份 mermaid 打进来；
 *   - 裸依赖 dayjs / d3 / dompurify / dagre-d3-es / elkjs / katex 全部随包打进产物；
 *   - 上游用动态 import 加载 elk 引擎与 katex（esbuild 无 splitting 时会内联进同一文件）。
 *
 * 产物用法（ui/js/preview.js 的懒加载）：
 *   const m = await import("/mermaid-elk/mermaid-layout-elk.esm.js");
 *   mermaid.registerLayoutLoaders(m.default);   // 之后 initialize({ layout: "elk" }) 即生效
 */
import elkLayouts from "@mermaid-js/layout-elk";
export default elkLayouts;
