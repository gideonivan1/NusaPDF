# PRD — NusaPDF

**Versi:** 0.1 (draft) · **Tanggal:** 22 Agustus 2026 · **Penulis:** Gideon Ivan Panjaitan · **Status:** Draft untuk review

---

## 1. Overview

**Feature / Project Name:** NusaPDF — perkakas PDF berbasis web dengan asisten AI

**Problem Statement:**
Pekerja kantoran, mahasiswa, dan UMKM di Indonesia rutin butuh operasi PDF sederhana (gabung, pisah, kompres, konversi ke Office) tapi terpaksa memakai layanan asing yang meng-upload dokumen mereka ke server luar negeri — masalah nyata untuk dokumen berisi NIK, data keuangan, atau kontrak. Layanan gratis juga memasang paywall agresif setelah 1–2 operasi. Di sisi lain, dokumen yang panjang (laporan, regulasi, jurnal) menuntut waktu baca yang tidak dimiliki penggunanya, dan belum ada perkakas yang menggabungkan utilitas PDF dengan pemahaman isi dokumen dalam satu tempat.

**Proposed Solution:**
Web app yang menjalankan mayoritas operasi PDF **langsung di browser** (file tidak pernah meninggalkan perangkat) dan melapisinya dengan **AI PDF** berbasis Gemini untuk tanya-jawab dan ringkasan dokumen — semuanya dapat dipakai tanpa login.

**AI Build Summary:**

> Build a Next.js 15 (App Router) + TypeScript + Tailwind CSS v4 web application named NusaPDF. Implement a hybrid PDF processing architecture: PDF-native operations (merge, split, compress, PDF→JPG, JPG→PDF) run entirely client-side in Web Workers using `pdf-lib` and `pdfjs-dist` — files are never uploaded. Office conversions (PDF↔Word/PowerPoint/Excel) run server-side via a job queue and are OUT of MVP scope. Implement AI PDF chat using the Google Gemini API (`@google/genai`) with native PDF input via the Files API, streaming responses over SSE, and page-level citations. Use Supabase for auth (anonymous sign-in by default, upgradeable to email/Google), Postgres (with RLS on every table), and Storage (only for AI-uploaded documents, auto-purged after 24h). Anonymous users can use all client-side tools without limits; AI PDF is quota-limited. Apply the Mastercard-inspired design system: Canvas Cream `#F3F0EE` background, Ink Black `#141413` pill CTAs at 20px radius, circular tool portraits, body text at font-weight 450, headline letter-spacing -2%. Use Sofia Sans as the typeface. Target WCAG 2.2 AA. UI language is Indonesian.

---

## 2. Goals & Success Metrics

**Primary Goal:**
Pengguna menyelesaikan tugas PDF pertamanya dalam <60 detik sejak mendarat, tanpa membuat akun dan tanpa meng-upload file ke server.

**Success Metrics:**

| # | Metrik | Target (90 hari pasca-rilis) |
|---|---|---|
| 1 | **Task completion rate** — sesi yang mencapai unduhan hasil | ≥ 65% |
| 2 | **Time to first result** — median dari mendarat → file terunduh | ≤ 60 detik |
| 3 | **AI PDF activation** — pengguna yang mengirim ≥1 pertanyaan AI | ≥ 15% dari sesi mingguan |
| 4 | **Return rate 7 hari** | ≥ 25% |
| 5 | **Client-side success rate** — operasi browser selesai tanpa error/fallback | ≥ 97% |

**Anti-goals:**
- **Bukan** editor PDF penuh setara Acrobat (form filling, redaction, e-signature, OCR) — MVP hanya anotasi ringan, dan itu pun Fase 2.
- **Bukan** platform kolaborasi — tidak ada komentar bersama, real-time multi-user, atau berbagi ruang kerja.
- **Bukan** penyimpanan dokumen jangka panjang — NusaPDF adalah alat lintas, bukan Google Drive. File AI dihapus otomatis.
- **Tidak** mengejar akurasi konversi Office di MVP — fitur itu sengaja ditunda ke Fase 2 agar tidak menyandera rilis.
- **Tidak** membangun sistem billing di MVP.

---

## 3. Scope & Constraints

### In scope (MVP — Rilis 1)

| Tool | Mode | Catatan |
|---|---|---|
| **AI PDF** | Server (Gemini) | Chat, ringkasan, sitasi halaman |
| **Merge PDF** | Client | Multi-file, drag-reorder halaman |
| **Split PDF** | Client | Per halaman, rentang, atau pecah semua |
| **Compress PDF** | Client | 3 level; lihat Risiko R2 |
| **PDF to JPG** | Client | Per halaman + ekstrak gambar tertanam |
| **JPG to PDF** | Client | Orientasi, margin, ukuran kertas |
| Multi-upload + preview per halaman | Client | Berlaku untuk semua tool di atas |
| Auth anonim Supabase + upgrade akun | Server | |
| Riwayat percakapan AI | Server | Hanya untuk akun terdaftar |

### In scope (Fase 2 — didokumentasikan, tidak dibangun sekarang)

PDF to Word · PDF to PowerPoint · PDF to Excel · Word to PDF · PowerPoint to PDF · Excel to PDF · Edit PDF (teks, gambar, bentuk, anotasi tangan)

### Out of scope

- OCR untuk PDF hasil pindai (scanned) — memengaruhi AI PDF, lihat Risiko R4
- E-signature, form filling, redaction, proteksi/pembukaan password
- Aplikasi mobile native, ekstensi browser, API publik
- Billing, langganan, tim/organisasi
- Bahasa selain Indonesia (arsitektur i18n disiapkan, konten belum)

### Technical constraints

| Aspek | Ketetapan |
|---|---|
| **Platform** | Web responsif. Browser target: Chrome/Edge ≥ 111, Firefox ≥ 115, Safari ≥ 16.4 (butuh dukungan `OffscreenCanvas` & modul Worker) |
| **Auth** | Supabase Auth. `signInAnonymously()` di kunjungan pertama → setiap pengunjung punya `auth.uid()` sehingga RLS berlaku seragam. Upgrade via `linkIdentity()` (email magic link + Google OAuth) tanpa kehilangan riwayat |
| **Aksesibilitas** | WCAG 2.2 Level AA — wajib, bukan aspirasi. Termasuk alternatif keyboard untuk semua drag-and-drop |
| **Offline** | Tool client-side wajib tetap berfungsi setelah aset ter-cache (PWA shell + service worker). AI PDF butuh koneksi dan harus gagal dengan pesan jelas |
| **Performa** | LCP ≤ 2,5s di 4G. Semua pekerjaan PDF di Web Worker — main thread tidak boleh terblokir >50ms. Preview 50 halaman pertama ter-render ≤ 3s |
| **Batas file** | Client: ≤ 100 MB/file, ≤ 20 file/batch, peringatan di atas 50 MB. AI PDF: ≤ 50 MB, ≤ 500 halaman/dokumen, maks 3 dokumen/percakapan |
| **Kepatuhan data** | UU PDP No. 27/2022. Region Supabase: Singapore (`ap-southeast-1`). File AI dihapus ≤ 24 jam. Tool client-side tidak pernah mengirim isi file — hanya telemetri anonim (nama tool, ukuran, durasi, sukses/gagal) |
| **Rahasia** | `GEMINI_API_KEY` hanya server-side. Tidak pernah diekspos ke klien; semua panggilan Gemini lewat Route Handler |

