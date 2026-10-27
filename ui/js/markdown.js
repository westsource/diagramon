/* 极简 Markdown 渲染：只给「解图」的**预览**用（`ai.js::mdViewNode`）。
 *
 * 为什么不引第三方库：这里只需要模型解释里会出现的那一小撮语法；多一个解析器就多
 * 一份许可证、一份升级债。安全边界只有一条 —— **模型输出一律先当纯文本**，除本文件
 * 明确构造的标签外不产生任何 HTML：不认内联 HTML、不认 `javascript:` / `data:` 链接、
 * 图片只保留 alt（预览绝不因为一条回复去发网络请求）。
 *
 * 支持：ATX 标题 / 段落（硬换行用行尾两个空格或 `\`）/ 无序·有序列表（可嵌套）/
 * 引用 / 分割线 / 表格 / 围栏代码块 / 行内代码 / 粗体 / 斜体 / 删除线 / http(s)·mailto 链接。
 * 非目标：内联 HTML、图片、脚注、setext 标题 —— 原文照显，不猜。
 *
 * 注意：本文件在 `shell.js` 之后加载（依赖 `DGM.dom.esc`），在 `ai.js` 之前。
 */
window.DGM = window.DGM || {};
(function () {
  "use strict";

  const esc = (s) => DGM.dom.esc(s);

  /* 行内片段的占位符：先把"生成好的 HTML"抽走，后续的强调/链接规则就碰不到它们。
     私有区字符在模型正文里不可能合法出现，进函数时还会被清掉。 */
  const PH = "\u0000";

  function hold(bag, html) {
    bag.push(html);
    return PH + (bag.length - 1) + PH;
  }

  function release(s, bag) {
    return s.replace(new RegExp(PH + "(\\d+)" + PH, "g"), (_, i) => bag[+i]);
  }

  /** 行内语法。`src` 是**未转义**的原文。 */
  function inline(src) {
    const bag = [];
    // 1) 先整体转义：后面所有替换只会在"纯文本"上做，不会把模型写的标签变成 DOM
    let s = esc(String(src).replace(/\u0000/g, ""));
    // 2) 图片不加载，只留 alt（避免预览触发外部请求）
    s = s.replace(/!\[([^\]\n]*)\]\([^)\s]+\)/g, "$1");
    // 3) 行内代码最先抽走：里面的星号、方括号、下划线都不是格式
    s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(bag, `<code>${code}</code>`));
    // 4) 链接：只认 http(s)/mailto，其余按原文显示（`javascript:` 不会变成可点链接）
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (all, text, url, title) => {
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return all;
      return hold(bag, `<a href="${url}"${title ? ` title="${title}"` : ""} data-ext="1" rel="noopener noreferrer">${text}</a>`);
    });
    // 5) 强调。占位符不含这些记号，所以不会误伤代码/链接。
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
    return release(s, bag);
  }

  function fenceMatch(line) {
    return line.match(/^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/);
  }

  function isTableSep(line) {
    return /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    if (fenceMatch(line)) return true;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
    if (/^\s{0,3}>\s?/.test(line)) return true;
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+/.test(line)) return true;
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) return true;
    return false;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function alignOf(cell) {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  }

  function tableHtml(head, aligns, rows) {
    const th = head
      .map((c, k) => `<th${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</th>`)
      .join("");
    const body = rows
      .map(
        (r) =>
          "<tr>" +
          head
            .map((_, k) => `<td${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(r[k] == null ? "" : r[k])}</td>`)
            .join("") +
          "</tr>",
      )
      .join("");
    return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function listMatch(line) {
    return line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
  }

  function isOrdered(mark) {
    return /^\d/.test(mark);
  }

  /** 列表：按缩进递归。`start` 指向第一项，返回 `{html, i}`（i 是列表之后的第一行）。 */
  function parseList(lines, start) {
    const first = listMatch(lines[start]);
    const ordered = isOrdered(first[2]);
    const base = first[1].length;
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = listMatch(lines[i]);
      if (!m) {
        // 续行：非空、不是新块、且有上一项 → 并进上一项（软换行）
        if (lines[i].trim() && items.length && !startsBlock(lines, i)) {
          items[items.length - 1].text += " " + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      const indent = m[1].length;
      if (indent < base) break;
      if (indent > base) {
        if (!items.length) break;
        const sub = parseList(lines, i);
        items[items.length - 1].sub += sub.html;
        i = sub.i;
        continue;
      }
      if (isOrdered(m[2]) !== ordered) break; // 同级换种类 = 另一个列表
      items.push({ text: m[3], sub: "" });
      i += 1;
    }
    const lis = items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join("");
    return { html: ordered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`, i };
  }

  function paraHtml(para) {
    let out = "";
    for (let k = 0; k < para.length; k += 1) {
      let line = para[k];
      const hard = /(?: {2,}|\\)$/.test(line);
      if (hard) line = line.replace(/\\$/, "").replace(/ {2,}$/, "");
      out += inline(line);
      if (k < para.length - 1) out += hard ? "<br>" : " ";
    }
    return out;
  }

  function renderBlocks(src) {
    const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fm = fenceMatch(line);
      if (fm) {
        const mark = fm[1][0];
        const len = fm[1].length;
        const close = new RegExp("^\\s{0,3}" + (mark === "`" ? "`" : "~") + "{" + len + ",}\\s*$");
        const body = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        i += 1; // 跳过结束围栏（没有结束围栏就到文末）
        out.push(`<pre class="md-code"><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }

      const hm = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (hm) {
        const level = hm[1].length;
        out.push(`<h${level}>${inline(hm[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      if (/^\s{0,3}>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map(alignOf);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        out.push(tableHtml(head, aligns, rows));
        continue;
      }

      if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const list = parseList(lines, i);
        out.push(list.html);
        i = list.i;
        continue;
      }

      const start = i;
      const para = [];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
        para.push(lines[i]);
        i += 1;
      }
      if (i === start) {
        // 兜底：`startsBlock` 说"这是块"，但对应解析器没消费它 —— 典型是流式
        // 恰好停在一条半截标题（`## `）上。必须前进一行，否则整页会被一条
        // 还没写完的 Markdown 卡死（`while` 不前进 = 浏览器主线程死循环）。
        para.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${paraHtml(para)}</p>`);
    }
    return out.join("");
  }

  function render(text) {
    return renderBlocks(text == null ? "" : String(text));
  }

  DGM.markdown = { render };
})();
