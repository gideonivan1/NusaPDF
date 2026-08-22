'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const PRIMARY_LINKS = [
  { href: '/#perkakas', label: 'Semua alat' },
  { href: '/merge', label: 'Gabung' },
  { href: '/split', label: 'Pisah' },
  { href: '/compress', label: 'Kompres' },
  { href: '/ai-pdf', label: 'AI PDF' },
] as const;

export function NavPill() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the overlay on navigation; otherwise it stays open behind the new page.
  useEffect(() => setOpen(false), [pathname]);

  // The overlay is a full-screen layer, so the page behind it must not scroll.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* The pill floats 24px below the viewport top and never touches y=0. */}
      <header className="fixed inset-x-0 top-6 z-50 px-4 md:px-6">
        <nav
          aria-label="Navigasi utama"
          className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between rounded-pill bg-white/90 pr-3 pl-6 shadow-nav backdrop-blur-md md:pr-4 md:pl-8"
        >
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-pill"
            aria-label="NusaPDF, ke beranda"
          >
            <BrandMark />
            <span className="text-[17px] font-medium tracking-[-0.02em]">NusaPDF</span>
          </Link>

          <ul className="hidden items-center gap-9 lg:flex">
            {PRIMARY_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'rounded-pill text-[16px] leading-none tracking-[-0.03em] transition-colors',
                      active ? 'font-medium text-ink' : 'text-granite hover:text-ink',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="flex items-center gap-2">
            <Link
              href="/ai-pdf"
              className="hidden items-center gap-2 rounded-btn border-[1.5px] border-ink bg-ink px-5 py-2.5 text-[15px] font-medium tracking-[-0.02em] text-canvas transition-transform active:scale-[0.98] sm:inline-flex"
            >
              <Sparkles aria-hidden className="size-4" />
              Coba AI PDF
            </Link>

            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
              aria-controls="menu-seluler"
              className="grid size-12 place-items-center rounded-pill text-ink transition-colors hover:bg-canvas lg:hidden"
            >
              {open ? <X aria-hidden className="size-5" /> : <Menu aria-hidden className="size-5" />}
              <span className="sr-only">{open ? 'Tutup menu' : 'Buka menu'}</span>
            </button>
          </div>
        </nav>
      </header>

      {/* Mobile: same pill language, expanded into a full-screen overlay. */}
      {open && (
        <div
          id="menu-seluler"
          className="fixed inset-0 z-40 flex flex-col justify-center bg-canvas px-8 lg:hidden"
        >
          <ul className="flex flex-col gap-2">
            {PRIMARY_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="block rounded-stadium px-4 py-4 text-[32px] leading-tight font-medium tracking-[-0.02em] transition-colors hover:bg-lifted"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href="/ai-pdf"
            className="mt-8 inline-flex items-center justify-center gap-2 self-start rounded-btn bg-ink px-7 py-3.5 font-medium text-canvas"
          >
            <Sparkles aria-hidden className="size-4" />
            Coba AI PDF
          </Link>
        </div>
      )}
    </>
  );
}

/**
 * The brand mark.
 *
 * A static JPEG, so next/image is the right tool: the source is 1856px square
 * and displays at 36px, and the optimiser resizes and re-encodes it to modern
 * formats rather than shipping the full-size original on every page.
 */
function BrandMark() {
  return (
    <Image
      src="/nusapdf-logo.jpeg"
      alt=""
      width={36}
      height={36}
      // Above the fold on every page, so never defer it.
      priority
      className="size-9 rounded-full object-cover"
    />
  );
}
