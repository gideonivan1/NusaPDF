import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout, ContentPage } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Pusat bantuan',
  description:
    'Panduan singkat tiap alat NusaPDF dan cara mengatasi kendala yang paling sering muncul.',
};

export default function BantuanPage() {
  return (
    <ContentPage
      eyebrow="Bantuan"
      title="Pusat bantuan"
      lead="Panduan singkat untuk setiap alat, dan penjelasan kendala yang paling sering ditemui beserta cara mengatasinya."
      updated="22 Agustus 2026"
    >
      <h2>Panduan tiap alat</h2>

      <h3>Merge PDF — menggabungkan beberapa berkas</h3>
      <ol>
        <li>Jatuhkan dua berkas PDF atau lebih ke area unggah.</li>
        <li>
          Atur urutannya dengan menyeret baris, atau tekan{' '}
          <code>Alt</code> + <code>↑</code>/<code>↓</code> saat baris difokuskan.
        </li>
        <li>
          Bila hanya sebagian halaman yang Anda butuhkan, klik <em>Pilih halaman</em> pada
          berkas terkait lalu hilangkan centang halaman yang tidak diperlukan.
        </li>
        <li>Tekan Gabungkan, lalu unduh hasilnya.</li>
      </ol>
      <p>
        Urutan berkas hasil selalu mengikuti urutan yang Anda lihat di layar, dari atas ke
        bawah.
      </p>

      <h3>Split PDF — memisahkan halaman</h3>
      <p>Tersedia empat cara memisahkan:</p>
      <ul>
        <li>
          <strong>Tiap halaman terpilih jadi berkas sendiri</strong> — pilih halaman di
          pratinjau, masing-masing menjadi satu PDF.
        </li>
        <li>
          <strong>Gabungkan halaman terpilih jadi satu berkas</strong> — untuk mengambil
          bagian tertentu saja.
        </li>
        <li>
          <strong>Pecah seluruh halaman</strong> — setiap halaman menjadi berkas terpisah.
        </li>
        <li>
          <strong>Berdasarkan rentang</strong> — tulis <code>1-3, 7, 10-12</code>. Tiap
          segmen yang dipisahkan koma menjadi satu berkas.
        </li>
      </ul>
      <p>Bila hasilnya lebih dari satu berkas, semuanya diunduh sebagai satu arsip ZIP.</p>

      <h3>Compress PDF — memperkecil ukuran</h3>
      <p>
        Pilih salah satu dari tiga tingkat. Setelah selesai, kartu hasil menampilkan ukuran
        sebelum dan sesudah beserta persentase pengurangannya.
      </p>
      <p>
        Perlu diketahui: kami mengompres ulang <em>gambar</em> di dalam PDF dan membiarkan
        teksnya utuh, sehingga hasilnya tetap dapat diseleksi dan dicari. Konsekuensinya,
        dokumen yang isinya hampir seluruhnya teks hanya menyusut sedikit — itu wajar, dan
        bukan tanda alatnya gagal.
      </p>

      <h3>PDF to JPG — mengubah halaman jadi gambar</h3>
      <p>
        Pilih halaman yang diinginkan, tentukan resolusi (Layar 72 dpi, Standar 144 dpi,
        atau Cetak 288 dpi), lalu pilih format JPG atau PNG. PNG lebih tajam untuk halaman
        berisi teks dan garis, tetapi ukurannya jauh lebih besar.
      </p>

      <h3>JPG to PDF — mengubah gambar jadi PDF</h3>
      <p>
        Urutan gambar menentukan urutan halaman, dan bisa Anda tata ulang seperti pada
        Merge. Ukuran halaman dapat mengikuti gambar aslinya, atau dipaksa ke A4/Letter
        dengan orientasi dan margin pilihan Anda.
      </p>

      <h3>PDF ke Word, PowerPoint, dan Excel</h3>
      <p>
        Pilih halaman yang ingin dikonversi di pratinjau, lalu tekan tombolnya. Ketiganya
        bekerja dengan cara yang berbeda, dan itu memengaruhi hasil yang Anda dapat:
      </p>
      <ul>
        <li>
          <strong>PDF to Word</strong> mengambil teks tiap halaman dan menyusunnya kembali
          menjadi paragraf yang bisa langsung diedit. Tata letak asli — kolom, kotak teks,
          posisi gambar — tidak direkonstruksi.
        </li>
        <li>
          <strong>PDF to PowerPoint</strong> menjadikan setiap halaman satu slide berisi
          gambar halaman itu. Tampilannya terjaga persis, tetapi teksnya tidak bisa diklik
          atau diedit.
        </li>
        <li>
          <strong>PDF to Excel</strong> menganalisis posisi teks untuk menebak batas kolom,
          lalu menuangkannya ke satu lembar per halaman. Paling akurat pada tabel yang
          kolomnya rapi sejajar; halaman berisi paragraf biasa akan jatuh menjadi satu
          kolom.
        </li>
      </ul>

      <h3>Word, PowerPoint, dan Excel ke PDF</h3>
      <p>
        Jatuhkan satu berkas .docx, .pptx, atau .xlsx — beberapa sekaligus juga bisa. Isinya
        dibaca lalu ditata ulang ke halaman PDF: dokumen Word menjadi A4 tegak, spreadsheet
        menjadi lanskap dengan lebar kolom mengikuti isinya, dan presentasi menjadi satu
        halaman per slide mengikuti rasio deck aslinya.
      </p>
      <p>
        Hasilnya <em>ditata ulang</em>, bukan disalin persis. Jenis huruf, warna, gambar,
        grafik, dan header/footer asli tidak ikut terbawa. Bila Anda memerlukan kemiripan
        piksel, gunakan fitur “Save as PDF” di aplikasi Office Anda — itu punya akses ke
        mesin tata letak aslinya, yang tidak dimiliki peramban.
      </p>
      <p>
        Format lama .doc, .ppt, dan .xls belum didukung karena wadah berkasnya berbeda sama
        sekali. Simpan ulang ke .docx/.pptx/.xlsx lebih dulu.
      </p>

      <h3>AI PDF — bertanya pada dokumen</h3>
      <p>
        Unggah satu PDF, lalu ajukan pertanyaan dalam bahasa Indonesia. Setiap jawaban
        menyertakan penanda halaman seperti <code>hal. 12</code> yang bisa diklik untuk
        melompat ke halaman itu di penampil sebelah kiri — supaya Anda dapat memeriksa
        sendiri kebenarannya.
      </p>

      <Callout title="AI PDF adalah satu-satunya alat yang mengunggah berkas">
        <p>
          Sebelas alat lainnya berjalan sepenuhnya di peramban Anda — termasuk konversi
          Office. Penjelasan lengkapnya ada di{' '}
          <Link href="/privasi">Cara kerja privasi kami</Link>.
        </p>
      </Callout>

      <h2>Mengatasi kendala</h2>

      <h3>“PDF ini terkunci password”</h3>
      <p>
        Dokumen Anda diproteksi kata sandi, dan NusaPDF tidak membuka proteksi tersebut.
        Buka dulu proteksinya di aplikasi pembaca PDF Anda, simpan salinan tanpa proteksi,
        lalu ulangi.
      </p>

      <h3>“Berkas ini tampaknya rusak atau bukan PDF yang valid”</h3>
      <p>
        Coba buka berkas itu di pembaca PDF lain untuk memastikan. Berkas yang gagal terunduh
        sebagian adalah penyebab tersering.
      </p>

      <h3>“Berkas melebihi batas 100 MB”</h3>
      <p>
        Batas ini ada karena seluruh proses berjalan di memori peramban Anda. Kecilkan dulu
        lewat <Link href="/compress">Compress PDF</Link>, lalu ulangi.
      </p>

      <h3>“Dokumen terlalu berat untuk peramban ini”</h3>
      <p>
        Memori tab peramban habis. Coba proses lebih sedikit halaman atau lebih sedikit
        berkas sekaligus. Pada perangkat dengan RAM terbatas, memecah pekerjaan menjadi dua
        tahap biasanya berhasil.
      </p>

      <h3>“Dokumen ini tampak hasil pindai tanpa lapisan teks”</h3>
      <p>
        Dokumen hasil pindai adalah kumpulan gambar, bukan teks — sehingga asisten AI belum
        dapat membacanya. Dukungan OCR sedang kami siapkan. Sementara ini, gunakan PDF yang
        teksnya dapat diseleksi. Alat lain seperti Merge, Split, dan Compress tetap bekerja
        normal pada dokumen pindai.
      </p>

      <h3>“Kuota AI harian Anda sudah habis”</h3>
      <p>
        Kuota berlaku hanya untuk AI PDF, karena alat itulah satu-satunya yang memakai
        server kami. Masuk untuk mendapat kuota lebih besar, atau tunggu hingga tengah
        malam WIB. Sebelas alat lainnya tetap tanpa batas.
      </p>

      <h3>Hasil kompresi hampir tidak berubah</h3>
      <p>
        Berarti dokumen Anda didominasi teks, bukan gambar. Teks pada PDF sudah tersimpan
        sangat efisien, jadi tidak banyak yang bisa dipangkas tanpa mengubahnya menjadi
        gambar — yang justru akan membuat teks tidak lagi dapat diseleksi.
      </p>

      <h2>Peramban yang didukung</h2>
      <p>
        Chrome dan Edge 111+, Firefox 115+, serta Safari 16.4+. Versi yang lebih lama tidak
        mendukung sebagian kemampuan peramban yang dipakai untuk memproses PDF secara lokal.
      </p>

      <h2>Masih ada kendala?</h2>
      <p>
        Periksa dulu <Link href="/faq">pertanyaan umum</Link>. Bila masalah Anda belum
        terjawab, kirimkan keterangan berikut agar kami dapat menelusurinya: nama alat,
        peramban dan versinya, perkiraan ukuran serta jumlah halaman dokumen, dan pesan
        galat yang muncul. Mohon <strong>jangan</strong> melampirkan dokumen aslinya bila
        berisi data pribadi — kami hampir selalu bisa menelusuri masalah tanpa itu.
      </p>
    </ContentPage>
  );
}
