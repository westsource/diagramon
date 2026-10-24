"""给项目内 Markdown 文档补「版本 + 日期」头部（幂等：已有版本行则跳过）。

约定：
- 日期取文件真实最后修改时间（不编造）；
- 版本取文件名里的显式版本（-v1.2 / 方案v4 / v3），没有则 v1.0；
- 插在第一个 `# 标题` 之后、正文之前，写成 `> 版本：vX.Y · 日期：YYYY-MM-DD`。
用法：python tools/dev/stamp_doc_headers.py [--dry]
"""
import io
import os
import re
import sys
import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # E:\OpenCode\diagramon（脚本在 client2/tools/dev/）
TARGETS = [ROOT / "docs" / "team", ROOT / "service" / "docs"]

VER_RE = re.compile(r"(?:-v(\d+(?:\.\d+)?))|(?:方案\s*v(\d+))|(?:[^a-zA-Z]v(\d+(?:\.\d+)?)\.md$)")


def version_of(name: str) -> str:
    m = VER_RE.search(name)
    if m:
        v = next(g for g in m.groups() if g)
        return "v" + v
    return "v1.0"


def has_header(lines) -> bool:
    head = "".join(lines[:15])
    return "版本：" in head or "版本:" in head


def stamp(path: Path, dry: bool) -> str:
    with io.open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    lines = text.splitlines(keepends=True)
    if has_header(lines):
        return "skip"
    # 找第一行标题
    idx = next((i for i, ln in enumerate(lines) if ln.lstrip().startswith("# ")), None)
    if idx is None:
        return "no-title"
    mtime = datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    header = f"> 版本：{version_of(path.name)} · 日期：{mtime}\n"
    # 标题后若有空行，插在空行之后；否则紧跟标题
    at = idx + 1
    if at < len(lines) and lines[at].strip() == "":
        at += 1
    lines.insert(at, header + "\n")
    if not dry:
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write("".join(lines))
    return "stamped"


def main() -> int:
    dry = "--dry" in sys.argv
    counts = {}
    for base in TARGETS:
        if not base.is_dir():
            continue
        for p in sorted(base.glob("*.md")):
            r = stamp(p, dry)
            counts[r] = counts.get(r, 0) + 1
            print(f"  {r:9} {p.relative_to(ROOT)}")
    print("汇总:", counts, "（dry-run）" if dry else "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
