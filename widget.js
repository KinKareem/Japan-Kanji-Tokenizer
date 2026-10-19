const pill = document.getElementById("pill");
const grip = document.getElementById("grip");

window.widget.onSide((s) => { pill.className = s; });

document.querySelectorAll("button[data-a]").forEach((b) => {
  b.addEventListener("click", () => {
    b.classList.remove("flash");
    void b.offsetWidth; // mulai ulang animasi
    b.classList.add("flash");
    window.widget.action(b.dataset.a);
  });
});

// Geser widget secara manual (jendela tidak punya bingkai)
let dragging = false, sx = 0, sy = 0;
grip.addEventListener("pointerdown", (e) => {
  grip.setPointerCapture(e.pointerId);
  dragging = true; sx = e.screenX; sy = e.screenY;
  window.widget.dragStart();
});
grip.addEventListener("pointermove", (e) => {
  if (dragging) window.widget.drag(e.screenX - sx, e.screenY - sy);
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  window.widget.dragEnd();
};
grip.addEventListener("pointerup", endDrag);
grip.addEventListener("pointercancel", endDrag);