---

## 4. Jobs to Be Done

| Prioritas | Job Statement |
|---|---|
| **J1** | Ketika saya harus menyerahkan beberapa dokumen sebagai satu berkas dan tenggatnya sebentar lagi, saya ingin menggabungkan serta menata ulang PDF dengan cepat, agar saya bisa mengirimkannya sebelum tenggat tanpa memasang aplikasi apa pun. |
| **J2** | Ketika dokumen yang saya proses memuat data pribadi atau keuangan, saya ingin memastikan berkasnya tidak ter-upload ke server siapa pun, agar saya bisa memakai alat gratis tanpa melanggar aturan kerahasiaan tempat kerja saya. |
| **J3** | Ketika saya menerima laporan atau regulasi ratusan halaman, saya ingin bertanya langsung ke dokumennya dan mendapat jawaban beserta rujukan halaman, agar saya bisa memahami isinya tanpa membaca seluruhnya. |
| **J4** | Ketika berkas saya ditolak sistem karena terlalu besar, saya ingin mengecilkannya tanpa membuat teks jadi buram, agar unggahan saya diterima pada percobaan pertama. |
| **J5** | Ketika saya hanya butuh sebagian kecil dari sebuah PDF, saya ingin melihat pratinjau halaman dan memilih tepat yang saya perlukan, agar saya tidak membagikan halaman yang seharusnya tidak dilihat orang lain. |

---

## 5. User Stories

| ID | Role | Action | Benefit | JTBD |
|---|---|---|---|---|
| **US1** | Pengunjung baru | menjatuhkan beberapa PDF dan langsung memprosesnya | tanpa mendaftar atau melihat paywall | J1, J2 |
| **US2** | Pengguna umum | menata ulang urutan file dan halaman sebelum menggabungkan | hasil gabungannya benar sejak percobaan pertama | J1 |
| **US3** | Pengguna umum | melihat pratinjau tiap halaman dan memilih halaman tertentu | saya memisahkan tepat bagian yang saya butuhkan | J5 |
| **US4** | Pengguna hemat kuota | memilih tingkat kompresi dan melihat estimasi ukuran akhir | saya menyeimbangkan ukuran dan keterbacaan | J4 |
| **US5** | Pengguna yang sadar privasi | melihat indikator jelas bahwa file diproses di perangkat saya | saya percaya memakainya untuk dokumen sensitif | J2 |
| **US6** | Pembaca dokumen panjang | mengunggah PDF dan bertanya dalam bahasa Indonesia | saya mendapat jawaban tanpa membaca seluruh dokumen | J3 |
| **US7** | Pembaca dokumen panjang | mengeklik sitasi pada jawaban AI dan melompat ke halamannya | saya bisa memverifikasi jawaban itu benar | J3 |
| **US8** | Pengguna berulang | membuat akun dan menemukan riwayat percakapan AI saya | saya melanjutkan pekerjaan lintas perangkat | J3 |
| **US9** | Pengguna keyboard / pembaca layar | menjalankan seluruh alur tanpa mouse | saya bisa memakai produk ini sama seperti orang lain | Semua |
| **US10** | Pengguna dengan file bermasalah | menerima pesan galat yang menjelaskan penyebab dan langkah berikutnya | saya tahu harus berbuat apa alih-alih menyerah | Semua |

---

## 6. Proposed Experience

### Design Direction

Menerapkan **design system Mastercard-inspired** (lihat skill `design-mastercard` untuk spesifikasi penuh). Alasan pemilihan: seluruh kompetitor kategori ini (iLovePDF, Smallpdf, PDF24) memakai palet biru-putih SaaS yang nyaris identik. Kanvas krim hangat + tombol pill ink-black memberi NusaPDF **daya ingat visual** sekaligus nada "tenang dan tepercaya" — cocok untuk produk yang menjual privasi.

**Token kunci yang mengikat (jangan diaproksimasi):**

| Peran | Nilai |
|---|---|
| Latar halaman | Canvas Cream `#F3F0EE` — tidak pernah putih murni |
| Permukaan terangkat | Lifted Cream `#FCFBFA` |
| CTA primer | Ink Black `#141413`, teks cream, radius **20px** |
| Teks isi | Ink Black, **font-weight 450** (bukan 400 — ini tanda tangan sistemnya) |
| Judul | weight 500, letter-spacing **-2%** |
| Aksen orbital | Light Signal Orange `#F37338`, garis ~1px |
| Signal Orange `#CF4500` | **Hanya** untuk consent/legal — tidak pernah untuk CTA marketing |
| Radius | Hanya ≤6px, 20–40px, atau ≥99px. **Tidak pernah 8–16px** |
| Elevasi | Sebaran besar, opasitas rendah (`0 24px 48px rgba(0,0,0,.08)`). Tidak ada bayangan keras |
| Tipografi | Sofia Sans (Google Fonts) — pengganti open-source MarkForMC |

**Penerapan khas NusaPDF:**
- **13 kartu tool di beranda** = *circular portrait cards*: ikon/ilustrasi dalam lingkaran sempurna Ø 200px, dengan *satellite CTA* putih (Ø 56px, panah ink) menempel di kanan-bawah, menonjol ~40% ke luar lingkaran. Eyebrow di bawahnya (titik oranye + `ORGANIZE` / `CONVERT` / `AI`), lalu judul H3.
- **Garis orbital oranye tipis** menghubungkan kartu-kartu tool — memvisualkan bahwa perkakasnya satu keluarga, bukan daftar.
- **Nav pill mengambang** putih, radius 999px, 24px dari tepi atas.
- **Dropzone** = stadium besar radius 40px di atas kanvas krim, bukan kotak putus-putus generik.
- **Footer ink-black** `#141413`, 4 kolom.

> **Catatan aksesibilitas token:** Ink Black di atas Canvas Cream ≈ 15:1 (lolos AAA). Slate Gray `#696969` di atas cream ≈ 4,6:1 — **hanya untuk teks ≥16px**, jangan untuk label kecil. Dust Taupe `#D1CDC7` tidak lolos AA untuk teks apa pun; pakai murni dekoratif.

### Key Screens / States

