import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentPage } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Pertanyaan umum',
  description:
    'Jawaban atas pertanyaan yang paling sering diajukan tentang NusaPDF: privasi, batasan, biaya, dan kemampuan alatnya.',
};

export default function FaqPage() {
  return (
    <ContentPage
      eyebrow="Bantuan"
      title="Pertanyaan umum"
      lead="Jawaban ringkas atas hal-hal yang paling sering ditanyakan."
      updated="22 Agustus 2026"
    >
      <h2>Privasi</h2>

      <h3>Apakah berkas saya diunggah ke server?</h3>
      <p>
        Untuk sebelas dari dua belas alat — termasuk seluruh konversi ke dan dari Word,
        PowerPoint, serta Excel — <strong>tidak</strong>. Semuanya diproses di dalam
        peramban Anda. Hanya AI PDF yang mengunggah, karena asisten harus membaca
        dokumennya, dan kami menyatakan itu sebelum Anda mengunggah.
      </p>

      <h3>Bagaimana saya bisa memastikannya?</h3>
      <p>
        Buka DevTools → tab Network, lalu jalankan salah satu alat lokal. Tidak akan ada
        permintaan jaringan yang membawa isi berkas. Penjelasan lengkapnya ada di{' '}
        <Link href="/privasi">Cara kerja privasi kami</Link>.
      </p>

      <h3>Berapa lama dokumen AI PDF disimpan?</h3>
      <p>
        Paling lama 24 jam, lalu dihapus otomatis. Anda juga bisa menghapusnya sendiri kapan
        saja.
      </p>

      <h2>Biaya dan batasan</h2>

      <h3>Apakah NusaPDF gratis?</h3>
      <p>
        Ya. Sebelas alat yang berjalan di peramban gratis tanpa batas dan tanpa akun,
        karena alat-alat itu tidak memakai server kami sama sekali. AI PDF memiliki kuota
        harian karena memakai layanan berbayar di belakangnya.
      </p>

      <h3>Berapa batas ukuran dan jumlah berkas?</h3>
      <ul>
        <li>Alat lokal: maksimal 100 MB per berkas dan 20 berkas sekaligus.</li>
        <li>AI PDF: maksimal 50 MB dan 500 halaman per dokumen.</li>
      </ul>
      <p>
        Batas pada alat lokal ditentukan oleh memori peramban Anda, bukan oleh kebijakan
        kami.
      </p>

      <h3>Apakah saya perlu membuat akun?</h3>
      <p>
        Tidak untuk alat lokal. Untuk AI PDF, sesi anonim dibuat otomatis sehingga Anda bisa
        langsung mencoba; mendaftar hanya diperlukan bila Anda ingin kuota lebih besar dan
        riwayat percakapan yang tersimpan lintas perangkat.
      </p>

      <h2>Kemampuan alat</h2>

      <h3>Mengapa hasil kompresi saya hanya berkurang sedikit?</h3>
      <p>
        Karena dokumen Anda kemungkinan besar didominasi teks. Kami memperkecil gambar di
        dalam PDF dan sengaja tidak mengubah halaman menjadi gambar — supaya teksnya tetap
        dapat diseleksi dan dicari. Dokumen berisi banyak foto atau hasil pindai akan
        menyusut jauh lebih banyak.
      </p>

      <h3>Mengapa AI tidak bisa membaca PDF hasil pindai saya?</h3>
      <p>
        PDF hasil pindai hanya berisi gambar halaman, tanpa lapisan teks yang dapat dibaca
        mesin. Dukungan OCR sedang kami siapkan. Alat lain tetap berfungsi normal pada
        dokumen semacam itu.
      </p>

      <h3>Seberapa mirip hasil konversi Office dengan aslinya?</h3>
      <p>
        Yang berpindah adalah <strong>isinya</strong>, bukan tata letaknya. Teks, daftar,
        dan tabel terbawa; jenis huruf, posisi gambar, header/footer, dan penomoran halaman
        asli tidak direkonstruksi. Kami memilih ini secara sadar: mengejar kemiripan
        piksel berarti mengirim dokumen Anda ke server, dan itu membatalkan alasan utama
        NusaPDF ada.
      </p>
      <p>
        Pengecualiannya adalah PDF to PowerPoint — setiap halaman menjadi gambar slide,
        sehingga tampilannya justru terjaga sempurna, tetapi teksnya tidak bisa diedit.
      </p>

      <h3>Mengapa berkas .doc, .ppt, dan .xls lama ditolak?</h3>
      <p>
        Format lama itu adalah wadah biner yang berbeda sama sekali dari .docx/.pptx/.xlsx
        (yang sebenarnya berupa arsip XML). Buka berkasnya di aplikasi Office Anda lalu
        simpan ulang ke format baru, dan NusaPDF akan menerimanya.
      </p>

      <h3>Apakah bisa membuka PDF yang diproteksi kata sandi?</h3>
      <p>
        Belum. Buka proteksinya lebih dulu di aplikasi pembaca PDF Anda, lalu proses
        salinannya di NusaPDF.
      </p>

      <h3>Apakah bisa dipakai tanpa koneksi internet?</h3>
      <p>
        Setelah halaman termuat, alat lokal tetap berfungsi meski koneksi terputus. AI PDF
        memerlukan koneksi.
      </p>

      <h2>Teknis</h2>

      <h3>Peramban apa yang didukung?</h3>
      <p>Chrome dan Edge 111+, Firefox 115+, Safari 16.4+.</p>

      <h3>Apakah ada aplikasi seluler?</h3>
      <p>
        Belum. Situsnya responsif dan dapat dipakai dari peramban ponsel, meski dokumen
        besar akan lebih lancar diproses di komputer.
      </p>

      <h3>Apakah tersedia bahasa lain?</h3>
      <p>
        Antarmuka saat ini hanya bahasa Indonesia. AI PDF tetap menjawab dalam bahasa
        Indonesia meskipun dokumennya berbahasa asing.
      </p>

      <h3>Belum terjawab?</h3>
      <p>
        Lihat <Link href="/bantuan">Pusat bantuan</Link> untuk panduan tiap alat dan
        penanganan galat yang lebih rinci.
      </p>
    </ContentPage>
  );
}
