// 预览面的视口手势（Mermaid 与 DOT 两个承载页共用这一份；此前两边各有一份逐字重复的实现）。
//
// 与两个内嵌画布（drawio / Excalidraw）对齐后的约定 —— 四处视图的"看"手势必须一致：
//   滚轮                = 平移（垂直）      ← drawio / Excalidraw 的原生手感
//   Shift+滚轮          = 平移（横向）
//   Ctrl+滚轮           = 缩放（锚定光标）  ← 触控板捏合在浏览器里也是"带 Ctrl 的滚轮"
//   左键拖拽 / 中键拖拽  = 平移（预览面是只读的，左键平移不会与"选择"冲突；空格+拖拽因此天然成立）
//   双击                = 适应视图
//
// 与宿主的契约：
//   window.__previewScale      —— 当前比例的**数字**，宿主轮询它显示状态栏百分比（原来只有 DOT 页
//                                 维护 window.scale，Mermaid 页靠顶层 let 兜着，两页口径不同）。
//   window.__previewViewport   —— { fit, zoomBy, setScale, getScale, panBy }，宿主用它下发"适应视图 /
//                                 放大 / 缩小"（应用级快捷键，见 MainWindow）。
window.PreviewViewport = (() => {
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 30;
  // 一个滚轮"格"的缩放倍率：与 drawio 的 Ctrl+滚轮手感同量级（它一格约 1.1 倍）。
  const WHEEL_ZOOM_BASE = 1.1;
  const FIT_PADDING = 24;

  function attach(root, target) {
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let panning = false;
    let lastX = 0;
    let lastY = 0;

    function clamp(value) {
      return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
    }

    function applyTransform() {
      target.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
      target.style.transformOrigin = 'center center';
      window.__previewScale = scale;
    }

    function fit() {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      applyTransform();

      const rootRect = root.getBoundingClientRect();
      const diagramRect = target.getBoundingClientRect();
      if (rootRect.width <= 0 || rootRect.height <= 0 || diagramRect.width <= 0 || diagramRect.height <= 0) {
        return;
      }

      const fitScaleX = Math.max(0.01, (rootRect.width - FIT_PADDING) / diagramRect.width);
      const fitScaleY = Math.max(0.01, (rootRect.height - FIT_PADDING) / diagramRect.height);
      scale = clamp(Math.min(fitScaleX, fitScaleY));
      applyTransform();
    }

    // 以某个视口坐标（相对 #root 左上角）为锚点缩放：变换以元素中心为原点，
    // 因此锚点相对中心的位移要按比例反向补偿，否则缩放会"跑偏"。
    function zoomAt(factor, clientX, clientY) {
      const oldScale = scale;
      scale = clamp(scale * factor);
      if (Math.abs(scale - oldScale) < 1e-6) {
        return;
      }

      const rect = root.getBoundingClientRect();
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      const ratio = scale / oldScale;
      offsetX -= cx * (ratio - 1);
      offsetY -= cy * (ratio - 1);
      applyTransform();
    }

    // 宿主下发的"放大一档 / 缩小一档"：锚点取视口中心（没有光标位置可用）
    function zoomBy(factor) {
      const rect = root.getBoundingClientRect();
      zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    function setScale(value) {
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      zoomBy(clamp(value) / scale);
    }

    function panBy(dx, dy) {
      offsetX += dx;
      offsetY += dy;
      applyTransform();
    }

    // 滚轮/触控板：deltaMode 1 = 行、2 = 页，按 Chromium 的换算尺寸折成像素，
    // 否则不同设备上"一格"的位移差出一个数量级。
    function wheelPixels(event) {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
      return { x: event.deltaX * unit, y: event.deltaY * unit };
    }

    root.addEventListener('wheel', (event) => {
      event.preventDefault();

      if (event.ctrlKey) {
        const { y } = wheelPixels(event);
        zoomAt(y < 0 ? WHEEL_ZOOM_BASE : 1 / WHEEL_ZOOM_BASE, event.clientX, event.clientY);
        return;
      }

      const { x, y } = wheelPixels(event);
      // Shift+滚轮 = 横向平移：多数鼠标只有纵向滚轮，此时用 deltaY 当横向位移
      const dx = event.shiftKey ? (y !== 0 ? y : x) : x;
      const dy = event.shiftKey ? 0 : y;
      panBy(-dx, -dy);
    }, { passive: false });

    root.addEventListener('pointerdown', (event) => {
      // 左键（0）与中键（1）都平移；右键留给上下文菜单
      if (event.button !== 0 && event.button !== 1) {
        return;
      }

      event.preventDefault();
      panning = true;
      lastX = event.clientX;
      lastY = event.clientY;
      root.style.cursor = 'grabbing';
      root.setPointerCapture(event.pointerId);
    });

    root.addEventListener('pointermove', (event) => {
      if (!panning) {
        return;
      }

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      offsetX += dx;
      offsetY += dy;
      applyTransform();
    });

    const endPan = (event) => {
      if (!panning) {
        return;
      }

      panning = false;
      root.style.cursor = 'grab';
      if (root.hasPointerCapture(event.pointerId)) {
        root.releasePointerCapture(event.pointerId);
      }
    };

    root.addEventListener('pointerup', endPan);
    root.addEventListener('pointercancel', endPan);

    root.addEventListener('dblclick', () => {
      fit();
    });

    // 中键在部分环境会触发自动滚动，明确挡掉
    root.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
      }
    });

    // 右键：与两个内嵌画布一致 —— 画布页有自己的右键菜单，预览页不该弹 WebView 的默认菜单
    root.addEventListener('contextmenu', (event) => {
      event.preventDefault();
    });

    const api = {
      fit,
      zoomBy,
      setScale,
      getScale: () => scale,
      panBy,
    };

    applyTransform();
    window.__previewViewport = api;
    return api;
  }

  // --------------------------------------------------------------------------
  // 应用级快捷键转发（与两个画布承载页同一张词汇表）。
  //
  // 预览 WebView 持有焦点时（用户点过预览面），Avalonia 窗口级的 KeyBindings 收不到键 ——
  // 键先落在 WebView 的窗口过程上。命中的组合键放进 window.__previewHotkey 这个单槽，
  // 由宿主 250ms 的轮询取走并清空（见 MainWindow.StartZoomPolling）。
  // 只转发应用级命令，撤销/复制等编辑类快捷键留给文本编辑器与页面自身。
  // --------------------------------------------------------------------------
  function normalizeHotkey(event) {
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return null;
    }

    switch (event.key) {
      case 's': case 'S': return event.shiftKey ? 'ctrl+shift+s' : 'ctrl+s';
      case 'o': case 'O': return 'ctrl+o';
      case 'n': case 'N': return 'ctrl+n';
      case 'w': case 'W': return 'ctrl+w';
      case 'q': case 'Q': return 'ctrl+q';
      case '0': return 'ctrl+0';
      case '=': case '+': return 'ctrl+zoom-in';
      case '-': case '_': return 'ctrl+zoom-out';
      default: return null;
    }
  }

  window.addEventListener('keydown', (event) => {
    const combo = normalizeHotkey(event);
    if (!combo) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    window.__previewHotkey = combo;
  }, true);

  return { attach, MIN_SCALE, MAX_SCALE, WHEEL_ZOOM_BASE };
})();