| Layar | Rute | Fungsi |
|---|---|---|
| **Beranda** | `/` | Hero + konstelasi 13 kartu tool + jaminan privasi |
| **Halaman tool** | `/[tool]` | Alur 3 tahap: Pilih file → Atur → Hasil |
| **Papan halaman** | dalam tool | Grid thumbnail semua halaman; seleksi/urut/rotasi |
| **Ruang kerja AI** | `/ai-pdf/[conversationId]` | Split-view: viewer PDF kiri (60%), chat kanan (40%) |
| **Riwayat** | `/riwayat` | Daftar percakapan AI (hanya akun terdaftar) |
| **Masuk** | `/masuk` | Magic link + Google, dengan penjelasan "riwayatmu ikut terbawa" |

**State per tool (wajib dirancang eksplisit, bukan afterthought):**

| State | Perilaku |
|---|---|
| **Empty** | Dropzone stadium 40px, ilustrasi lingkaran, teks "Jatuhkan PDF di sini atau pilih dari perangkat", tombol pill ink-black. Di bawahnya: baris privasi (`🔒 Diproses di perangkat Anda`) |
| **Dragging** | Border dropzone menebal jadi Light Signal Orange, latar bergeser ke Lifted Cream, skala 1.01 |
| **Reading** | Progress menentukan (ada persentase) saat mem-parse; thumbnail muncul progresif per halaman, bukan sekaligus |
| **Configuring** | Panel opsi muncul di kanan (desktop) / sheet bawah (mobile). Tombol proses aktif hanya bila input valid |
| **Processing** | Progress bar menentukan + label halaman ke-N dari M. **Tombol batal wajib ada** |
| **Success** | Kartu hasil: nama file, ukuran sebelum→sesudah, tombol Unduh (pill ink), aksi lanjutan ("Kompres lagi", "Kirim ke AI PDF") |
| **Partial success** | Sebagian file gagal → tetap tampilkan yang berhasil + daftar yang gagal beserta alasannya. **Jangan** gagalkan seluruh batch |
| **Error** | Lihat matriks galat di bawah |
| **Offline** | Banner: tool client-side tetap jalan; kartu AI PDF meredup dengan penjelasan |

**Matriks galat (setiap galat wajib punya penyebab + langkah berikutnya):**

| Kode | Situasi | Pesan ke pengguna |
|---|---|---|
| `E_ENCRYPTED` | PDF terproteksi password | "PDF ini terkunci password. Buka proteksinya lebih dulu, lalu coba lagi." |
| `E_CORRUPT` | Gagal di-parse | "Berkas ini tampaknya rusak atau bukan PDF yang valid." |
| `E_TOO_LARGE` | > 100 MB | "Berkas melebihi 100 MB. Coba kompres dulu." + tautan ke Compress |
| `E_OOM` | Memori browser habis | "Dokumen terlalu berat untuk peramban ini. Coba proses lebih sedikit halaman sekaligus." |
| `E_UNSUPPORTED_TYPE` | Tipe salah untuk tool | "Alat ini menerima PDF. Berkas Anda .docx — mungkin maksud Anda Word to PDF?" + tautan |
| `E_SCANNED_NO_TEXT` | AI PDF, PDF hasil pindai | "Dokumen ini tampak hasil pindai tanpa lapisan teks. AI belum bisa membacanya (OCR menyusul)." |
| `E_QUOTA` | Kuota AI habis | "Kuota AI harian Anda habis. Masuk untuk mendapat kuota lebih besar." + CTA |
| `E_AI_TIMEOUT` | Gemini gagal/timeout | "Asisten sedang tidak merespons. Coba lagi sebentar." + tombol ulangi |

### Interaction Model

**Alur utama (Merge — mewakili semua tool client-side):**
1. Pengguna menjatuhkan/memilih 2+ PDF → tiap file muncul sebagai baris kartu berisi nama, ukuran, jumlah halaman
2. Worker mem-parse tiap file; thumbnail halaman ter-render progresif
3. Pengguna menata ulang **file** (drag baris) dan opsional **halaman** (buka papan halaman)
4. Klik "Gabungkan PDF" (pill ink-black) → progress menentukan
5. Kartu hasil muncul → Unduh (memicu `Blob` lokal, tidak ada request jaringan)

**Alur AI PDF:**
1. Unggah PDF → **ini satu-satunya alur MVP yang mengirim file ke server**, dan UI harus menyatakannya terang-terangan sebelum unggah
2. File → Supabase Storage → Gemini Files API; status `ready`
3. Pengguna bertanya → jawaban ter-stream token demi token
4. Sitasi muncul sebagai chip `hal. 42` → klik = viewer kiri melompat & menyorot halaman itu
5. Percakapan tersimpan bila pengguna terdaftar; anonim = sesi saja

**Gestur & pintasan:**

| Pintasan | Aksi |
|---|---|
| `Ctrl/Cmd + O` | Buka pemilih berkas |
| `Ctrl/Cmd + Enter` | Jalankan operasi |
| `Ctrl/Cmd + Z` | Batalkan perubahan urutan/seleksi terakhir |
| `Space` | Pilih/lepas halaman yang sedang fokus |
| `Alt + ↑/↓` | **Pindahkan item tanpa mouse** (alternatif drag wajib) |
| `Esc` | Batalkan operasi berjalan / tutup modal |

**Undo/redo:** riwayat 20 langkah untuk penataan file, seleksi halaman, dan rotasi. Tidak berlaku untuk operasi yang sudah dieksekusi (hasil sudah jadi berkas terpisah).

### Accessibility Notes

- **Drag-and-drop wajib punya padanan keyboard.** Setiap baris file & thumbnail halaman punya tombol "Naik"/"Turun" yang terlihat saat fokus, plus `Alt+↑/↓`. Ini kegagalan aksesibilitas paling umum di kategori produk ini.
- Dropzone dibangun di atas `<input type="file">` asli yang tersembunyi secara visual namun tetap fokusable — bukan `<div>` dengan handler.
- Kemajuan proses diumumkan lewat `aria-live="polite"` pada ambang 25/50/75/100%, bukan setiap tick.
- Thumbnail halaman: `role="checkbox"` + `aria-checked` + label "Halaman 3 dari 40, terpilih".
- Viewer PDF menyediakan mode teks alternatif (lapisan teks pdf.js) agar pembaca layar dapat mengakses isi.
- Kontras minimum 4,5:1 untuk teks, 3:1 untuk batas komponen. Status tidak pernah disampaikan **hanya** lewat warna — selalu ada ikon + teks.
- `prefers-reduced-motion` mematikan animasi orbital, transisi kartu, dan efek skala dropzone.
- Target sentuh ≥ 44×44px (design system sudah menjamin ini: satellite CTA 56px, tombol nav 48px).

**Figma / Design Link:** _[placeholder — tambahkan saat tersedia]_

---

## 7. Component Inventory

