import type { Metadata } from 'next';
import Link from 'next/link';
import { ContentPage, DraftNotice } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Ketentuan layanan',
  description: 'Ketentuan penggunaan layanan NusaPDF.',
};

export default function KetentuanPage() {
  return (
    <ContentPage
      eyebrow="Legal"
      title="Ketentuan layanan"
      lead="Ketentuan yang berlaku saat Anda menggunakan NusaPDF."
      updated="22 Agustus 2026"
    >
      <DraftNotice />

      <h2>1. Penerimaan ketentuan</h2>
      <p>
        Dengan menggunakan NusaPDF, Anda menyetujui ketentuan ini. Bila Anda tidak
        menyetujuinya, mohon tidak menggunakan layanan.
      </p>

      <h2>2. Layanan yang kami sediakan</h2>
      <p>
        NusaPDF menyediakan perkakas pengolahan berkas PDF. Sebagian besar alat berjalan
        sepenuhnya di peramban Anda; fitur AI PDF berjalan di server kami dan memerlukan
        unggahan dokumen. Perbedaan ini dijelaskan pada{' '}
        <Link href="/privasi">Cara kerja privasi kami</Link>.
      </p>

      <h2>3. Akun</h2>
      <p>
        Sebagian besar alat dapat dipakai tanpa akun. Bila Anda membuat akun, Anda
        bertanggung jawab menjaga kerahasiaan akses ke surel yang Anda daftarkan. Kami dapat
        menangguhkan akun yang digunakan untuk melanggar ketentuan ini.
      </p>

      <h2>4. Penggunaan yang tidak diperbolehkan</h2>
      <p>Anda setuju untuk tidak:</p>
      <ul>
        <li>
          mengunggah atau memproses berkas yang Anda tidak berhak mengolahnya, termasuk
          materi yang melanggar hak cipta pihak lain;
        </li>
        <li>
          menggunakan layanan untuk memproses materi yang melanggar hukum yang berlaku di
          Indonesia;
        </li>
        <li>
          berupaya membongkar, mengganggu, membebani secara berlebihan, atau melewati batas
          kuota layanan secara otomatis;
        </li>
        <li>
          menggunakan layanan untuk membuat atau menyebarkan informasi yang menyesatkan
          dengan mengatasnamakan NusaPDF.
        </li>
      </ul>

      <h2>5. Hak atas berkas Anda</h2>
      <p>
        Berkas dan isinya tetap sepenuhnya milik Anda. Kami tidak mengklaim hak apa pun
        atasnya. Untuk alat yang berjalan di peramban, kami bahkan tidak menerima berkas
        tersebut. Untuk AI PDF, Anda memberi kami izin terbatas untuk memproses dokumen itu
        semata-mata guna menghasilkan jawaban yang Anda minta, dan izin itu berakhir saat
        dokumen dihapus.
      </p>

      <h2>6. Ketersediaan layanan</h2>
      <p>
        Layanan disediakan sebagaimana adanya. Kami berupaya menjaga ketersediaannya, tetapi
        tidak menjamin layanan bebas gangguan atau bebas galat. Kami dapat mengubah,
        menangguhkan, atau menghentikan fitur tertentu, dan akan berusaha memberitahukannya
        lebih dulu bila perubahan tersebut material.
      </p>

      <h2>7. Batasan teknis</h2>
      <p>
        Alat yang berjalan di peramban dibatasi oleh kemampuan perangkat Anda: maksimal 100
        MB per berkas dan 20 berkas sekaligus. AI PDF dibatasi 50 MB dan 500 halaman per
        dokumen, serta memiliki kuota harian. Batasan ini dapat kami sesuaikan.
      </p>

      <h2>8. Tidak ada jaminan atas hasil</h2>
      <p>
        Hasil pengolahan PDF bergantung pada struktur berkas asal Anda. Kami tidak menjamin
        hasil kompresi mencapai persentase tertentu, dan tidak menjamin jawaban AI PDF bebas
        dari kekeliruan. Untuk keperluan penting, mohon selalu memeriksa hasilnya —
        khususnya jawaban AI, yang karena itu selalu kami sertai rujukan nomor halaman agar
        dapat Anda verifikasi.
      </p>

      <h2>9. Simpan salinan Anda sendiri</h2>
      <p>
        NusaPDF bukan layanan penyimpanan. Berkas pada alat lokal hilang ketika tab ditutup,
        dan dokumen AI PDF dihapus dalam 24 jam. Mohon selalu menyimpan salinan berkas asli
        Anda.
      </p>

      <h2>10. Batasan tanggung jawab</h2>
      <p>
        Sepanjang diizinkan hukum yang berlaku, kami tidak bertanggung jawab atas kehilangan
        data, kehilangan keuntungan, atau kerugian tidak langsung yang timbul dari
        penggunaan layanan ini.
      </p>

      <h2>11. Perubahan ketentuan</h2>
      <p>
        Ketentuan ini dapat kami perbarui. Tanggal pembaruan terakhir tercantum di bagian
        atas halaman, dan perubahan material akan kami beritahukan melalui aplikasi.
      </p>

      <h2>12. Hukum yang berlaku</h2>
      <p>
        Ketentuan ini tunduk pada hukum Republik Indonesia.
      </p>
    </ContentPage>
  );
}
