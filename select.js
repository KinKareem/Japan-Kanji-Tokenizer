(() => {
  const $ = (id) => document.getElementById(id);
  const bg = $("bg"), box = $("box"), bar = $("bar"), dim = $("dim"), hint = $("hint"), sizeTag = $("size");
  const MIN = 12;
  let rect = null; // {x, y, w, h} dalam piksel CSS
  let drag = null;

  ["nw", "n", "ne", "e", "se", "s", "sw", "w"].forEach((d) => {
    const h = document.createElement("i");
    h.className = "h";
    h.dataset.d = d;
    box.appendChild(h);
  });

  window.sel.onInit(({ dataUrl }) => { bg.src = dataUrl; });

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function render() {
    if (!rect) {
      box.style.display = "none";
      bar.style.display = "none";
      dim.style.display = "block";
      hint.style.display = "block";
      return;
    }
    dim.style.display = "none";
    hint.style.display = "none";
    Object.assign(box.style, {
      display: "block", left: rect.x + "px", top: rect.y + "px",
      width: rect.w + "px", height: rect.h + "px",
    });
    sizeTag.textContent = Math.round(rect.w) + " × " + Math.round(rect.h);
    sizeTag.classList.toggle("in", rect.y < 36);

    if (drag && drag.mode === "draw") { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let top = rect.y + rect.h + 12;
    if (top + bh > innerHeight - 8) top = rect.y - bh - 12;
    if (top < 8) top = Math.max(8, rect.y + rect.h - bh - 12);
    bar.style.left = clamp(rect.x + rect.w - bw, 8, innerWidth - bw - 8) + "px";
    bar.style.top = top + "px";
  }

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || bar.contains(e.target)) return;
    const x = e.clientX, y = e.clientY;
    if (e.target.classList.contains("h")) {
      drag = { mode: "resize", dir: e.target.dataset.d, sx: x, sy: y, orig: { ...rect } };
    } else if (rect && x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      drag = { mode: "move", sx: x, sy: y, orig: { ...rect } };
    } else {
      drag = { mode: "draw", sx: x, sy: y };
      rect = { x, y, w: 0, h: 0 };
    }
    render();
  });

  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const W = innerWidth, H = innerHeight;
    const cx = clamp(e.clientX, 0, W), cy = clamp(e.clientY, 0, H);
    const dx = cx - drag.sx, dy = cy - drag.sy;
    if (drag.mode === "draw") {
      rect = { x: Math.min(drag.sx, cx), y: Math.min(drag.sy, cy), w: Math.abs(cx - drag.sx), h: Math.abs(cy - drag.sy) };
    } else if (drag.mode === "move") {
      const o = drag.orig;
      rect = { ...o, x: clamp(o.x + dx, 0, W - o.w), y: clamp(o.y + dy, 0, H - o.h) };
    } else {
      const o = drag.orig, d = drag.dir;
      let l = o.x, t = o.y, r = o.x + o.w, b = o.y + o.h;
      if (d.includes("w")) l = clamp(o.x + dx, 0, W);
      if (d.includes("e")) r = clamp(o.x + o.w + dx, 0, W);
      if (d.includes("n")) t = clamp(o.y + dy, 0, H);
      if (d.includes("s")) b = clamp(o.y + o.h + dy, 0, H);
      rect = { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) };
    }
    render();
  });

  document.addEventListener("mouseup", () => {
    drag = null;
    if (rect && (rect.w < MIN || rect.h < MIN)) rect = null;
    render();
  });

  function confirm() {
    if (!rect || rect.w < MIN || rect.h < MIN) return;
    window.sel.done({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  }
  function cancel() { window.sel.cancel(); }

  document.addEventListener("dblclick", (e) => {
    if (rect && !bar.contains(e.target) &&
        e.clientX >= rect.x && e.clientX <= rect.x + rect.w &&
        e.clientY >= rect.y && e.clientY <= rect.y + rect.h) confirm();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirm();
    else if (e.key === "Escape") cancel();
  });
  document.addEventListener("contextmenu", (e) => { e.preventDefault(); cancel(); });
  $("ok").addEventListener("click", confirm);
  $("cancel").addEventListener("click", cancel);

  render();
})();
