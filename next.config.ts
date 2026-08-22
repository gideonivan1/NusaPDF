import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  /**
   * Keep pdfjs-dist out of the server bundle.
   *
   * The legacy build (used by lib/ai/extract.ts for RAG text extraction)
   * resolves its own worker through a dynamic import relative to its module
   * path. Once the bundler rewrites that module into a chunk, the import
   * points at a chunk directory where `pdf.worker.mjs` does not exist, and
   * pdf.js fails with "Setting up fake worker failed". Leaving it external
   * lets Node resolve it from node_modules exactly as it does outside Next.
   */
  serverExternalPackages: ['pdfjs-dist'],

  // pdfjs-dist tries to resolve the optional native `canvas` package when it
  // thinks it is running under Node. NusaPDF only ever renders PDFs in the
  // browser (main thread or Web Worker), so stub it out rather than shipping it.
  turbopack: {
    resolveAlias: {
      canvas: './lib/pdf/canvas-stub.ts',
    },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