| Komponen | Tipe | Deskripsi | Stories |
|---|---|---|---|
| `AppShell` | Layout | Kanvas cream + nav pill mengambang + footer ink | Semua |
| `NavPill` | Navigation | Pill putih 999px, logo kiri, tautan tengah, akun kanan | Semua |
| `ToolConstellation` | Layout | Grid asimetris 13 kartu + garis orbital SVG | US1 |
| `ToolPortraitCard` | Display | Portrait lingkaran Ø200px + satellite CTA + eyebrow + judul | US1 |
| `OrbitalArc` | Display | SVG path oranye 1px penghubung kartu; sembunyi di mobile | — |
| `Dropzone` | Form | Stadium 40px, drag+klik+paste, validasi tipe/ukuran | US1, US10 |
| `FileQueueList` | Display | Daftar file terurut, dapat ditata ulang (mouse + keyboard) | US2 |
| `FileQueueRow` | Display | Nama, ukuran, jumlah halaman, tombol naik/turun/hapus | US2, US9 |
| `PagePreviewGrid` | Display | Grid thumbnail virtualisasi seluruh halaman | US3, US5 |
| `PageThumbnail` | Display | Kanvas render + checkbox + tombol rotasi + nomor | US3, US9 |
| `ToolOptionsPanel` | Form | Wadah opsi per tool (kanan di desktop, sheet di mobile) | US4 |
| `CompressionLevelSelector` | Form | 3 pilihan + estimasi ukuran hasil | US4 |
| `SplitModeSelector` | Form | Per halaman / rentang / pecah semua | US3 |
| `ImageToPdfOptions` | Form | Orientasi, margin, ukuran kertas | — |
| `ProcessButton` | Action | CTA pill ink-black, tahu state disabled/loading | Semua |
| `ProgressPanel` | Display | Progress menentukan + label + tombol batal | US10 |
| `ResultCard` | Display | Nama hasil, ukuran sebelum→sesudah, unduh, aksi lanjutan | Semua |
| `PrivacyBadge` | Display | Indikator "Diproses di perangkat Anda" + tooltip penjelasan | US5 |
| `ErrorNotice` | Display | Penyebab + langkah berikutnya + aksi pemulihan | US10 |
| `EmptyState` | Display | Ilustrasi lingkaran + ajakan + CTA | US1 |
| `AiWorkspaceLayout` | Layout | Split-view viewer/chat, dapat digeser, tumpuk di mobile | US6 |
| `PdfViewer` | Display | Viewer pdf.js: zoom, lompat halaman, sorot | US7 |
| `ChatThread` | Display | Daftar pesan, auto-scroll, indikator streaming | US6 |
| `ChatComposer` | Form | Textarea auto-grow, kirim, saran prompt awal | US6 |
| `CitationChip` | Action | Chip `hal. N`, klik = lompat ke halaman | US7 |
| `SuggestedPrompts` | Action | 3 chip pembuka ("Ringkas dokumen ini", dst.) | US6 |
| `QuotaMeter` | Display | Sisa kuota AI + CTA masuk saat menipis | US8 |
| `AuthDialog` | Modal | Magic link + Google, menjelaskan pelestarian riwayat | US8 |
| `ConversationHistoryList` | Display | Daftar percakapan tersimpan | US8 |
| `UpgradeAccountBanner` | Display | Ajakan ke anonim: "Simpan riwayatmu" | US8 |
| `ConsentBanner` | Modal | Cookie/analitik — **satu-satunya tempat Signal Orange** | — |
| `KeyboardShortcutSheet` | Modal | Daftar pintasan (`?`) | US9 |
| `Footer` | Layout | Ink-black, 4 kolom, pemilih bahasa pill | Semua |

---

## 8. Data Models

```typescript
// ───────────────────────── Enum & tipe bersama ─────────────────────────

type ToolSlug =
  | 'ai-pdf' | 'merge' | 'split' | 'compress' | 'pdf-to-jpg' | 'jpg-to-pdf'   // MVP
  | 'pdf-to-word' | 'pdf-to-powerpoint' | 'pdf-to-excel'                      // Fase 2
  | 'word-to-pdf' | 'powerpoint-to-pdf' | 'excel-to-pdf' | 'edit';            // Fase 2

type ProcessingMode = 'client' | 'server';
type PlanTier = 'anonymous' | 'free' | 'pro';

// ───────────────────────── Tabel: profiles ─────────────────────────
// 1:1 dengan auth.users; dibuat lewat trigger on_auth_user_created.

interface Profile {
  id: string;                    // UUID, = auth.users.id
  email: string | null;          // null selama masih anonim
  displayName: string | null;
  avatarUrl: string | null;
  plan: PlanTier;
  isAnonymous: boolean;          // dicerminkan dari auth.users.is_anonymous
  localeTag: string;             // default 'id-ID'
  createdAt: string;             // ISO8601
  updatedAt: string;
}

// ───────────────────────── Tabel: documents ─────────────────────────
// HANYA untuk berkas yang memang harus ke server (MVP: AI PDF saja).
// Operasi client-side TIDAK PERNAH membuat baris di sini.

interface Document {
  id: string;
  ownerId: string;                       // FK → profiles.id
  storagePath: string;                   // 'ai-documents/{ownerId}/{id}.pdf'
  fileName: string;                      // nama asli, untuk ditampilkan
  mimeType: string;                      // 'application/pdf'
  sizeBytes: number;
  pageCount: number | null;              // null hingga selesai di-parse
  hasTextLayer: boolean | null;          // false ⇒ hasil pindai ⇒ E_SCANNED_NO_TEXT
  geminiFileUri: string | null;          // URI dari Gemini Files API
  geminiFileExpiresAt: string | null;    // Files API kedaluwarsa ~48 jam; unggah ulang bila lewat
  status: 'uploading' | 'processing' | 'ready' | 'failed' | 'expired';
  errorCode: string | null;
  expiresAt: string;                     // createdAt + 24 jam → dipurge cron
  createdAt: string;
}

// ───────────────────────── Tabel: conversations ─────────────────────────

interface Conversation {
  id: string;
  ownerId: string;
  title: string;                         // dibuat otomatis dari pertanyaan pertama
  documentIds: string[];                 // maks 3 di MVP
  messageCount: number;                  // denormalisasi untuk daftar riwayat
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────── Tabel: messages ─────────────────────────

interface Citation {
  documentId: string;
  pageNumber: number;                    // 1-indexed, sesuai nomor tampilan
  snippet: string;                       // ≤200 char, untuk tooltip chip
}

interface Message {
  id: string;
  conversationId: string;                // FK, ON DELETE CASCADE
  role: 'user' | 'assistant';
  content: string;                       // markdown
  citations: Citation[] | null;          // jsonb; hanya pada role 'assistant'
  modelId: string | null;                // mis. 'gemini-2.5-flash'
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  finishReason: 'stop' | 'length' | 'safety' | 'error' | null;
  createdAt: string;
}

// ───────────────────────── Tabel: jobs (Fase 2) ─────────────────────────
// Konversi Office yang berjalan di worker container.

interface Job {
  id: string;
  ownerId: string;
  tool: ToolSlug;
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  progress: number;                      // 0–100
  inputPaths: string[];                  // path Supabase Storage
  outputPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;                     // hasil dipurge setelah 24 jam
  createdAt: string;
}

// ───────────────────────── Tabel: usage_events ─────────────────────────
// Telemetri saja. Untuk mode 'client', TIDAK ADA isi berkas yang dikirim —
// hanya metadata di bawah ini. Ini kontrak privasi produk.

interface UsageEvent {
  id: string;
  ownerId: string;
  tool: ToolSlug;
  mode: ProcessingMode;
  fileCount: number;
  totalBytes: number;
  pageCount: number | null;
  durationMs: number;
  succeeded: boolean;
  errorCode: string | null;
  createdAt: string;
}

// ───────────────────────── Tabel: ai_quota ─────────────────────────
// Satu baris per pengguna per hari (UTC+7). Ditegakkan server-side.

interface AiQuota {
  ownerId: string;                       // PK bagian 1
  quotaDate: string;                     // PK bagian 2, 'YYYY-MM-DD' Asia/Jakarta
  messagesUsed: number;
  documentsUploaded: number;
  updatedAt: string;
}

// ───────────────────────── State klien (tidak pernah dipersistensi) ─────────────────────────

interface QueuedFile {
  localId: string;                       // nanoid; hidup hanya di memori tab
  file: File;                            // objek File asli — tidak pernah di-upload untuk tool client
  pageCount: number | null;
  pages: PageState[];
  status: 'pending' | 'parsing' | 'ready' | 'error';
  errorCode: string | null;
}

interface PageState {
  index: number;                         // 0-indexed internal
  selected: boolean;
  rotation: 0 | 90 | 180 | 270;
  thumbnailUrl: string | null;           // object URL; wajib di-revoke saat unmount
}
```

