import type { Metadata } from 'next';
import Link from 'next/link';
import { Callout, ContentPage, DraftNotice } from '@/components/content/ContentPage';

export const metadata: Metadata = {
  title: 'Kebijakan kuki',
  description: 'Kuki dan penyimpanan lokal apa saja yang dipakai NusaPDF, dan untuk apa.',
};

export default function KukiPage() {
  return (
    <ContentPage
      eyebrow="Legal"
      title="Kebijakan kuki"
      lead="Daftar lengkap kuki dan penyimpanan lokal yang kami pakai. Jumlahnya sedikit, dan tidak ada satu pun untuk iklan."
      updated="22 Agustus 2026"
    >
      <DraftNotice />

      <Callout title="Kami tidak memakai kuki iklan">
        <p>
          Tidak ada kuki pihak ketiga untuk periklanan, penargetan, maupun pelacakan lintas
          situs di NusaPDF.
        </p>
      </Callout>

      <h2>Kuki yang diperlukan</h2>
      <p>
        Kuki ini dibutuhkan agar layanan berfungsi dan tidak dapat dinonaktifkan tanpa
        merusak fitur yang bergantung padanya.
      </p>

      <table>
        <thead>
          <tr>
            <th>Nama</th>
            <th>Fungsi</th>
            <th>Masa berlaku</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>sb-*-auth-token</code>
            </td>
            <td>
              Menyimpan sesi Anda — termasuk sesi anonim — sehingga kuota AI dapat ditegakkan
              dan riwayat percakapan Anda terpisah dari pengguna lain.
            </td>
            <td>Hingga keluar akun</td>
          </tr>
        </tbody>
      </table>

      <h2>Penyimpanan lokal di peramban</h2>
      <p>
        Bukan kuki, dan tidak pernah dikirim ke server kami. Data ini hanya tersimpan di
        perangkat Anda.
      </p>

      <table>
        <thead>
          <tr>
            <th>Kunci</th>
            <th>Fungsi</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Preferensi bahasa</td>
            <td>Mengingat pilihan bahasa antarmuka Anda.</td>
          </tr>
          <tr>
            <td>Status persetujuan</td>
            <td>Mengingat bahwa Anda sudah menanggapi pemberitahuan kuki.</td>
          </tr>
        </tbody>
      </table>

      <h2>Berkas yang Anda proses</h2>
      <p>
        Berkas pada alat yang berjalan di peramban <strong>tidak</strong> disimpan dalam
        kuki maupun penyimpanan lokal. Berkas itu hanya berada di memori tab selama Anda
        mengerjakannya, dan hilang begitu tab ditutup atau dimuat ulang. Penjelasannya ada
        di <Link href="/privasi">Cara kerja privasi kami</Link>.
      </p>

      <h2>Analitik</h2>
      <p>
        Kami memakai <strong>Vercel Analytics</strong> untuk menghitung kunjungan halaman
        secara agregat: halaman mana yang dibuka, dari mana pengunjung datang, dan jenis
        perangkat yang dipakai.
      </p>
      <p>
        Layanan ini <strong>tidak memakai kuki</strong> dan tidak mengikuti Anda ke situs
        lain. Ia juga tidak melihat berkas Anda — pengukurannya berhenti pada tingkat
        halaman, dan berkas pada alat yang berjalan lokal memang tidak pernah sampai ke
        kami untuk bisa diukur.
      </p>

      <h2>Mengelola kuki</h2>
      <p>
        Anda dapat menghapus kuki melalui pengaturan peramban. Menghapus kuki sesi akan
        mengeluarkan Anda dari akun dan menghilangkan akses ke riwayat percakapan AI. Alat
        yang berjalan di peramban tetap berfungsi normal tanpa kuki apa pun.
      </p>
    </ContentPage>
  );
}
