const pill = document.getElementById("pill");

document.querySelectorAll("button[data-a]").forEach((b) => {
  b.addEventListener("click", () => {
    b.classList.remove("flash");
    void b.offsetWidth; // mulai ulang animasi
    b.classList.add("flash");
    window.widget.action(b.dataset.a);
  });
});

// Tarik dari bagian mana pun pada pil (selain tombol) untuk memindahkan widget secara bebas
let dragging = false, sx = 0, sy = 0;
pill.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("button")) return;
  pill.setPointerCapture(e.pointerId);
  dragging = true; sx = e.screenX; sy = e.screenY;
  pill.classList.add("dragging");
  window.widget.dragStart();
});
let latest = null, raf = 0;
function flush() {
  raf = 0;
  if (latest) { window.widget.drag(latest.dx, latest.dy); latest = null; }
}
pill.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  latest = { dx: e.screenX - sx, dy: e.screenY - sy };
  if (!raf) raf = requestAnimationFrame(flush); // maksimal sekali per frame
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  if (latest) { window.widget.drag(latest.dx, latest.dy); latest = null; }
  pill.classList.remove("dragging");
  window.widget.dragEnd();
};
pill.addEventListener("pointerup", endDrag);
pill.addEventListener("pointercancel", endDrag);