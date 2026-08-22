import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentPage, DraftNotice } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Kebijakan privasi',
  description:
    'Data apa yang NusaPDF proses, atas dasar apa, berapa lama disimpan, dan hak Anda atasnya.',
};

export default function KebijakanPrivasiPage() {
  return (
    <ContentPage
      eyebrow="Legal"
      title="Kebijakan privasi"
      lead="Penjelasan formal tentang data yang kami proses. Untuk uraian teknis yang lebih mudah dibaca, lihat Cara kerja privasi kami."
      updated="22 Agustus 2026"
    >
      <DraftNotice />

      <h2>1. Siapa kami</h2>
      <p>
        NusaPDF adalah layanan pengolahan berkas PDF berbasis web. Dalam kebijakan ini,
        “kami” merujuk pada penyelenggara NusaPDF, dan “Anda” merujuk pada pengguna layanan.
      </p>

      <h2>2. Prinsip dasar</h2>
      <p>
        Sebagian besar layanan kami dirancang agar dokumen Anda tidak pernah kami terima.
        Sebelas dari dua belas alat — termasuk seluruh konversi ke dan dari Word,
        PowerPoint, serta Excel — berjalan sepenuhnya di peramban Anda. Untuk alat-alat
        tersebut, kami tidak memproses isi dokumen Anda dalam bentuk apa pun, karena isi itu
        tidak pernah sampai kepada kami.
      </p>

      <h2>3. Data yang kami proses</h2>

      <h3>3.1 Data teknis penggunaan</h3>
      <p>
        Untuk seluruh alat, kami mencatat metadata berikut: nama alat yang dipakai, jumlah
        berkas, total ukuran berkas, jumlah halaman, durasi proses, keberhasilan atau
        kegagalan, dan kode galat bila ada.
      </p>
      <p>
        Metadata ini <strong>tidak memuat</strong> isi berkas, nama berkas, teks di dalam
        dokumen, maupun gambar dari dokumen Anda.
      </p>

      <h3>3.2 Identitas akun</h3>
      <p>
        Saat kunjungan pertama, sistem membuat sesi anonim berupa pengenal acak. Sesi ini
        tidak memuat data pribadi. Bila Anda memilih mendaftar, kami memproses alamat surel
        Anda, dan — bila Anda masuk melalui Google — nama serta foto profil yang Anda
        izinkan untuk dibagikan.
      </p>

      <h3>3.3 Dokumen yang diunggah ke AI PDF</h3>
      <p>
        Hanya berlaku bila Anda memakai AI PDF. Kami memproses: berkas PDF yang Anda unggah,
        teks yang diekstrak darinya beserta representasi numerik (embedding) dari teks
        tersebut, pertanyaan yang Anda ajukan, dan jawaban yang dihasilkan.
      </p>

      <h2>4. Dasar dan tujuan pemrosesan</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Tujuan</th>
            <th>Dasar</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Metadata penggunaan</td>
            <td>Memperbaiki keandalan dan kinerja layanan</td>
            <td>Kepentingan sah</td>
          </tr>
          <tr>
            <td>Identitas akun</td>
            <td>Menyediakan akun, riwayat, dan penegakan kuota</td>
            <td>Pelaksanaan layanan</td>
          </tr>
          <tr>
            <td>Dokumen AI PDF</td>
            <td>Menjawab pertanyaan Anda atas dokumen tersebut</td>
            <td>Persetujuan Anda saat mengunggah</td>
          </tr>
        </tbody>
      </table>

      <h2>5. Masa simpan</h2>
      <ul>
        <li>
          <strong>Dokumen AI PDF beserta teks dan embedding-nya:</strong> dihapus otomatis
          paling lama 24 jam sejak diunggah.
        </li>
        <li>
          <strong>Riwayat percakapan:</strong> disimpan selama akun Anda aktif, dan dapat
          Anda hapus kapan saja.
        </li>
        <li>
          <strong>Metadata penggunaan:</strong> disimpan dalam bentuk teragregasi untuk
          keperluan analisis layanan.
        </li>
        <li>
          <strong>Berkas pada alat lokal:</strong> tidak disimpan sama sekali, karena tidak
          pernah kami terima.
        </li>
      </ul>

      <h2>6. Pihak ketiga sebagai pemroses</h2>
      <p>Kami memakai penyedia berikut, terbatas pada tujuan yang disebutkan:</p>
      <ul>
        <li>
          <strong>Supabase</strong> — autentikasi, basis data, dan penyimpanan objek.
          Wilayah pemrosesan: Singapura.
        </li>
        <li>
          <strong>Google Gemini</strong> — pemrosesan bahasa untuk fitur AI PDF. Dokumen dan
          pertanyaan Anda dikirim ke layanan ini untuk menghasilkan jawaban.
        </li>
        <li>
          <strong>Vercel</strong> — hosting aplikasi web.
        </li>
      </ul>
      <p>
        Kami tidak menjual data Anda, tidak menukarnya, dan tidak memakainya untuk melatih
        model kecerdasan buatan.
      </p>

      <h2>7. Transfer ke luar wilayah Indonesia</h2>
      <p>
        Penyimpanan utama kami berada di Singapura, dan pemrosesan oleh Google Gemini dapat
        berlangsung di wilayah lain. Penjelasan mengenai hal ini ada pada halaman{' '}
        <Link href="/pdp">Kepatuhan UU PDP</Link>.
      </p>

      <h2>8. Hak Anda</h2>
      <p>
        Sesuai UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi, Anda berhak
        memperoleh informasi, mengakses, memperbaiki, menghapus, menarik persetujuan,
        membatasi pemrosesan, memperoleh salinan data, dan mengajukan keberatan atas
        pengambilan keputusan otomatis.
      </p>
      <p>
        Sebagian besar hak ini dapat Anda jalankan langsung dari aplikasi: menghapus dokumen,
        menghapus percakapan, atau menghapus akun.
      </p>

      <h2>9. Keamanan</h2>
      <p>
        Data dikirim melalui koneksi terenkripsi. Dokumen pada penyimpanan objek dilindungi
        kebijakan akses per-baris sehingga hanya dapat dibaca oleh akun pemiliknya. Kunci
        layanan pihak ketiga hanya berada di sisi server dan tidak pernah dikirim ke
        peramban.
      </p>

      <h2>10. Anak-anak</h2>
      <p>
        Layanan ini tidak ditujukan bagi anak di bawah 13 tahun dan kami tidak dengan sengaja
        mengumpulkan data pribadi mereka.
      </p>

      <h2>11. Perubahan</h2>
      <p>
        Bila kebijakan ini berubah secara material, kami akan memberitahukannya melalui
        aplikasi. Tanggal pembaruan terakhir tercantum di bagian atas halaman.
      </p>

      <h2>12. Menghubungi kami</h2>
      <p>
        Pertanyaan atau permintaan terkait data pribadi dapat disampaikan melalui kanal
        kontak pada <Link href="/bantuan">Pusat bantuan</Link>.
      </p>
    </ContentPage>
  );
}
