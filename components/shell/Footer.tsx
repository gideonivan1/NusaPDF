import Link from 'next/link';
import { ChevronDown, HelpCircle, LifeBuoy, MapPin, ShieldCheck } from 'lucide-react';
import { TOOLS } from '@/lib/tools';

const HELP_LINKS = [
  { label: 'Pusat bantuan', href: '/bantuan', icon: LifeBuoy },
  { label: 'Cara kerja privasi kami', href: '/privasi', icon: ShieldCheck },
  { label: 'Pertanyaan umum', href: '/faq', icon: HelpCircle },
  { label: 'Tentang NusaPDF', href: '/tentang', icon: MapPin },
];

export function Footer() {
  const organize = TOOLS.filter((t) => t.category === 'organize' || t.category === 'optimize');
  const convert = TOOLS.filter((t) => t.category === 'convert').slice(0, 6);

  return (
    <footer className="mt-32 bg-ink text-white">
      <div className="container-page pt-24 pb-32">
        <h2 className="max-w-2xl text-[clamp(32px,5vw,44px)] leading-[1.1] font-medium tracking-[-0.02em]">
          Kami selalu ada saat Anda membutuhkannya.
        </h2>

        <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          <FooterColumn title="ATUR & OPTIMASI">
            {organize.map((tool) => (
              <FooterLink key={tool.slug} href={tool.href} disabled={!tool.available}>
                {tool.name}
              </FooterLink>
            ))}
          </FooterColumn>

          <FooterColumn title="KONVERSI">
            {convert.map((tool) => (
              <FooterLink key={tool.slug} href={tool.href} disabled={!tool.available}>
                {tool.name}
              </FooterLink>
            ))}
          </FooterColumn>

          <FooterColumn title="BUTUH BANTUAN?">
            {HELP_LINKS.map((link) => (
              <FooterLink key={link.href} href={link.href} icon={<link.icon aria-hidden className="size-4 shrink-0" />}>
                {link.label}
              </FooterLink>
            ))}
          </FooterColumn>

          <FooterColumn title="LEGAL">
            <FooterLink href="/kebijakan-privasi">Kebijakan privasi</FooterLink>
            <FooterLink href="/ketentuan">Ketentuan layanan</FooterLink>
            <FooterLink href="/kuki">Kebijakan kuki</FooterLink>
            <FooterLink href="/pdp">Kepatuhan UU PDP</FooterLink>
          </FooterColumn>
        </div>

        <div className="mt-20 border-t border-white/30 pt-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <p className="text-[14px] text-white/70">
              © {new Date().getFullYear()} NusaPDF. Berkas Anda diproses di perangkat Anda.
            </p>

            <button
              type="button"
              className="inline-flex items-center gap-2 self-start rounded-pill border border-white/40 px-5 py-2.5 text-[14px] transition-colors hover:bg-white/10"
            >
              Indonesia — Bahasa Indonesia
              <ChevronDown aria-hidden className="size-4" />
            </button>
          </div>

          <p className="mt-8 flex items-center gap-2 text-[14px] text-white/70">
            <span aria-hidden className="size-[5px] rounded-full bg-signal-light" />
            Dibuat oleh Gideon Ivan
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[13px] leading-none font-bold tracking-[0.04em] text-white/60 uppercase">
        {title}
      </h3>
      <ul className="mt-5 flex flex-col gap-3.5">{children}</ul>
    </div>
  );
}

function FooterLink({
  href,
  children,
  icon,
  disabled,
}: {
  href: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
  disabled?: boolean;
}) {
  if (disabled) {
    return (
      <li className="flex items-center gap-2.5 text-[14px] font-normal text-white/40">
        {icon}
        <span>{children}</span>
        <span className="rounded-micro bg-white/10 px-1.5 py-0.5 text-[11px] tracking-wide">
          segera
        </span>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-2.5 rounded-micro text-[14px] font-normal text-white/85 transition-colors hover:text-white"
      >
        {icon}
        {children}
      </Link>
    </li>
  );
}
