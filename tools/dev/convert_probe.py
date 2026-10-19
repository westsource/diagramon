#!/usr/bin/env python3
"""转换门禁（**3.9.0 的骨架**）。

3.9.0 只做两件事，都是"能自己跑红"的：

1. 语料存在性 —— `tools/dev/fixtures/convert/` 的 4 个 `.dot` / 3 个 `.d2` / 2 个 `.drawio`
   必须都在；缺一个就说明 I0 的语料没落地；
2. Rust 侧转换不变量 —— `convert::tests`（含 5×5 注册表↔`plan()` 一致性）与
   `mxfile::tests`（含语料可被扫描）必须全绿。

**3.10.0 起才接**：Graphviz json → plan 的 1pt / 结构守恒 / 幂等断言，以及 500 节点计时。
本脚本刻意不依赖 UI，也不启动客户端 —— 它是 `check.mjs` 第 9 步的内核，先独立可跑。

用法（Windows 下用打包的 Python）：

    set DGM_PYTHON=...\\python.exe
    %DGM_PYTHON% tools/dev/convert_probe.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tools" / "dev" / "fixtures" / "convert"

REQUIRED = [
    "login_lr.dot",
    "subgraph_two_levels.dot",
    "self_loop.dot",
    "chinese_labels.dot",
    "boards.d2",
    "container.d2",
    "shapes.d2",
    "stencil.drawio",
    "container.drawio",
    # 3.10.0：Graphviz 真产物的 json（from_dot 的几何/结构回归）
    "login_lr.json",
    "subgraph_two_levels.json",
    "self_loop.json",
    "chinese_labels.json",
]

SUITES = [
    ("convert::tests", "5×5 注册表不变量 + 转换计数"),
    ("mxfile::tests", "mxfile 扫描器 + 语料可读"),
    ("mxfile::emit_tests", "emit：转义 / 相对几何 / 容器先于子节点"),
    ("from_dot::tests", "Graphviz json：objects 集群 / 单位 / y 翻转 / 1px 中心一致"),
]


def run(cmd: list[str]) -> int:
    print("$ " + " ".join(cmd))
    return subprocess.call(cmd, cwd=ROOT)


def main() -> int:
    missing = [name for name in REQUIRED if not (FIXTURES / name).is_file()]
    if missing:
        print(f"[FAIL] 缺少转换语料：{', '.join(missing)}（应在 {FIXTURES}）")
        return 2
    print(f"[ok] 语料齐全（{len(REQUIRED)} 份）")

    for flt, what in SUITES:
        code = run(["cargo", "test", "-q", "-p", "app-core", "--lib", flt])
        if code != 0:
            print(f"[FAIL] {what}（cargo test {flt}）")
            return code
        print(f"[ok] {what}")

    # 3.11.0 的扩展点（明确写出来，别让人以为漏了）
    print("[skip] 往返幂等（parse/emit）—— 3.11.0 接入；500 节点计时在 check.mjs 第 9 步")
    return 0


if __name__ == "__main__":
    sys.exit(main())
