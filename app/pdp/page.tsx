import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout, ContentPage, DraftNotice } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Kepatuhan UU PDP',
  description:
    'Bagaimana NusaPDF memetakan dirinya terhadap UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi.',
};

export default function PdpPage() {
  return (
    <ContentPage
      eyebrow="Legal"
      title="Kepatuhan UU PDP"
      lead="Bagaimana NusaPDF memetakan dirinya terhadap Undang-Undang No. 27 Tahun 2022 tentang Pelindungan Data Pribadi."
      updated="22 Agustus 2026"
    >
      <DraftNotice />

      <h2>1. Peran para pihak</h2>
      <p>
        Dalam kerangka UU PDP, kami bertindak sebagai <strong>Pengendali Data Pribadi</strong>{' '}
        atas identitas akun dan metadata penggunaan. Untuk dokumen yang Anda unggah ke AI
        PDF, kami bertindak sebagai pengendali dengan penyedia berikut sebagai{' '}
        <strong>Prosesor Data Pribadi</strong>:
      </p>
      <ul>
        <li>
          <strong>Supabase</strong> — autentikasi, basis data, dan penyimpanan objek.
        </li>
        <li>
          <strong>Google (Gemini API)</strong> — pemrosesan bahasa untuk menghasilkan
          jawaban.
        </li>
        <li>
          <strong>Vercel</strong> — hosting aplikasi.
        </li>
      </ul>

      <Callout title="Alat yang berjalan lokal berada di luar lingkup ini">
        <p>
          Sebelas dari dua belas alat — Merge, Split, Compress, konversi gambar, dan
          seluruh konversi Office — memproses berkas sepenuhnya di perangkat Anda. Untuk
          alat-alat tersebut kami tidak menjadi pengendali maupun prosesor atas isi dokumen
          Anda, karena tidak ada data yang berpindah kepada kami.
        </p>
      </Callout>

      <h2>2. Jenis data pribadi</h2>
      <table>
        <thead>
          <tr>
            <th>Kategori</th>
            <th>Contoh</th>
            <th>Kapan diproses</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Data identitas</td>
            <td>Alamat surel, nama tampilan</td>
            <td>Hanya bila Anda mendaftar</td>
          </tr>
          <tr>
            <td>Pengenal teknis</td>
            <td>Pengenal sesi anonim</td>
            <td>Sejak kunjungan pertama</td>
          </tr>
          <tr>
            <td>Konten dokumen</td>
            <td>Isi PDF yang diunggah ke AI PDF</td>
            <td>Hanya saat memakai AI PDF</td>
          </tr>
        </tbody>
      </table>
      <p>
        Dokumen yang Anda unggah ke AI PDF dapat memuat data pribadi bersifat spesifik —
        misalnya NIK, data kesehatan, atau data keuangan. Kami tidak mengindeks maupun
        mengekstraksi data semacam itu secara terpisah; dokumen diproses sebagai satu
        kesatuan untuk menjawab pertanyaan Anda, lalu dihapus.
      </p>

      <h2>3. Dasar pemrosesan</h2>
      <p>
        Untuk dokumen AI PDF, dasar pemrosesannya adalah <strong>persetujuan</strong> yang
        Anda berikan saat mengunggah. Persetujuan itu diminta secara eksplisit melalui
        pemberitahuan sebelum unggahan, bukan tersembunyi di dalam ketentuan layanan.
      </p>
      <p>
        Untuk identitas akun, dasarnya adalah pelaksanaan layanan yang Anda minta. Untuk
        metadata penggunaan, dasarnya adalah kepentingan sah dalam menjaga keandalan
        layanan.
      </p>

      <h2>4. Prinsip minimalisasi</h2>
      <p>
        Arsitektur NusaPDF dirancang agar sebagian besar pemrosesan tidak memerlukan
        pengumpulan data sama sekali. Ini bukan kebijakan di atas kertas, melainkan
        konsekuensi teknis: berkas pada alat lokal tidak dapat kami kumpulkan karena tidak
        pernah dikirim.
      </p>

      <h2>5. Masa retensi</h2>
      <ul>
        <li>Dokumen AI PDF beserta turunannya: paling lama 24 jam.</li>
        <li>Riwayat percakapan: selama akun aktif, dapat dihapus kapan saja oleh Anda.</li>
        <li>Metadata penggunaan: disimpan teragregasi.</li>
      </ul>

      <h2>6. Transfer ke luar wilayah Indonesia</h2>
      <p>
        Basis data dan penyimpanan objek kami berada di Singapura
        (<code>ap-southeast-1</code>), dipilih karena kedekatan geografis dan latensi yang
        rendah untuk pengguna Indonesia. Pemrosesan oleh Google Gemini dapat berlangsung di
        wilayah lain sesuai infrastruktur penyedia.
      </p>
      <p>
        Sesuai Pasal 56 UU PDP, transfer semacam ini dilakukan dengan memastikan negara
        tujuan memiliki tingkat pelindungan yang setara atau melalui perjanjian yang
        mengikat prosesor. Pemetaan rinci atas hal ini merupakan bagian dari telaah hukum
        yang sedang berjalan.
      </p>

      <h2>7. Hak subjek data</h2>
      <p>Berdasarkan Pasal 5 sampai 15 UU PDP, Anda berhak:</p>
      <ul>
        <li>memperoleh informasi tentang data yang diproses dan tujuannya;</li>
        <li>melengkapi, memperbarui, dan memperbaiki data Anda;</li>
        <li>mengakses dan memperoleh salinan data Anda;</li>
        <li>mengakhiri pemrosesan, menghapus, dan memusnahkan data Anda;</li>
        <li>menarik kembali persetujuan;</li>
        <li>mengajukan keberatan atas pengambilan keputusan yang sepenuhnya otomatis;</li>
        <li>menuntut ganti rugi atas pelanggaran pelindungan data pribadi.</li>
      </ul>
      <p>
        Sebagian besar hak tersebut dapat Anda jalankan langsung: menghapus dokumen,
        menghapus percakapan, atau menghapus akun beserta seluruh isinya.
      </p>

      <h2>8. Keamanan dan pemberitahuan insiden</h2>
      <p>
        Kami menerapkan enkripsi saat transit, kebijakan akses per-baris pada basis data dan
        penyimpanan, serta pemisahan kunci layanan agar tidak pernah sampai ke peramban.
      </p>
      <p>
        Sesuai Pasal 46 UU PDP, bila terjadi kegagalan pelindungan data pribadi, kami akan
        memberitahukan subjek data dan lembaga yang berwenang dalam waktu paling lambat 3×24
        jam.
      </p>

      <h2>9. Pejabat Pelindungan Data</h2>
      <p>
        Penunjukan Pejabat Pelindungan Data sesuai Pasal 53 UU PDP merupakan bagian dari
        telaah hukum yang sedang berjalan. Sementara itu, permintaan terkait data pribadi
        dapat disampaikan melalui kanal pada{' '}
        <Link href="/bantuan">Pusat bantuan</Link>.
      </p>

      <h2>10. Dokumen terkait</h2>
      <ul>
        <li>
          <Link href="/kebijakan-privasi">Kebijakan privasi</Link>
        </li>
        <li>
          <Link href="/privasi">Cara kerja privasi kami</Link> — uraian teknisnya
        </li>
        <li>
          <Link href="/kuki">Kebijakan kuki</Link>
        </li>
      </ul>
    </ContentPage>
  );
}
