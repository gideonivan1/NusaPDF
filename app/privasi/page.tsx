import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout, ContentPage } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Cara kerja privasi kami',
  description:
    'Sebelas dari dua belas alat NusaPDF memproses berkas sepenuhnya di peramban Anda. Berikut penjelasan teknisnya dan cara Anda memverifikasinya sendiri.',
};

export default function PrivasiPage() {
  return (
    <ContentPage
      eyebrow="Privasi"
      title="Kami tidak bisa membocorkan berkas yang tidak pernah kami terima."
      lead="Sebagian besar layanan PDF gratis mengunggah dokumen Anda ke server mereka. Di NusaPDF, sebelas dari dua belas alat tidak perlu melakukan itu — dan satu alat yang perlu, kami nyatakan terang-terangan."
      updated="22 Agustus 2026"
    >
      <h2>Dua jalur pemrosesan, dan bedanya nyata</h2>
      <p>
        NusaPDF memakai arsitektur <strong>hybrid</strong>. Pembagiannya bukan detail
        teknis yang bisa Anda abaikan — ia menentukan apakah dokumen Anda meninggalkan
        perangkat atau tidak.
      </p>

      <table>
        <thead>
          <tr>
            <th>Alat</th>
            <th>Diproses di</th>
            <th>Berkas diunggah?</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Merge, Split, Compress</td>
            <td>Peramban Anda</td>
            <td>Tidak</td>
          </tr>
          <tr>
            <td>PDF to JPG, JPG to PDF</td>
            <td>Peramban Anda</td>
            <td>Tidak</td>
          </tr>
          <tr>
            <td>PDF to Word, PowerPoint, Excel</td>
            <td>Peramban Anda</td>
            <td>Tidak</td>
          </tr>
          <tr>
            <td>Word, PowerPoint, Excel to PDF</td>
            <td>Peramban Anda</td>
            <td>Tidak</td>
          </tr>
          <tr>
            <td>AI PDF</td>
            <td>Server kami</td>
            <td>
              <strong>Ya</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <p>
        Konversi Office termasuk di dalamnya, dan itu tidak lazim: hampir semua layanan
        lain mengerjakannya di server karena lebih mudah. Kami memilih menanggung
        konsekuensinya — hasil konversi kami memindahkan <strong>isi</strong> dokumen, bukan
        meniru tata letaknya persis — demi tidak perlu menerima berkas Anda sama sekali.
        Setiap alat konversi menyatakan batas itu di panelnya sendiri sebelum Anda menekan
        tombol.
      </p>

      <h2>Bagaimana alat lokal bisa bekerja tanpa server</h2>
      <p>
        Peramban modern mampu membaca dan menulis struktur PDF sendiri. Ketika Anda
        menjatuhkan berkas, NusaPDF membacanya melalui <code>File API</code> — berkas itu
        menjadi objek di memori tab Anda, bukan unggahan. Seluruh operasi kemudian
        dijalankan di dalam <em>Web Worker</em>, sebuah utas terpisah di dalam peramban
        Anda sendiri.
      </p>
      <p>
        Hasilnya dibentuk sebagai <code>Blob</code> lokal, dan tombol unduh hanya menyimpan
        blob itu ke disk Anda. Tidak ada satu pun permintaan jaringan yang membawa isi
        berkas di sepanjang proses ini.
      </p>

      <Callout title="Anda tidak perlu percaya begitu saja">
        <p>
          Buka <strong>DevTools → tab Network</strong> di peramban Anda, lalu jalankan
          Merge atau Compress. Anda akan melihat tidak ada permintaan yang memuat isi
          berkas. Ini klaim yang bisa Anda uji sendiri dalam waktu kurang dari satu menit —
          dan begitulah seharusnya sebuah klaim privasi disampaikan.
        </p>
      </Callout>

      <h2>Konsekuensinya: alat lokal tidak kami batasi</h2>
      <p>
        Karena kesebelas alat tersebut tidak memakai komputasi atau bandwidth kami sama
        sekali, tidak ada alasan untuk membatasinya. Tidak ada kuota harian, tidak ada
        hitungan mundur, dan tidak ada permintaan mendaftar sebelum Anda boleh mengunduh
        hasil.
      </p>

      <h2>AI PDF: satu-satunya pengecualian</h2>
      <p>
        Untuk menjawab pertanyaan tentang isi dokumen, asisten harus benar-benar
        membacanya, dan itu terjadi di server. Kami tidak menyamarkan hal ini: sebelum
        Anda mengunggah, halaman AI PDF menampilkan pemberitahuan eksplisit bahwa berkas
        akan dikirim.
      </p>
      <p>Yang berlaku untuk dokumen yang Anda unggah ke AI PDF:</p>
      <ul>
        <li>
          Disimpan pada penyimpanan objek terenkripsi dengan kebijakan akses per-baris —
          hanya akun Anda yang dapat membacanya.
        </li>
        <li>
          <strong>Dihapus otomatis paling lama 24 jam</strong> setelah diunggah, termasuk
          bila Anda tidak menghapusnya sendiri.
        </li>
        <li>
          Dikirim ke Google Gemini sebagai pemroses untuk menghasilkan jawaban. Entri di
          sisi Gemini kedaluwarsa sekitar 48 jam.
        </li>
        <li>
          Tidak dipakai untuk melatih model apa pun, dan tidak dibagikan ke pihak ketiga
          lain.
        </li>
      </ul>
      <p>
        Anda dapat menghapus dokumen dan percakapan kapan saja, dan penghapusan itu bersifat
        permanen.
      </p>

      <h2>Data apa yang kami kumpulkan</h2>
      <p>
        Untuk alat yang berjalan lokal, kami mencatat <strong>metadata saja</strong>: nama
        alat yang dipakai, jumlah berkas, total ukuran, jumlah halaman, durasi proses, dan
        apakah prosesnya berhasil. Catatan ini kami pakai untuk mengetahui alat mana yang
        sering gagal dan perlu diperbaiki.
      </p>
      <p>
        Yang <strong>tidak pernah</strong> kami kumpulkan dari alat lokal: isi berkas, nama
        berkas, teks di dalam dokumen, maupun potongan gambarnya.
      </p>

      <h2>Akun anonim</h2>
      <p>
        Anda tidak perlu mendaftar untuk memakai NusaPDF. Saat kunjungan pertama, sebuah
        sesi anonim dibuat secara otomatis — ini identitas teknis yang memungkinkan kuota
        AI ditegakkan dan riwayat percakapan Anda dipisahkan dari pengguna lain. Sesi
        anonim tidak memuat nama, alamat surel, maupun identitas pribadi apa pun.
      </p>
      <p>
        Bila kemudian Anda mendaftar, akun anonim itu ditingkatkan menjadi akun tetap
        dengan identitas yang sama, sehingga riwayat percakapan Anda ikut terbawa.
      </p>

      <h2>Lokasi penyimpanan</h2>
      <p>
        Basis data dan penyimpanan objek kami berada di wilayah Singapura
        (<code>ap-southeast-1</code>). Pemrosesan oleh Google Gemini dapat terjadi di luar
        wilayah tersebut. Rincian dan dasar hukumnya dijelaskan pada{' '}
        <Link href="/pdp">halaman kepatuhan UU PDP</Link>.
      </p>

      <h2>Dokumen terkait</h2>
      <ul>
        <li>
          <Link href="/kebijakan-privasi">Kebijakan privasi</Link> — pernyataan formal
          tentang data yang kami proses
        </li>
        <li>
          <Link href="/kuki">Kebijakan kuki</Link> — kuki apa saja yang kami pakai
        </li>
        <li>
          <Link href="/pdp">Kepatuhan UU PDP</Link> — peran, hak Anda, dan transfer lintas
          negara
        </li>
      </ul>
    </ContentPage>
  );
}
