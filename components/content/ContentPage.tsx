import Link from 'next/link';
import { ArrowLeft, Info } from 'lucide-react';

/** Shared shell for the long-form pages: privacy, help, FAQ, about, legal. */
export function ContentPage({
  eyebrow,
  title,
  lead,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  /** Human-readable date, e.g. "22 Agustus 2026". */
  updated?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="container-page pb-24">
      <header className="max-w-3xl pt-6 pb-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-micro text-[15px] text-granite transition-colors hover:text-ink"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Kembali ke beranda
        </Link>

        <p className="mt-8 flex items-center gap-2 text-eyebrow font-bold text-slate uppercase">
          <span aria-hidden className="size-[6px] rounded-full bg-signal-light" />
          {eyebrow}
        </p>

        <h1 className="mt-5 text-[clamp(34px,5vw,52px)] leading-[1.05] font-medium tracking-[-0.02em] text-balance">
          {title}
        </h1>

        {lead && (
          <p className="mt-6 max-w-2xl text-[19px] leading-[1.5] text-granite">{lead}</p>
        )}

        {updated && (
          <p className="mt-6 text-[14px] text-slate">Terakhir diperbarui {updated}</p>
        )}
      </header>

      <div className="prose-nusa max-w-2xl">{children}</div>
    </div>
  );
}

/**
 * Used on the four legal pages. PRD §14 Q4 lists legal review as an open item
 * owned by PM + Legal, so publishing these as finished policy would misstate
 * their status. Saying so plainly is the honest option.
 */
export function DraftNotice() {
  return (
    <div className="not-prose my-8 flex gap-3.5 rounded-stadium border border-clay/25 bg-clay/[0.05] px-6 py-5">
      <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-clay" strokeWidth={1.75} />
      <div>
        <p className="text-[16px] font-medium text-ink">
          Dokumen ini masih berstatus draf.
        </p>
        <p className="mt-1 text-[15px] leading-[1.45] text-granite">
          Naskah di bawah menjelaskan cara NusaPDF bekerja saat ini dan disusun sebagai
          bahan telaah hukum, bukan sebagai nasihat hukum atau dokumen final. Telaah oleh
          penasihat hukum masih berjalan sebelum NusaPDF dipakai secara komersial.
        </p>
      </div>
    </div>
  );
}

/** Pull-out box for a fact worth isolating from the flow of the prose. */
export function Callout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="not-prose my-8 rounded-stadium bg-lifted px-7 py-6 shadow-card">
      <p className="text-[17px] font-medium tracking-[-0.01em] text-ink">{title}</p>
      <div className="mt-2 text-[16px] leading-[1.5] text-granite">{children}</div>
    </div>
  );
}
