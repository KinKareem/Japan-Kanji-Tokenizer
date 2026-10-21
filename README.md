# Kanji Overlay

Blok teks Jepang di aplikasi apa pun, atau tarik kotak di atas gambar. Gelembung kecil muncul berisi
hiragana, furigana, dan terjemahan.

## Pasang

Unduh dari halaman **Releases**:

- **Windows:** `Kanji-Overlay-Setup-x.y.z.exe` (installer) atau `Kanji-Overlay-x.y.z-portable.exe` (tanpa instalasi).
- **macOS:** `Kanji-Overlay-x.y.z-mac-arm64.dmg` (Apple Silicon) atau `...-mac-x64.dmg` (Intel).

Aplikasi belum bertanda tangan digital, jadi sistem akan memberi peringatan saat pertama dibuka:

- **Windows:** klik *More info* lalu *Run anyway*.
- **macOS:** klik kanan aplikasinya, pilih *Open*. Beri izin *Accessibility* dan *Screen Recording* di System Settings.

## Cara pakai

| Aksi | Cara |
|---|---|
| Baca teks yang diblok | Blok teks, lalu **Ctrl+Alt+K** atau tombol 読 di widget |
| Baca teks di gambar (OCR) | **Ctrl+Alt+J** atau tombol ▢ di widget, lalu tarik kotak dan tekan Enter |
| Tampil / sembunyikan widget | **Ctrl+Alt+W** atau ikon di system tray |
| Ganti bahasa terjemahan | Tombol 文 di widget, atau klik kanan ikon tray → *Bahasa terjemahan* |
| Keluar | **Ctrl+Alt+Q** atau klik kanan ikon tray, lalu *Keluar* |

Pertama kali memakai OCR, aplikasi mengunduh data bahasa Jepang (beberapa MB) dan butuh internet.
Setelah itu OCR berjalan offline. Terjemahan memakai layanan Google Translate dan butuh internet.

## Menjalankan dari kode

```bash
npm install
npm start
```

## Membuat rilis baru

```bash
# naikkan "version" di package.json, lalu:
git commit -am "Rilis 0.3.1"
git tag v0.3.1
git push origin main --tags
```

GitHub Actions membangun installer untuk Windows dan macOS, lalu menaruhnya di Releases.