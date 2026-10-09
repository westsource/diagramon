// 顶部菜单栏（单个下拉层级；「最近文件/语言」这类用嵌套一层）。
//
// 模型由 app.js 构造，本模块只负责渲染与开合，不持有业务状态。

(function () {
  let root = null;
  let model = [];
  let openIndex = -1;

  function closeAll() {
    openIndex = -1;
    for (const dd of root.querySelectorAll(".menu-dropdown")) dd.hidden = true;
    for (const b of root.querySelectorAll(".menubar-item")) b.classList.remove("open");
  }

  function open(i) {
    closeAll();
    openIndex = i;
    const btn = root.querySelectorAll(".menubar-item")[i];
    const dd = root.querySelectorAll(".menu-dropdown")[i];
    btn.classList.add("open");
    dd.hidden = false;
  }

  function renderItems(container, items, depth) {
    container.innerHTML = "";
    for (const item of items) {
      if (item.kind === "separator") {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        container.appendChild(sep);
        continue;
      }
      const row = document.createElement("button");
      row.className = "menu-row" + (item.disabled ? " disabled" : "");
      row.type = "button";

      const label = document.createElement("span");
      label.className = "menu-row-label";
      label.textContent = item.label;
      row.appendChild(label);

      if (item.accel) {
        const accel = document.createElement("span");
        accel.className = "menu-row-accel";
        accel.textContent = item.accel;
        row.appendChild(accel);
      }

      if (item.kind === "submenu") {
        const arrow = document.createElement("span");
        arrow.className = "menu-row-arrow";
        arrow.textContent = "›";
        row.appendChild(arrow);

        const sub = document.createElement("div");
        sub.className = "menu-dropdown submenu";
        sub.hidden = true;
        renderItems(sub, item.items, depth + 1);
        row.appendChild(sub);

        row.addEventListener("click", (e) => {
          e.stopPropagation();
          const isOpen = !sub.hidden;
          for (const other of container.querySelectorAll(".submenu")) other.hidden = true;
          sub.hidden = isOpen;
          if (!isOpen) {
            const r = row.getBoundingClientRect();
            sub.style.left = `${r.width - 6}px`;
            sub.style.top = "0";
          }
        });
        row.classList.add("has-submenu");
      } else {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          if (item.disabled) return;
          closeAll();
          if (item.onClick) item.onClick();
        });
      }
      container.appendChild(row);
    }
  }

  DGM.menu = {
    /** 挂载并首次渲染。 */
    mount(el, menuModel) {
      root = el;
      this.setModel(menuModel);
      window.addEventListener("click", closeAll);
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeAll();
      });
    },

    /** 重建整个菜单（语言切换后由 app.js 再调一次）。 */
    setModel(menuModel) {
      model = menuModel || [];
      root.innerHTML = "";
      model.forEach((menu, i) => {
        const wrap = document.createElement("div");
        wrap.className = "menubar-wrap";

        const btn = document.createElement("button");
        btn.className = "menubar-item";
        btn.type = "button";
        btn.textContent = menu.label;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (openIndex === i) closeAll();
          else open(i);
        });

        const dd = document.createElement("div");
        dd.className = "menu-dropdown";
        dd.hidden = true;
        renderItems(dd, menu.items || [], 0);

        // 悬停切换（已有菜单打开时）
        btn.addEventListener("mouseenter", () => {
          if (openIndex >= 0 && openIndex !== i) open(i);
        });

        wrap.appendChild(btn);
        wrap.appendChild(dd);
        root.appendChild(wrap);
      });
    },

    close: closeAll,
  };
})();