**Aturan RLS (wajib pada setiap tabel):**

| Tabel | Kebijakan |
|---|---|
| `profiles` | `SELECT/UPDATE` bila `id = auth.uid()` |
| `documents` | Semua operasi bila `ownerId = auth.uid()` |
| `conversations` | Semua operasi bila `ownerId = auth.uid()` |
| `messages` | Semua operasi bila conversation induknya milik `auth.uid()` |
| `jobs` | `SELECT` bila `ownerId = auth.uid()`; `INSERT/UPDATE` hanya service role |
| `usage_events` | `INSERT` bila `ownerId = auth.uid()`; tanpa `SELECT` untuk klien |
| `ai_quota` | Tanpa akses klien sama sekali — service role saja |

---

## 9. API / Integration Surface

Endpoint di bawah adalah **Next.js Route Handlers** (`app/api/...`). Pembacaan riwayat dilakukan langsung lewat Supabase client SDK yang sudah dijaga RLS — tidak perlu endpoint sendiri.

| Method | Path | Deskripsi | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/documents/upload-url` | Membuat signed upload URL + baris `documents` berstatus `uploading` | Ya (anon ok) | `{ documentId: string, uploadUrl: string, expiresAt: string }` |
| `POST` | `/api/documents/:id/ingest` | Dipanggil setelah unggah selesai: validasi PDF, hitung halaman, deteksi lapisan teks, daftarkan ke Gemini Files API | Ya | `Document` |
| `DELETE` | `/api/documents/:id` | Hapus dari Storage + Gemini + baris DB | Ya | `{ success: boolean }` |
| `POST` | `/api/ai/conversations` | Buat percakapan baru terkait 1–3 dokumen | Ya | `Conversation` |
| `POST` | `/api/ai/conversations/:id/messages` | Kirim pertanyaan; **balasan di-stream via SSE**; menegakkan kuota sebelum memanggil Gemini | Ya | `text/event-stream` → `{delta}` … `{done, messageId, citations, usage}` |
| `DELETE` | `/api/ai/conversations/:id` | Hapus percakapan + pesan (cascade) | Ya | `{ success: boolean }` |
| `GET` | `/api/quota` | Sisa kuota AI hari ini | Ya | `{ messagesRemaining: number, documentsRemaining: number, resetsAt: string }` |
| `POST` | `/api/telemetry` | Catat `UsageEvent` (metadata saja, tanpa isi berkas) | Ya | `202 Accepted` |
| `POST` | `/api/jobs` _(Fase 2)_ | Antre konversi Office | Ya | `Job` |
| `GET` | `/api/jobs/:id` _(Fase 2)_ | Polling status job | Ya | `Job` |

**Kontrak streaming AI (SSE):**
```
event: delta   data: { "text": "..." }
event: cite    data: { "documentId": "...", "pageNumber": 42, "snippet": "..." }
event: done    data: { "messageId": "...", "usage": { "in": 12000, "out": 480 } }
event: error   data: { "code": "E_AI_TIMEOUT", "message": "..." }
```

**Integrasi eksternal:**

| Integrasi | Kegunaan | Library |
|---|---|---|
| **Google Gemini API** | Chat & ringkasan PDF; input PDF native via Files API | `@google/genai` |
| **Supabase** | Auth (anonim + magic link + Google), Postgres, Storage, cron purge | `@supabase/supabase-js`, `@supabase/ssr` |
| **pdf-lib** | Merge, split, rotasi, JPG→PDF, penulisan ulang saat kompresi | `pdf-lib` (client, di Worker) |
| **pdfjs-dist** | Render thumbnail, viewer, PDF→JPG, deteksi lapisan teks | `pdfjs-dist` (client, di Worker) |
| **Vercel Analytics / Umami** | Metrik produk (tanpa PII) | — |
| **LibreOffice headless / ConvertAPI** _(Fase 2)_ | Konversi Office | Diputuskan di Fase 2 (lihat R1) |

**Konfigurasi Gemini (MVP):**
- Model default `gemini-3.7-flash`, dapat diubah lewat `GEMINI_MODEL_FAST`. _Catatan implementasi: `gemini-2.5-flash` yang semula direncanakan ternyata sudah dipensiunkan Google ("no longer available to new users"), jadi ID model dibuat dapat dikonfigurasi dan `doctor:ai` memanggilnya secara nyata agar pemensiunan berikutnya ketahuan lebih awal._
- Eskalasi ke model Pro untuk dokumen panjang belum diaktifkan: model Pro mengembalikan 429 pada kunci API gratis, sehingga memerlukan kunci berbayar.
- Dokumen dikirim sebagai referensi Files API (bukan base64 inline) agar hemat token pada percakapan berlanjut.
- System instruction: menjawab dalam bahasa Indonesia, **selalu** menyertakan nomor halaman rujukan, dan menyatakan "tidak ditemukan dalam dokumen" alih-alih mengarang.
- Structured output untuk memisahkan `answer` dan `citations[]`.
- Batas keluaran 2.048 token; `temperature` 0,2 (tugas faktual).

---

## 10. State Management Map

| State | Lokasi | Persistensi | Alasan |
|---|---|---|---|
| `queuedFiles` (objek `File`, thumbnail) | Memori klien (Zustand) | Tidak ada — hilang saat refresh | **Inti kontrak privasi.** Berkas tool client-side tidak boleh pernah menyentuh jaringan atau disk |
| Seleksi halaman, urutan, rotasi | Memori klien (Zustand) | Tidak ada | Turunan dari `queuedFiles`; tidak bermakna tanpa berkasnya |
| Riwayat undo/redo (20 langkah) | Memori klien | Tidak ada | Cakupan sesi |
| Tool aktif | **URL** (`/merge`, `/split`) | — | Dapat di-bookmark, dibagikan, dan di-index mesin pencari |
| Opsi tool (level kompresi, dll.) | URL query param | Sesi | Memungkinkan "bagikan setelan ini"; aman karena tidak memuat data berkas |
| Sesi auth | Cookie Supabase via `@supabase/ssr` | Persisten | Wajib agar SSR & Route Handler mengenali pengguna |
| Profil pengguna | Server (Postgres) + cache React Query | Persisten | Sumber kebenaran ada di server |
| Percakapan & pesan AI | Server (Postgres) | Persisten (akun terdaftar) / sesi (anonim) | Lintas perangkat untuk pengguna terdaftar |
| Pesan yang sedang di-stream | Memori klien | Tidak ada hingga `done` | Disisipkan optimistis, dirujukkan ke server saat selesai |
| Kuota AI | Server (`ai_quota`) + cache klien 60 detik | Persisten | **Wajib ditegakkan server-side** — nilai di klien hanya untuk tampilan |
| Preferensi tema/bahasa | `localStorage` | Persisten | Milik perangkat, tidak perlu ke server |
| Status penerimaan consent | `localStorage` + cookie | Persisten | Kebutuhan kepatuhan |
| Progress operasi | Worker → main thread via `postMessage` | Tidak ada | Efemeral menurut definisi |

---

## 11. Tech Stack Recommendation

| Lapisan | Pilihan | Alasan |
|---|---|---|
| **Framework** | Next.js 15 (App Router) + TypeScript strict | Sudah ditetapkan. RSC menekan JS beranda; Route Handler memberi tempat aman untuk kunci Gemini |
| **Styling** | Tailwind CSS v4 | Sudah ditetapkan. Token design system didefinisikan sebagai CSS custom properties di `@theme`, bukan disebar sebagai kelas arbitrer |
| **Komponen** | shadcn/ui (di-restyle berat) + Radix primitives | Radix memberi aksesibilitas dialog/checkbox/tooltip secara gratis — kritis untuk target AA. **Wajib** di-restyle ke token Mastercard (default shadcn radius 8px melanggar skala radius kita) |
| **State** | Zustand (antrean berkas) + TanStack Query (data server) | Zustand ringan dan cocok untuk objek non-serializable seperti `File`. Query menangani cache/retry sisi server |
| **PDF (klien)** | `pdf-lib` + `pdfjs-dist`, keduanya di Web Worker | Standar de-facto, matang, jalan penuh di browser. Worker mencegah UI beku |
| **Worker bridge** | Comlink | Menghilangkan boilerplate `postMessage` yang rawan salah |
| **Backend / BaaS** | Supabase (Postgres + Auth + Storage + Cron) | Sudah ditetapkan. `signInAnonymously` sangat pas dengan strategi anonim-dulu; RLS jadi satu model izin untuk anonim & terdaftar |
| **AI** | Google Gemini via `@google/genai` | Sudah ditetapkan. Pemahaman PDF native menghapus kebutuhan pipeline OCR/chunking di MVP |
| **Virtualisasi** | TanStack Virtual | Grid 500 thumbnail wajib divirtualisasi |
| **Validasi** | Zod | Satu skema dipakai bersama batas API dan form |
| **Testing** | Vitest (unit) · Playwright (E2E) · axe-core (a11y di CI) | Operasi PDF butuh uji fixture nyata; gerbang a11y otomatis melindungi komitmen AA |
| **Hosting** | Vercel (web) · Supabase (data) · Cloud Run _(Fase 2, worker konversi)_ | Vercel serverless **tidak bisa** menjalankan LibreOffice — karena itu Fase 2 butuh container terpisah |
| **Font** | Sofia Sans via `next/font/google` | Substitusi open-source terdekat untuk MarkForMC; self-host menghapus request pihak ketiga |

---

## 12. Suggested File Structure

```
nusapdf/
├── app/
│   ├── layout.tsx                      # AppShell, font, provider
│   ├── page.tsx                        # Beranda — konstelasi tool (RSC)
│   ├── (tools)/
│   │   ├── layout.tsx                  # Kerangka 3 tahap bersama
│   │   ├── merge/page.tsx
│   │   ├── split/page.tsx
│   │   ├── compress/page.tsx
│   │   ├── pdf-to-jpg/page.tsx
│   │   └── jpg-to-pdf/page.tsx
│   ├── ai-pdf/
│   │   ├── page.tsx                    # Unggah + mulai percakapan
│   │   └── [conversationId]/page.tsx   # Ruang kerja split-view
│   ├── riwayat/page.tsx
│   ├── masuk/page.tsx
│   └── api/
│       ├── documents/
│       │   ├── upload-url/route.ts
│       │   └── [id]/{ingest,route}.ts
│       ├── ai/conversations/
│       │   ├── route.ts
│       │   └── [id]/messages/route.ts  # SSE streaming
│       ├── quota/route.ts
│       └── telemetry/route.ts
├── components/
│   ├── shell/                          # NavPill, Footer, AppShell
│   ├── home/                           # ToolConstellation, ToolPortraitCard, OrbitalArc
│   ├── tools/                          # Dropzone, FileQueueList, PagePreviewGrid,
│   │                                   # ToolOptionsPanel, ProgressPanel, ResultCard
│   ├── ai/                             # AiWorkspaceLayout, PdfViewer, ChatThread,
│   │                                   # ChatComposer, CitationChip, QuotaMeter
│   └── ui/                             # Primitive shadcn ter-restyle
├── lib/
│   ├── pdf/
│   │   ├── worker.ts                   # Entry Worker (Comlink expose)
│   │   ├── merge.ts  split.ts  compress.ts
│   │   ├── to-image.ts  from-image.ts
│   │   ├── render.ts                   # Thumbnail & viewer via pdfjs
│   │   └── inspect.ts                  # Jumlah halaman, enkripsi, lapisan teks
│   ├── ai/
│   │   ├── gemini.ts                   # Klien + system instruction
│   │   ├── citations.ts                # Parsing structured output → Citation[]
│   │   └── quota.ts                    # Penegakan server-side
│   ├── supabase/
│   │   ├── client.ts  server.ts  middleware.ts
│   │   └── database.types.ts           # Hasil generate CLI
│   ├── store/                          # Slice Zustand
│   ├── telemetry.ts
│   └── types.ts
├── supabase/
│   ├── migrations/                     # Skema + kebijakan RLS
│   └── functions/purge-expired/        # Cron harian: dokumen & job kedaluwarsa
├── e2e/                                # Spesifikasi Playwright + PDF fixture
├── tailwind.config.ts                  # Token design system Mastercard
└── ...
```

---

## 13. Acceptance Criteria

### US1 — Memakai perkakas tanpa mendaftar
- [ ] Mendarat di `/merge` dan menjatuhkan 2 PDF valid menampilkan keduanya di antrean tanpa dialog auth apa pun
- [ ] Sesi anonim Supabase terbuat otomatis di kunjungan pertama; `auth.uid()` tersedia di semua request
- [ ] Tidak ada modal berbayar, hitungan mundur, atau batas operasi yang muncul untuk tool client-side
- [ ] Tab DevTools → Network menunjukkan **nol request** yang memuat isi berkas selama operasi merge
- [ ] Edge case: menjatuhkan 1 file saja → tombol proses nonaktif dengan petunjuk "Butuh minimal 2 berkas"
- [ ] Error state: menjatuhkan `.docx` menampilkan `E_UNSUPPORTED_TYPE` beserta tautan ke tool yang tepat

### US2 — Menata ulang sebelum menggabungkan
- [ ] Menyeret baris file mengubah urutannya, dan urutan itulah yang dipakai pada berkas hasil
- [ ] `Alt+↑` / `Alt+↓` memindahkan baris yang sedang fokus, dengan hasil identik dengan drag
- [ ] Perubahan urutan diumumkan via `aria-live` ("Laporan.pdf dipindah ke posisi 2 dari 4")
- [ ] `Ctrl/Cmd+Z` mengembalikan perubahan urutan terakhir; berlaku hingga 20 langkah
- [ ] PDF hasil memuat total halaman = jumlah halaman seluruh input, dalam urutan yang ditampilkan
- [ ] Edge case: 20 file × 100 halaman selesai tanpa main thread terblokir >50ms (diverifikasi trace Performance)

### US3 — Pratinjau & pilih halaman
- [ ] Setiap halaman ter-render sebagai thumbnail; halaman terlihat pertama muncul ≤3 detik untuk dokumen 50 halaman
- [ ] Grid divirtualisasi: dokumen 500 halaman tidak melampaui 400 MB memori tab
- [ ] Klik thumbnail mengalihkan seleksi; `Space` melakukan hal sama pada halaman yang fokus
- [ ] Thumbnail mengekspos `role="checkbox"`, `aria-checked`, dan label "Halaman N dari M"
- [ ] Split dengan 3 halaman terpilih menghasilkan berkas berisi persis 3 halaman itu, urutan terjaga
- [ ] Object URL thumbnail di-revoke saat unmount (tidak ada kebocoran memori setelah 10 kali ganti tool)

### US4 — Kompres dengan kendali
- [ ] Tiga level (Ringan / Seimbang / Maksimal) tersedia dan salah satunya terpilih default
- [ ] Setelah proses, kartu hasil menampilkan ukuran sebelum, sesudah, dan persentase pengurangan
- [ ] Level Seimbang mencapai pengurangan ≥30% pada PDF fixture berbasis gambar
- [ ] Bila hasil **lebih besar** dari input, aplikasi mengembalikan berkas asli dan memberi tahu alasannya
- [ ] Teks tetap dapat diseleksi pada berkas hasil (kompresi tidak me-raster halaman teks)

### US5 — Kepercayaan privasi
- [ ] Badge "Diproses di perangkat Anda" tampil pada kelima tool client-side
- [ ] Badge **tidak** tampil di AI PDF; sebagai gantinya muncul pemberitahuan unggah eksplisit sebelum berkas dikirim
- [ ] Tooltip badge menjelaskan mekanismenya dalam bahasa awam
- [ ] Uji E2E menegaskan tidak ada request keluar berisi byte berkas untuk kelima tool tersebut

### US6 — Bertanya ke dokumen
- [ ] Mengunggah PDF ≤50 MB menghasilkan `Document` berstatus `ready` dalam ≤15 detik
- [ ] Mengirim pertanyaan mengembalikan token pertama dalam ≤3 detik (p75)
- [ ] Balasan ter-stream progresif, bukan muncul sekaligus
- [ ] Jawaban dalam bahasa Indonesia terlepas dari bahasa dokumen
- [ ] Bila jawaban tidak ada di dokumen, asisten menyatakannya, bukan mengarang
- [ ] Edge case: PDF hasil pindai tanpa lapisan teks ditolak dengan `E_SCANNED_NO_TEXT` **sebelum** kuota terpakai
- [ ] Error state: kegagalan Gemini menampilkan `E_AI_TIMEOUT` dengan tombol ulangi; kuota tidak dipotong

### US7 — Verifikasi lewat sitasi
- [ ] Jawaban yang merujuk isi dokumen menyertakan ≥1 `CitationChip`
- [ ] Klik chip `hal. 42` menggulirkan viewer ke halaman 42 dan menyorotnya ≥1,5 detik
- [ ] Nomor halaman pada sitasi cocok dengan nomor halaman yang ditampilkan viewer (1-indexed)
- [ ] Chip dapat dijangkau keyboard dan mengumumkan tujuannya ke pembaca layar

### US8 — Upgrade akun & riwayat
- [ ] Pengguna anonim yang mendaftar mempertahankan `auth.uid()` yang sama via `linkIdentity()`
- [ ] Percakapan yang dibuat saat anonim tetap ada dan terlihat setelah upgrade
- [ ] `/riwayat` hanya menampilkan percakapan milik pengguna tersebut (diverifikasi uji RLS)
- [ ] Menghapus percakapan menghapus pesan-pesannya secara cascade
- [ ] Kuota AI naik dari tingkat anonim ke tingkat terdaftar segera setelah upgrade

### US9 — Alur penuh via keyboard
- [ ] Seluruh alur merge (buka berkas → tata ulang → proses → unduh) dapat diselesaikan tanpa mouse
- [ ] Indikator fokus terlihat pada setiap elemen interaktif, kontras ≥3:1
- [ ] Tidak ada jebakan fokus; `Esc` menutup semua modal dan mengembalikan fokus ke pemicunya
- [ ] axe-core melaporkan nol pelanggaran serius/kritis pada seluruh rute di CI
- [ ] `prefers-reduced-motion: reduce` menonaktifkan animasi orbital dan transisi kartu

### US10 — Galat yang dapat ditindaklanjuti
- [ ] Setiap kode galat pada matriks §6 punya salinan pesan khusus — tidak ada "Terjadi kesalahan" generik
- [ ] PDF terenkripsi terdeteksi saat parsing dan memunculkan `E_ENCRYPTED`, bukan crash
- [ ] Kegagalan sebagian batch tetap menghasilkan output untuk berkas yang berhasil
- [ ] Semua galat tercatat sebagai `UsageEvent` dengan `succeeded: false` dan `errorCode` terisi
- [ ] Tombol batal menghentikan Worker dalam ≤1 detik dan mengembalikan UI ke state konfigurasi

---

## 14. Open Questions & Risks

| # | Isu | Detail & mitigasi |
|---|---|---|
| **R1** | **Klaim "akurasi hampir 100%" untuk PDF→Word** | Akurasi setinggi itu praktis hanya dicapai engine komersial (Adobe PDF Services, ConvertAPI), bukan LibreOffice headless. **Mitigasi:** jangan pasang klaim itu di materi pemasaran sampai terukur. Di Fase 2, mulai dengan ConvertAPI untuk memvalidasi permintaan, ukur akurasi pada 20 dokumen sampel, baru putuskan self-host vs beli. — *Owner: PM + Eng* |
| **R2** | **Kualitas kompresi client-side** | `pdf-lib` tidak punya kompresi setara Ghostscript. Yang realistis: re-encode gambar tertanam via canvas, buang metadata, dan aktifkan object stream. PDF teks-berat mungkin hanya turun 5–15%. **Mitigasi:** kalibrasi ulang ekspektasi di UI (tampilkan hasil nyata, jangan janjikan persentase); siapkan fallback server opsional bila hasil <10%. — *Owner: Eng* |
| **R3** | **Kedaluwarsa Gemini Files API (~48 jam)** | `geminiFileUri` mati sebelum percakapan lama dibuka kembali. **Mitigasi:** simpan berkas asli di Supabase Storage selama masa hidup dokumen; deteksi URI kedaluwarsa dan unggah ulang transparan. Sudah dimodelkan lewat `geminiFileExpiresAt`. — *Owner: Eng* |
| **R4** | **PDF hasil pindai tidak terbaca AI** | Sebagian besar dokumen pemerintah/notaris di Indonesia adalah hasil pindai. Tanpa OCR, AI PDF gagal tepat pada kasus yang paling bernilai. **Mitigasi:** deteksi dini via `hasTextLayer` dan sampaikan jujur; jadikan OCR kandidat utama Fase 2 (Gemini punya kemampuan vision — evaluasi ini sebelum menambah dependensi Tesseract). — *Owner: PM + Eng* |
| **R5** | **Biaya token Gemini tak terduga** | Dokumen 500 halaman ≈ ratusan ribu token per giliran bila konteks dikirim ulang. **Mitigasi:** pakai referensi Files API (bukan inline), batasi 3 dokumen/percakapan, tegakkan kuota harian server-side, pantau `tokensIn/tokensOut` pada tiap `Message` sejak hari pertama. Tetapkan anggaran bulanan + alert. — *Owner: PM* |
| **R6** | **Batas memori browser** | Merge 20×100 halaman bisa memicu OOM pada perangkat kelas bawah, terutama Safari iOS. **Mitigasi:** proses streaming per berkas, bukan memuat semua sekaligus; tetapkan ambang peringatan; tangani `E_OOM` dengan saran konkret. Uji pada perangkat Android 4 GB. — *Owner: Eng* |
| **Q1** | **Model monetisasi belum ditentukan** | PRD ini mengasumsikan MVP gratis penuh. Tingkat `pro` sudah ada di model data tapi tidak ada billing. Perlu keputusan sebelum Fase 3. — *Owner: PM* |
| **Q2** | **Nama & domain** | "NusaPDF" perlu pengecekan ketersediaan merek dan domain. — *Owner: PM* |
| **Q3** | **Kuota anonim vs terdaftar** | Usulan: anonim 5 pesan + 2 dokumen/hari; terdaftar 30 pesan + 10 dokumen/hari. Angka ini tebakan awal — kalibrasi setelah melihat data 2 minggu pertama. — *Owner: PM* |
| **Q4** | **Kebijakan privasi & UU PDP** | Butuh telaah hukum atas retensi 24 jam, pemrosesan oleh Google sebagai sub-prosesor, dan pengungkapan lintas negara. — *Owner: PM + Legal* |
| **T1** | **Tradeoff: hybrid, bukan seragam** | Dua jalur eksekusi (browser & server) menambah kompleksitas dibanding "semua di server". Ditukar demi privasi dan biaya compute mendekati nol untuk 5 dari 6 tool MVP — itu justru diferensiasi produknya, jadi kompleksitas ini disengaja. |
| **T2** | **Tradeoff: konversi Office ditunda** | Menunda 6 dari 13 tool berarti rilis pertama tampak kurang lengkap dibanding kompetitor. Ditukar demi rilis yang lebih cepat dan tidak tersandera bagian tersulit. Beranda tetap menampilkan seluruh 13 tool dengan penanda "Segera hadir" agar niat produk terbaca. |

---

## 15. Rollout & Next Steps

### MVP (Rilis 1) — target 6–8 minggu

**Termasuk:** Merge · Split · Compress · PDF to JPG · JPG to PDF · AI PDF · auth anonim + upgrade · riwayat percakapan · beranda konstelasi 13 tool (7 bertanda "Segera hadir")

**Tidak termasuk:** konversi Office, Edit PDF, OCR, billing, bahasa selain Indonesia

**Definition of done:** kelima tool client-side lulus seluruh acceptance criteria pada Chrome/Safari/Firefox; axe-core bersih di CI; AI PDF menjawab dengan sitasi akurat pada 10 dokumen sampel; nol byte berkas terkirim untuk tool client-side (diverifikasi E2E).

### Fase 2 — konversi (setelah data MVP masuk)
Word/PowerPoint/Excel ↔ PDF via worker container · Edit PDF · OCR untuk PDF pindai · evaluasi ulang R1 & R4 dengan data nyata

### Fase 3 — pendalaman
Billing & tingkat Pro · pemrosesan batch · riwayat lintas perangkat untuk tool non-AI · PWA installable · i18n (Inggris, Jawa)

### Sign-off
- [ ] PM
- [ ] Engineering lead
- [ ] Design
- [ ] Legal (R4, Q4 — kepatuhan UU PDP)

### Next steps

| # | Aksi | Owner | Target |
|---|---|---|---|
| 1 | Validasi R2 — prototipe kompresi client-side pada 10 PDF nyata, ukur pengurangan sebenarnya | Eng | Minggu 1 |
| 2 | Spike AI PDF — buktikan Gemini Files API + sitasi halaman berfungsi ujung ke ujung | Eng | Minggu 1 |
| 3 | Tetapkan token design system di `tailwind.config.ts`, restyle primitive shadcn | Design + Eng | Minggu 1–2 |
| 4 | Skema Supabase + kebijakan RLS + uji RLS | Eng | Minggu 2 |
| 5 | Desain hi-fi beranda + satu halaman tool + ruang kerja AI | Design | Minggu 2–3 |
| 6 | Telaah hukum kebijakan privasi (Q4) | PM + Legal | Minggu 3 |
| 7 | Kalibrasi angka kuota (Q3) setelah spike biaya | PM | Minggu 3 |

---

*Dokumen ini ditulis untuk dua pembaca sekaligus: tim lintas fungsi dan perkakas AI prototyping. Bagian 7–13 sengaja dibuat cukup presisi untuk dipakai langsung sebagai build brief.*
