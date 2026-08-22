import type { Metadata, Viewport } from 'next';
import { Sofia_Sans } from 'next/font/google';
import { NavPill } from '@/components/shell/NavPill';
import { Footer } from '@/components/shell/Footer';
import './globals.css';

/**
 * Sofia Sans is the closest open-source stand-in for MarkForMC and is already
 * in Mastercard's own fallback stack (PRD §6). It is variable across 1–1000,
 * which is what makes the load-bearing `font-weight: 450` render as a true
 * intermediate weight rather than snapping to 400 or 500.
 */
const sofiaSans = Sofia_Sans({
  subsets: ['latin'],
  variable: '--font-sofia',
  display: 'swap',
  // Intentionally no `weight` list: that would pin static cuts, and
  // `next/font` rejects 450 as a named weight. Omitting it loads the variable
  // font across the whole wght axis, which is exactly what makes 450 real.
});

export const metadata: Metadata = {
  metadataBase: new URL('https://nusapdf.id'),
  title: {
    default: 'NusaPDF — Perkakas PDF yang memproses di perangkat Anda',
    template: '%s · NusaPDF',
  },
  description:
    'Gabung, pisah, kompres, dan konversi PDF langsung di peramban — berkas Anda tidak pernah meninggalkan perangkat. Lengkap dengan asisten AI untuk membaca dokumen panjang.',
  openGraph: {
    type: 'website',
    locale: 'id_ID',
    siteName: 'NusaPDF',
  },
};

export const viewport: Viewport = {
  themeColor: '#F3F0EE',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className={sofiaSans.variable}>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <a
          href="#konten"
          className="sr-only-focusable z-100 top-4 left-4 rounded-btn bg-ink px-6 py-3 text-canvas"
        >
          Lompat ke konten utama
        </a>

        <NavPill />

        <main id="konten" className="pt-28 md:pt-32">
          {children}
        </main>

        <Footer />
      </body>
    </html>
  );
}
