// Diagramon 离线守卫（随包分发，**必须早于任何应用脚本加载**）
//
// 作用：把"非本机 origin"的网络访问一律拒绝并上报。
//
// 为什么需要它 —— 四种格式的资源都已经随包分发（Mermaid 在 AvaloniaResource、DOT/Graphviz WASM 与
// drawio / Excalidraw 运行时都在 tools/ 下，经本机 loopback 提供），但第三方应用内部总还有**活文档式**
// 的端点（drawio 的云盘 / 在线图形库 / 图标搜索 / 数学渲染，Excalidraw 的分享短链 / 在线图形库目录），
// 它们随上游版本增删，靠"逐个改配置关掉"不可能穷尽。这里给出与配置无关的底线：
//   应用自身绝不联网；被拦下的请求入队一条 `external-blocked`，宿主把它显示到状态栏，便于发现回归。
//
// 放行：同 origin（本机 loopback）、相对路径、data:/blob:/about:。
// 用法：
//   - Excalidraw 承载页：<script src="./offline-guard.js"></script>（在 app.js 之前）
//   - drawio：由 tools/fetch-drawio.ps1 注入到 drawio 的 index.html <head> 之后
//     （drawio 跑在 iframe 里，宿主页的补丁**管不到** iframe 的 realm，因此必须注入到它自己的页面）
(function () {
  if (window.__diagramonOfflineGuard) {
    return;
  }
  window.__diagramonOfflineGuard = true;

  function isLocal(url) {
    try {
      const resolved = new URL(String(url), window.location.href);
      if (resolved.protocol === 'data:' || resolved.protocol === 'blob:' || resolved.protocol === 'about:') {
        return true;
      }
      return resolved.origin === window.location.origin;
    } catch (e) {
      return true;                                  // 解析不了就别拦（相对路径等）
    }
  }

  function record(kind, url) {
    try {
      if (!Array.isArray(window.__hostQueue)) {
        window.__hostQueue = [];
      }
      window.__hostQueue.push(JSON.stringify({
        event: 'external-blocked',
        kind: kind,
        url: String(url).slice(0, 300),
      }));
    } catch (e) {
    }
  }

  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!isLocal(url)) {
        record('fetch', url);
        return Promise.reject(new Error('offline: blocked ' + url));
      }
      return realFetch.apply(this, arguments);
    };
  }

  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (!isLocal(url)) {
      this.__diagramonBlocked = true;
      record('xhr', url);
    }
    return realOpen.apply(this, arguments);
  };

  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (this.__diagramonBlocked) {
      // 按"网络失败"结束这次请求：调用方走各自的错误分支，而不是永远挂起
      try { this.abort(); } catch (e) { }
      try {
        this.dispatchEvent(new Event('error'));
        this.dispatchEvent(new Event('loadend'));
      } catch (e) { }
      return;
    }
    return realSend.apply(this, arguments);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (srcDescriptor && srcDescriptor.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get: srcDescriptor.get,
      set: function (value) {
        if (!isLocal(value)) {
          record('image', value);
          return;
        }
        return srcDescriptor.set.call(this, value);
      },
    });
  }

  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (!isLocal(url)) {
        record('beacon', url);
        return false;
      }
      return realBeacon(url, data);
    };
  }
})();