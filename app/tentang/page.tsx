import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout, ContentPage } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Tentang NusaPDF',
  description:
    'Mengapa NusaPDF dibuat, prinsip yang kami pegang, dan apa yang sengaja tidak kami bangun.',
};

export default function TentangPage() {
  return (
    <ContentPage
      eyebrow="Tentang"
      title="Perkakas PDF yang tidak perlu Anda percayai."
      lead="NusaPDF dibangun dari satu pengamatan sederhana: sebagian besar pekerjaan PDF sehari-hari sebenarnya tidak memerlukan server sama sekali."
      updated="22 Agustus 2026"
    >
      <h2>Masalah yang kami pecahkan</h2>
      <p>
        Pekerja kantoran, mahasiswa, dan pelaku UMKM di Indonesia rutin perlu menggabungkan,
        memisahkan, atau mengecilkan PDF. Yang tersedia umumnya layanan asing yang mengunggah
        dokumen ke server di luar negeri — masalah nyata untuk berkas berisi NIK, data
        keuangan, atau kontrak. Banyak di antaranya juga memasang paywall setelah satu atau
        dua operasi.
      </p>
      <p>
        Di sisi lain, dokumen panjang seperti laporan tahunan, peraturan, dan jurnal menuntut
        waktu baca yang jarang dimiliki pembacanya, sementara belum ada perkakas yang
        menyatukan utilitas PDF dengan kemampuan memahami isinya.
      </p>

      <h2>Tiga prinsip</h2>

      <h3>1. Kerjakan di perangkat pengguna bila memungkinkan</h3>
      <p>
        Peramban modern sanggup membaca dan menulis struktur PDF sendiri. Bila pekerjaan bisa
        dilakukan di sana, mengirim dokumen ke server hanya menambah risiko tanpa menambah
        manfaat. Sebelas dari dua belas alat kami bekerja seperti itu — termasuk seluruh
        konversi Office, yang biasanya dikerjakan di server oleh layanan lain.
      </p>

      <h3>2. Nyatakan pengecualiannya dengan jelas</h3>
      <p>
        AI PDF memang harus mengunggah berkas, dan kami tidak menyamarkannya di balik
        kalimat halus. Pemberitahuan eksplisit muncul sebelum unggahan, lengkap dengan
        berapa lama dokumen disimpan.
      </p>

      <h3>3. Jangan menjanjikan yang belum terukur</h3>
      <p>
        Kompresi kami memberi tahu apa yang realistis untuk dokumen berisi teks alih-alih
        menjanjikan angka besar yang tidak akan tercapai. Konversi Office belum dirilis
        justru karena kami belum mengukur akurasinya. Angka yang tidak kami uji tidak kami
        pasang.
      </p>

      <Callout title="Apa yang sengaja tidak kami bangun">
        <p>
          NusaPDF bukan editor PDF selengkap Acrobat, bukan platform kolaborasi, dan bukan
          tempat penyimpanan dokumen. Ia alat lintas: Anda datang, menyelesaikan satu
          pekerjaan, lalu pergi — dan tidak ada jejak yang tertinggal di server kami.
        </p>
      </Callout>

      <h2>Status saat ini</h2>
      <p>
        Yang sudah berjalan: Merge, Split, Compress, PDF to JPG, JPG to PDF, konversi PDF ↔
        Word, PowerPoint, dan Excel, serta AI PDF.
      </p>
      <p>
        Sedang disiapkan: Edit PDF dan OCR untuk dokumen hasil pindai. Keduanya tampil di
        beranda dengan penanda “segera hadir” supaya Anda tahu arah yang kami tuju.
      </p>

      <h2>Cara kerjanya secara teknis</h2>
      <p>
        Alat lokal memakai <code>pdf-lib</code> dan <code>pdf.js</code> yang berjalan di
        dalam Web Worker pada peramban Anda. AI PDF memakai model Gemini dengan skema
        pencarian berbasis potongan dokumen, sehingga setiap jawaban dapat dirujukkan ke
        nomor halaman aslinya. Rinciannya ada di{' '}
        <Link href="/privasi">Cara kerja privasi kami</Link>.
      </p>

      <h2>Pembuat</h2>
      <p>
        NusaPDF dibuat oleh <strong>Gideon Ivan</strong>.
      </p>
    </ContentPage>
  );
}
