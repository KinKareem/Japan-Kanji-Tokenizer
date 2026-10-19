const LIFE = 12000;
const bubble = document.getElementById("bubble");
const content = document.getElementById("content");
let timer = null;

// Furigana dari kuroshiro berupa HTML, hanya <ruby>, <rt>, <rp> yang dipertahankan
function cleanRuby(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const out = document.createDocumentFragment();
  (function walk(src, dst) {
    src.childNodes.forEach((n) => {
      if (n.nodeType === 3) {
        dst.appendChild(document.createTextNode(n.textContent));
      } else if (n.nodeType === 1 && ["RUBY", "RT", "RP"].includes(n.tagName)) {
        const el = document.createElement(n.tagName.toLowerCase());
        walk(n, el);
        dst.appendChild(el);
      } else if (n.nodeType === 1) {
        walk(n, dst);
      }
    });
  })(tpl.content, out);
  return out;
}

function build(d) {
  content.replaceChildren();
  if (d.kind === "msg") {
    const m = document.createElement("div");
    m.className = "msg";
    m.textContent = d.text;
    content.appendChild(m);
    return;
  }
  const main = document.createElement("div");
  main.className = "main";
  const segments = d.segments && d.segments.length ? d.segments : [d.hira];
  let i = 0;
  segments.forEach((word, n) => {
    if (n > 0) {
      const sep = document.createElement("i");
      sep.className = "sep";
      sep.style.setProperty("--i", Math.min(i, 18));
      main.appendChild(sep);
    }
    const seg = document.createElement("span");
    seg.className = "seg";
    [...word].forEach((ch) => {
      const s = document.createElement("span");
      s.textContent = ch;
      s.style.setProperty("--i", Math.min(i++, 18));
      seg.appendChild(s);
    });
    main.appendChild(seg);
  });
  content.appendChild(main);

  if (d.ruby) {
    const r = document.createElement("div");
    r.className = "ruby";
    r.appendChild(cleanRuby(d.ruby));
    content.appendChild(r);
  }

  const tr = document.createElement("div");
  tr.className = "trans";
  if (d.translation) {
    tr.textContent = d.translation;
  } else {
    tr.classList.add("muted");
    tr.textContent = "Terjemahan tidak tersedia.";
  }
  content.appendChild(tr);
}

window.api.onShow((d) => {
  clearTimeout(timer);
  bubble.className = "";
  bubble.style.setProperty("--life", LIFE + "ms");
  build(d);
  // ukur ukuran gelembung, lalu minta jendela diposisikan di dekat kursor
  window.api.measured({ w: Math.ceil(bubble.offsetWidth), h: Math.ceil(bubble.offsetHeight) });
});

window.api.onPlace(({ side, tailX }) => {
  bubble.style.setProperty("--tail-x", tailX + "px");
  bubble.style.setProperty("--dy", side === "above" ? "8px" : "-8px");
  bubble.classList.add(side);
  requestAnimationFrame(() => requestAnimationFrame(() => bubble.classList.add("in")));
  timer = setTimeout(close, LIFE);
});

function close() {
  clearTimeout(timer);
  bubble.classList.remove("in");
  bubble.classList.add("out");
  setTimeout(() => window.api.close(), 170);
}
document.body.addEventListener("click", close);