import Link from 'next/link';
import { ArrowUpRight, Cpu, Infinity as InfinityIcon, ShieldCheck } from 'lucide-react';
import { OrbitalField } from '@/components/home/OrbitalField';
import { ToolPortraitCard } from '@/components/home/ToolPortraitCard';
import { TOOLS } from '@/lib/tools';

export default function HomePage() {
  return (
    <>
      {/* ---------------------------------------------------------------- Hero */}
      <section className="container-page relative pt-10 pb-24 md:pt-16">
        {/* Ghost watermark: cream-on-cream, bleeding off the right edge. */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-2 -right-24 hidden text-[168px] leading-none font-medium tracking-[-0.02em] text-ghost select-none xl:block"
        >
          PDF
        </span>

        <div className="relative max-w-3xl">
          <p className="flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
            <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
            Perkakas PDF Indonesia
          </p>

          <h1 className="mt-6 text-[clamp(40px,7vw,64px)] leading-[1] font-medium tracking-[-0.02em] text-balance">
            Berkas Anda tidak pernah meninggalkan perangkat.
          </h1>

          <p className="mt-7 max-w-xl text-[18px] leading-[1.5] text-granite">
            Gabungkan, pisahkan, kompres, dan konversi PDF langsung di peramban Anda.
            Untuk dokumen yang panjang, tanyakan saja isinya pada asisten AI.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <Link
              href="/merge"
              className="inline-flex items-center gap-2 rounded-btn border-[1.5px] border-ink bg-ink px-7 py-3 text-[16px] font-medium tracking-[-0.02em] text-canvas transition-transform active:scale-[0.98]"
            >
              Mulai gabungkan PDF
            </Link>
            <Link
              href="/ai-pdf"
              className="inline-flex items-center gap-2 rounded-btn border-[1.5px] border-ink bg-white px-7 py-3 text-[16px] font-normal tracking-[-0.02em] text-ink transition-transform active:scale-[0.98]"
            >
              Coba AI PDF
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </div>
        </div>

        <ul className="mt-16 grid gap-x-10 gap-y-6 sm:grid-cols-3">
          <Assurance icon={ShieldCheck} title="Diproses di perangkat">
            Sebelas dari dua belas alat berjalan penuh di peramban. Tidak ada unggahan.
          </Assurance>
          <Assurance icon={InfinityIcon} title="Tanpa batas, tanpa akun">
            Alat yang berjalan lokal tidak memakai server kami — jadi tidak kami batasi.
          </Assurance>
          <Assurance icon={Cpu} title="Cepat karena lokal">
            Tidak ada antrean unggah dan unduh. Hasilnya muncul dalam hitungan detik.
          </Assurance>
        </ul>
      </section>

      {/* -------------------------------------------------------- Constellation */}
      <section id="perkakas" className="relative scroll-mt-32 pb-16">
        <OrbitalField className="pointer-events-none absolute inset-x-0 top-52 hidden h-[620px] w-full lg:block" />

        <div className="container-page relative">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
              <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
              Semua perkakas
            </p>
            <h2 className="mt-5 text-section text-balance">
              Tiga belas alat, satu tempat, satu janji.
            </h2>
          </div>

          {/* Six across on desktop lays the 13 tools out as 6 / 6 / 1. */}
          <ul className="mt-16 grid grid-cols-2 gap-x-6 gap-y-14 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 lg:gap-x-8">
            {TOOLS.map((tool) => (
              <li key={tool.slug}>
                <ToolPortraitCard tool={tool} />
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------------- Privacy */}
      <section className="container-page pt-24">
        <div className="rounded-stadium bg-lifted px-8 py-16 shadow-card md:px-16 md:py-20">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
              <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
              Cara kerjanya
            </p>
            <h2 className="mt-5 text-section text-balance">
              Berkas tetap di Peramban Anda, bukan Server Kami.
            </h2>
            <p className="mt-6 text-[17px] leading-[1.55] text-granite">
              Gabung, pisah, kompres, dan seluruh konversi — termasuk ke Word, PowerPoint,
              dan Excel — dikerjakan oleh peramban Anda sendiri, bukan server kami. Buka panel Jaringan di peramban saat Anda
              memakainya: tidak ada satu pun byte berkas yang terkirim.
            </p>
            <p className="mt-4 text-[17px] leading-[1.55] text-granite">
              AI PDF adalah pengecualiannya, dan kami menyatakannya terang-terangan sebelum
              Anda mengunggah. Dokumen yang dikirim ke sana dihapus otomatis dalam 24 jam.
            </p>

            <Link
              href="/privasi"
              className="mt-9 inline-flex items-center gap-2 rounded-btn border-[1.5px] border-ink bg-white px-7 py-3 text-[16px] font-normal text-ink transition-transform active:scale-[0.98]"
            >
              Baca cara kerja privasi kami
              <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Assurance({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <Icon aria-hidden strokeWidth={1.5} className="mt-0.5 size-5 shrink-0 text-signal" />
      <div>
        <p className="font-medium tracking-[-0.01em] text-ink">{title}</p>
        <p className="mt-1 text-[15px] leading-[1.45] text-granite">{children}</p>
      </div>
    </li>
  );
}
