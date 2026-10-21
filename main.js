const { app, BrowserWindow, globalShortcut, screen, clipboard, ipcMain, desktopCapturer, Tray, Menu, nativeImage } = require("electron");
const { spawn, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

// Saat dipasang sebagai aplikasi, folder program tidak boleh ditulisi, jadi data pengguna
// (settings.json dan data bahasa OCR) disimpan di folder data aplikasi.
const DATA_DIR = app.isPackaged ? app.getPath("userData") : __dirname;

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const SHOW_KEY = "Control+Alt+K";
const CAPTURE_KEY = "Control+Alt+J";
const QUIT_KEY = "Control+Alt+Q";
const PAD = 40;   // ruang untuk bayangan (harus sama dengan --pad di popup.css)
const TAIL = 12;  // ruang untuk ekor gelembung (sama dengan --tail)
const KANJI = /[\u3400-\u4dbf\u4e00-\u9fff]/;

const K = require("kuroshiro");
const A = require("kuroshiro-analyzer-kuromoji");
const Kuroshiro = K.default || K;
const KuromojiAnalyzer = A.default || A;
const kuroshiro = new Kuroshiro();
const dictReady = kuroshiro.init(new KuromojiAnalyzer());

let win = null;
let pending = null;
let busy = false;
let ps = null;
let psResolve = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Menekan Ctrl/Cmd+C di aplikasi lain ----------
const PS_SCRIPT = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);' -Name K -Namespace W
function Key($v, $up) { $f = 0; if ($up) { $f = 2 }; [W.K]::keybd_event($v, 0, $f, [UIntPtr]::Zero) }
[Console]::Out.WriteLine('ready')
while (($l = [Console]::In.ReadLine()) -ne $null) {
  if ($l -eq 'copy') {
    foreach ($v in 0x12, 0x10, 0x11, 0x5B) { Key $v $true }
    Start-Sleep -Milliseconds 30
    Key 0x11 $false; Key 0x43 $false; Key 0x43 $true; Key 0x11 $true
    [Console]::Out.WriteLine('done')
  }
}`;

function startHelper() {
  if (!IS_WIN) return;
  ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  ps.stdout.on("data", (d) => {
    if (d.toString().includes("done") && psResolve) {
      psResolve();
      psResolve = null;
    }
  });
}

function copyKeystroke() {
  return new Promise((resolve) => {
    if (IS_WIN) {
      psResolve = resolve;
      ps.stdin.write("copy\n");
      setTimeout(() => { if (psResolve) { psResolve = null; resolve(); } }, 1500);
    } else if (IS_MAC) {
      // beri waktu agar tombol shortcut dilepas dulu
      setTimeout(() => execFile("osascript",
        ["-e", 'tell application "System Events" to keystroke "c" using command down'],
        () => resolve()), 350);
    } else {
      resolve();
    }
  });
}

// Clipboard Electron versi baru bisa mengembalikan Promise (bukan string),
// jadi semua panggilan di-await supaya aman untuk kedua kemungkinan.
const cb = {
  async read() {
    const raw = await clipboard.readText();
    if (typeof raw !== "string") {
      console.warn("[kanji-overlay] readText bukan string:", Object.prototype.toString.call(raw));
      return "";
    }
    return raw;
  },
  async write(t) { await clipboard.writeText(t); },
  async clear() { await clipboard.clear(); },
};

// Mengembalikan isi clipboard lama. Kegagalan di sini tidak boleh membatalkan hasil baca.
async function restoreClipboard(old) {
  try {
    if (old) await cb.write(old); else await cb.clear();
  } catch (_) {
    try {
      // teks lama bisa memuat karakter UTF-16 rusak (mis. dari aplikasi Office)
      const clean = old.replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
      await cb.write(clean);
    } catch (e) {
      console.warn("[kanji-overlay] isi clipboard lama tidak bisa dikembalikan:", e.message);
      try { await cb.clear(); } catch (_) { }
    }
  }
}

const MARK = "\u200b[kanji-overlay]\u200b"; // penanda agar hasil salinan baru bisa dikenali

async function readSelection() {
  const old = await cb.read();
  let marked = false;
  try {
    await cb.write(MARK);
    marked = true;
  } catch (e) {
    console.warn("[kanji-overlay] penanda clipboard gagal ditulis:", e.message);
  }
  await copyKeystroke();
  let text = "";
  for (let i = 0; i < 10; i++) {
    await sleep(50);
    text = await cb.read();
    // tanpa penanda, hasil dianggap benar hanya jika berbeda dari isi clipboard lama
    if (text && text !== MARK && (marked || text !== old)) break;
    text = "";
  }
  await restoreClipboard(old);
  return text.replace(/\s+/g, " ").trim();
}

// Memecah bacaan per kata: kata berkanji memulai segmen baru, kata kana menempel ke segmen sebelumnya
async function segmentReadings(t) {
  try {
    const tokens = await kuroshiro._analyzer.parse(t);
    const segs = [];
    for (const tk of tokens) {
      const surface = tk.surface_form || "";
      const hasKanji = KANJI.test(surface);
      let hira;
      if (hasKanji) {
        hira = tk.reading && tk.reading !== "*"
          ? Kuroshiro.Util.kanaToHiragana(tk.reading)
          : await kuroshiro.convert(surface, { to: "hiragana" });
      } else {
        hira = Kuroshiro.Util.kanaToHiragana(surface);
      }
      if (hasKanji || segs.length === 0) segs.push(hira);
      else segs[segs.length - 1] += hira;
    }
    if (segs.length) return segs;
  } catch (e) {
    console.warn("[kanji-overlay] gagal memecah kata:", e.message);
  }
  return [await kuroshiro.convert(t, { to: "hiragana" })];
}

// Terjemahan lewat endpoint publik Google Translate (tanpa API key, tidak resmi).
// Tidak pernah melempar error: kalau gagal, mengembalikan null.
async function translateText(t) {
  try {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=ja&tl="
      + encodeURIComponent(settings.lang || "id") + "&q=" + encodeURIComponent(t);
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const out = (data[0] || []).map((p) => p[0]).join("").trim();
    return out || null;
  } catch (e) {
    console.warn("[kanji-overlay] terjemahan gagal:", e.message);
    return null;
  }
}

// ---------- Menyusun isi gelembung dari teks ----------
const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

async function makePayload(text, { requireKanji, emptyMsg, noJpMsg }) {
  if (!text) return { kind: "msg", text: emptyMsg };
  if (!(requireKanji ? KANJI : JAPANESE).test(text)) return { kind: "msg", text: noJpMsg };
  await dictReady;
  const t = text.slice(0, 300);
  // bacaan, furigana, dan terjemahan diproses bersamaan supaya tidak menambah waktu tunggu
  const [segments, ruby, translation] = await Promise.all([
    segmentReadings(t),
    kuroshiro.convert(t, { to: "hiragana", mode: "furigana" }),
    translateText(t),
  ]);
  return { kind: "reading", hira: segments.join(""), segments, ruby, translation };
}

// anchor = titik yang ditunjuk ekor gelembung (koordinat layar)
function showPayload(payload, anchor) {
  pending = { anchor };
  win.webContents.send("show", payload);
}

function cursorAnchor() {
  const c = screen.getCursorScreenPoint();
  return { x: c.x, yTop: c.y, yBottom: c.y, gapBelow: 22 };
}

// ---------- Melacak area yang baru saja diblok (lewat gerakan mouse) ----------
// Electron tidak punya event mouse global. Di Windows, proses PowerShell kecil
// memantau tombol kiri mouse; posisi kursor dibaca di sini saat tombol ditekan/dilepas.
const WATCH_SCRIPT = `
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);' -Name M -Namespace W
$prev = $false
while ($true) {
  $d = ([W.M]::GetAsyncKeyState(1) -band 0x8000) -ne 0
  if ($d -ne $prev) {
    $prev = $d
    if ($d) { [Console]::Out.WriteLine('down') } else { [Console]::Out.WriteLine('up') }
  }
  Start-Sleep -Milliseconds 12
}`;

const track = { down: null, release: null }; // release = { from, to, t }
let watcher = null;

function insideOurWindows(p) {
  return [widget, win, selector].some((w) => {
    if (!w || w.isDestroyed() || !w.isVisible()) return false;
    const b = w.getBounds();
    return p.x >= b.x - 6 && p.x <= b.x + b.width + 6 && p.y >= b.y - 6 && p.y <= b.y + b.height + 6;
  });
}

function onMouseDown() {
  const p = screen.getCursorScreenPoint();
  track.down = insideOurWindows(p) ? null : p;
}

function onMouseUp() {
  const p = screen.getCursorScreenPoint();
  if (track.down && !insideOurWindows(p)) track.release = { from: track.down, to: p, t: Date.now() };
  track.down = null;
}

function startMouseTracker() {
  if (IS_WIN) {
    watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WATCH_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    watcher.stdout.on("data", (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (line === "down") onMouseDown();
        else if (line === "up") onMouseUp();
      }
    });
  } else {
    // Mac/Linux: tanpa event tombol, pakai titik terakhir saat kursor berhenti sejenak
    let last = null, still = 0;
    setInterval(() => {
      const p = screen.getCursorScreenPoint();
      if (last && Math.abs(p.x - last.x) <= 3 && Math.abs(p.y - last.y) <= 3) still++;
      else still = 0;
      last = p;
      if (still === 3 && !insideOurWindows(p)) track.release = { from: p, to: p, t: Date.now() };
    }, 50);
  }
}

// Titik yang ditunjuk gelembung: di atas area yang diblok (jika diketahui), kalau tidak di kursor
function pickAnchor(fromWidget) {
  const cur = cursorAnchor();
  const r = track.release;
  if (!r) return cur;
  const near = Math.hypot(cur.x - r.to.x, cur.yTop - r.to.y) < 150;
  if (!fromWidget && !near) return cur; // lewat shortcut dengan kursor sudah jauh dari blok: pakai kursor
  return {
    x: (r.from.x + r.to.x) / 2,
    yTop: Math.min(r.from.y, r.to.y) - 16,
    yBottom: Math.max(r.from.y, r.to.y) + 16,
    gapBelow: 6,
  };
}

// ---------- Mode 1: teks yang diblok (Ctrl+Alt+K) ----------
async function trigger(fromWidget = false) {
  if (busy || capturing || ocrBusy) return;
  busy = true;
  let step = "membaca posisi kursor";
  const anchor = pickAnchor(fromWidget);
  try {
    step = "menyalin teks yang diblok";
    const text = await readSelection();
    step = "mengubah ke hiragana";
    const payload = await makePayload(text, {
      requireKanji: true,
      emptyMsg: "Tidak ada teks yang diblok.",
      noJpMsg: "Tidak ada kanji di teks yang diblok.",
    });
    step = "mengirim ke popup";
    showPayload(payload, anchor);
  } catch (e) {
    console.error("[kanji-overlay] gagal saat " + step + ":", e);
    showPayload({ kind: "msg", text: "Gagal saat " + step + ": " + e.message }, anchor);
  } finally {
    busy = false;
  }
}

// ---------- Mode 2: kotak pilih area gambar + OCR (Ctrl+Alt+J) ----------
let selector = null;
let selectorCtx = null;
let capturing = false;
let ocrBusy = false;
let ocrWorkerPromise = null;

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = require("tesseract.js");
      // data bahasa Jepang diunduh sekali, lalu disimpan di folder proyek (bukan drive C)
      const cachePath = path.join(DATA_DIR, "tessdata");
      fs.mkdirSync(cachePath, { recursive: true });
      const w = await createWorker("jpn", 1, { cachePath });
      await w.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "0" });
      return w;
    })().catch((e) => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

// Tesseract sering menyisipkan spasi di antara huruf Jepang, jadi dibersihkan
const CJK_GAP = /(?<=[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef])/g;
function cleanOcr(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.replace(CJK_GAP, "").trim())
    .filter(Boolean)
    .join(" ");
}

async function startCapture() {
  if (capturing || ocrBusy || busy) return;
  capturing = true;
  try {
    // sembunyikan widget dan gelembung lama supaya tidak ikut terfoto
    widgetWasVisible = !!(widget && widget.isVisible());
    if (widgetWasVisible) widget.hide();
    if (win.isVisible()) win.hide();
    await sleep(150);
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor),
      },
    });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) throw new Error("gambar layar kosong (di Mac, cek izin Screen Recording)");
    await openSelector(display, src.thumbnail);
  } catch (e) {
    capturing = false;
    restoreWidget();
    console.error("[kanji-overlay] gagal mengambil layar:", e);
    showPayload({ kind: "msg", text: "Gagal mengambil layar: " + e.message }, cursorAnchor());
  }
}

async function openSelector(display, full) {
  selectorCtx = { display, full };
  selector = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y,
    width: display.bounds.width, height: display.bounds.height,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    show: false, backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "select-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  selector.setAlwaysOnTop(true, "screen-saver");
  selector.setBounds(display.bounds);
  selector.on("closed", () => { selector = null; capturing = false; restoreWidget(); });
  await selector.loadFile(path.join(__dirname, "select.html"));
  selector.webContents.send("init", {
    dataUrl: "data:image/jpeg;base64," + full.toJPEG(80).toString("base64"),
  });
  selector.show();
  selector.focus();
}

ipcMain.on("select:cancel", (e) => {
  if (selector && e.sender === selector.webContents) selector.close();
});

ipcMain.on("select:done", async (e, r) => {
  if (!selector || e.sender !== selector.webContents || !selectorCtx) return;
  if (![r?.x, r?.y, r?.w, r?.h].every(Number.isFinite)) return;
  const { display, full } = selectorCtx;
  selectorCtx = null;
  selector.close();
  await runOcr(display, full, r);
});

async function runOcr(display, full, r) {
  ocrBusy = true;
  const anchor = {
    x: display.bounds.x + r.x + r.w / 2,
    yTop: display.bounds.y + r.y,
    yBottom: display.bounds.y + r.y + r.h,
    gapBelow: 10,
  };
  let step = "memotong gambar";
  try {
    const size = full.getSize();
    const sx = size.width / display.bounds.width;
    const sy = size.height / display.bounds.height;
    let img = full.crop({
      x: Math.max(0, Math.round(r.x * sx)), y: Math.max(0, Math.round(r.y * sy)),
      width: Math.max(1, Math.round(r.w * sx)), height: Math.max(1, Math.round(r.h * sy)),
    });
    // teks kecil dibesarkan 2x supaya lebih mudah dibaca OCR
    const cs = img.getSize();
    if (cs.width < 1600) img = img.resize({ width: cs.width * 2, height: cs.height * 2, quality: "best" });

    showPayload({ kind: "msg", text: "Membaca teks dari gambar…" }, anchor);
    step = "membaca teks (OCR)";
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(img.toPNG());
    const text = cleanOcr(data.text);

    step = "mengubah ke hiragana";
    const payload = await makePayload(text, {
      requireKanji: false,
      emptyMsg: "Tidak ada teks yang terbaca di area itu.",
      noJpMsg: "Tidak ada teks Jepang yang terbaca di area itu.",
    });
    showPayload(payload, anchor);
  } catch (e) {
    console.error("[kanji-overlay] gagal saat " + step + ":", e);
    showPayload({ kind: "msg", text: "Gagal saat " + step + ": " + e.message }, anchor);
  } finally {
    ocrBusy = false;
  }
}

// ---------- Menempatkan gelembung di dekat titik yang ditunjuk ----------
ipcMain.on("measured", (_e, { w, h }) => {
  if (!pending || !win) return;
  const a = pending.anchor;
  pending = null;

  const W = w + PAD * 2;
  const H = h + (PAD + TAIL) * 2;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.yTop) }).workArea;

  let x = Math.round(a.x - W / 2);
  x = Math.max(wa.x - PAD + 6, Math.min(x, wa.x + wa.width - W + PAD - 6));

  const yAbove = a.yTop - 6 - (PAD + TAIL + h + 10);
  const above = yAbove >= wa.y - PAD + 6;
  let y = above ? yAbove : a.yBottom + (a.gapBelow ?? 22) - (PAD + TAIL - 10);
  y = Math.max(wa.y - PAD + 6, Math.min(y, wa.y + wa.height - H + PAD - 6));

  const tailX = Math.max(26, Math.min(a.x - (x + PAD), w - 26));

  win.setBounds({ x, y: Math.round(y), width: W, height: H });
  win.showInactive();
  setTimeout(() => win.webContents.send("place", { side: above ? "above" : "below", tailX }), 30);
});

ipcMain.on("close", () => { if (win) win.hide(); });

// ---------- Widget melayang di tepi layar ----------
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const WIDGET_W = 72;
const WIDGET_H = 270;
let widget = null;
let widgetWasVisible = false;
let widgetDragStart = null;
let settings = { x: null, y: null, lang: "id" };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch (_) { }

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch (_) { }
}

function widgetCenter() {
  const b = widget.getBounds();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Menjaga widget tetap berada di dalam area kerja layar terdekat
function clampWidget(x, y) {
  const wa = screen.getDisplayNearestPoint({ x: x + WIDGET_W / 2, y: y + WIDGET_H / 2 }).workArea;
  return {
    x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - WIDGET_W))),
    y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - WIDGET_H))),
  };
}

function placeWidget() {
  let x = settings.x, y = settings.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    // posisi awal: tepi kanan layar utama, di tengah
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - WIDGET_W - 16;
    y = wa.y + Math.round((wa.height - WIDGET_H) / 2);
  }
  const p = clampWidget(x, y);
  widget.setBounds({ x: p.x, y: p.y, width: WIDGET_W, height: WIDGET_H });
}

async function createWidget() {
  widget = new BrowserWindow({
    width: WIDGET_W, height: WIDGET_H, show: false,
    minWidth: WIDGET_W, maxWidth: WIDGET_W, minHeight: WIDGET_H, maxHeight: WIDGET_H,
    frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, skipTaskbar: true, alwaysOnTop: true,
    focusable: false, hasShadow: false, fullscreenable: false,
    ...(IS_MAC ? { type: "panel" } : {}),   // tidak mengambil fokus dari aplikasi lain
    webPreferences: {
      preload: path.join(__dirname, "widget-preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  widget.setAlwaysOnTop(true, "screen-saver");
  if (IS_MAC) widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await widget.loadFile(path.join(__dirname, "widget.html"));
  widget.webContents.send("lang", settings.lang);
  placeWidget();
  widget.showInactive();
}

function toggleWidget() {
  if (!widget) return;
  if (widget.isVisible()) widget.hide();
  else { placeWidget(); widget.showInactive(); }
}

function restoreWidget() {
  if (widgetWasVisible && widget) widget.showInactive();
  widgetWasVisible = false;
}

// ---------- Bahasa terjemahan ----------
const LANGUAGES = [
  ["id", "Indonesia"],
  ["en", "Inggris (English)"],
  ["ms", "Melayu (Bahasa Melayu)"],
  ["zh-CN", "Mandarin Sederhana (简体)"],
  ["zh-TW", "Mandarin Tradisional (繁體)"],
  ["ko", "Korea (한국어)"],
  ["ar", "Arab (العربية)"],
  ["es", "Spanyol (Español)"],
  ["fr", "Prancis (Français)"],
  ["de", "Jerman (Deutsch)"],
  ["pt", "Portugis (Português)"],
  ["ru", "Rusia (Русский)"],
  ["th", "Thai (ไทย)"],
  ["vi", "Vietnam (Tiếng Việt)"],
  ["hi", "Hindi (हिन्दी)"],
  ["tr", "Turki (Türkçe)"],
  ["nl", "Belanda (Nederlands)"],
  ["it", "Italia (Italiano)"],
];

function langItems() {
  return LANGUAGES.map(([code, name]) => ({
    label: name, type: "radio", checked: settings.lang === code, click: () => setLang(code),
  }));
}

function setLang(code) {
  settings.lang = code;
  saveSettings();
  if (widget) widget.webContents.send("lang", code);
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function showLangMenu() {
  Menu.buildFromTemplate(langItems()).popup({ window: widget });
}

const fromWidget = (e) => widget && e.sender === widget.webContents;

ipcMain.on("widget:action", (e, a) => {
  if (!fromWidget(e)) return;
  if (a === "read") trigger(true);
  else if (a === "capture") startCapture();
  else if (a === "hide") widget.hide();
  else if (a === "lang") showLangMenu();
});

ipcMain.on("widget:dragstart", (e) => {
  if (fromWidget(e)) widgetDragStart = widget.getPosition();
});
ipcMain.on("widget:drag", (e, d) => {
  if (!fromWidget(e) || !widgetDragStart || !Number.isFinite(d?.dx) || !Number.isFinite(d?.dy)) return;
  widget.setBounds({
    x: Math.round(widgetDragStart[0] + d.dx), y: Math.round(widgetDragStart[1] + d.dy),
    width: WIDGET_W, height: WIDGET_H,
  });
});
ipcMain.on("widget:dragend", (e) => {
  if (!fromWidget(e) || !widgetDragStart) return;
  widgetDragStart = null;
  const b = widget.getBounds();
  const p = clampWidget(b.x, b.y);
  widget.setBounds({ x: p.x, y: p.y, width: WIDGET_W, height: WIDGET_H });
  settings.x = p.x;
  settings.y = p.y;
  saveSettings();
});

// ---------- Ikon di system tray (untuk keluar tanpa terminal) ----------
let tray = null;

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: "Tampilkan / sembunyikan widget", click: toggleWidget },
    { label: "Pilih area gambar (Ctrl+Alt+J)", click: () => startCapture() },
    { label: "Bahasa terjemahan", submenu: langItems() },
    { type: "separator" },
    { label: "Keluar", click: () => app.quit() },
  ]);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png"));
  tray = new Tray(img);
  tray.setToolTip("Kanji Overlay");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", toggleWidget);
}

// ---------- Jendela transparan ----------
async function createWindow() {
  win = new BrowserWindow({
    width: 200, height: 100, show: false,
    frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false, fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await win.loadFile(path.join(__dirname, "popup.html"));
}

console.log("[kanji-overlay] build 14");
if (!app.requestSingleInstanceLock()) {
  console.log("[kanji-overlay] Sudah ada instance lain yang berjalan (kode lama?). " +
    "Tutup dulu dengan: taskkill /F /IM electron.exe  lalu jalankan lagi.");
  app.exit(0);
}

app.whenReady().then(async () => {
  if (IS_MAC && app.dock) app.dock.hide();
  startHelper();
  await createWindow();
  await createWidget();
  createTray();
  startMouseTracker();
  globalShortcut.register("Control+Alt+W", toggleWidget);
  const ok = globalShortcut.register(SHOW_KEY, () => trigger(false));
  const ok2 = globalShortcut.register(CAPTURE_KEY, startCapture);
  globalShortcut.register(QUIT_KEY, () => app.quit());
  console.log(ok
    ? `Kanji Overlay aktif. Blok teks lalu tekan ${SHOW_KEY}.`
    : `Gagal mendaftarkan ${SHOW_KEY}. Kemungkinan dipakai aplikasi lain.`);
  console.log(ok2
    ? `Untuk teks di gambar, tekan ${CAPTURE_KEY} lalu tarik kotak. Widget: Ctrl+Alt+W. Keluar: ${QUIT_KEY}.`
    : `Gagal mendaftarkan ${CAPTURE_KEY}. Kemungkinan dipakai aplikasi lain.`);
  // siapkan OCR di latar belakang (pertama kali butuh internet untuk mengunduh data bahasa Jepang)
  getOcrWorker()
    .then(() => console.log("[kanji-overlay] OCR siap."))
    .catch((e) => console.warn("[kanji-overlay] OCR belum siap:", e.message));
});

app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (ps) ps.kill();
  if (watcher) watcher.kill();
  if (ocrWorkerPromise) ocrWorkerPromise.then((w) => w.terminate()).catch(() => { });
});