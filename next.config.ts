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

  /**
   * Force the pdf.js worker into the deployed function bundle.
   *
   * `pdf.mjs` reaches its worker through a dynamic import that dependency
   * tracing cannot see, so the traced output contained `pdf.mjs` but not
   * `pdf.worker.mjs`. Locally that is invisible because the whole node_modules
   * tree is on disk; on Vercel the function only receives what tracing found,
   * and opening any document failed with:
   *
   *   Setting up fake worker failed: "Cannot find module
   *   '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'"
   *
   * Verifiable without deploying: after a build, the trace at
   * `.next/server/app/api/documents/[id]/ingest/route.js.nft.json` must list
   * the worker.
   */
  outputFileTracingIncludes: {
    /**
     * Keys are globs, which is why the literal route path
     * `/api/documents/[id]/ingest` silently matched nothing: in glob syntax
     * `[id]` is a character class meaning "one of i or d", not the folder name.
     * A wildcard segment avoids that entirely.
     *
     * Kept narrow on purpose — `/api/**` also worked, but it copied the 2.3 MB
     * worker and its 5.2 MB source map into all six API functions when only
     * this one ever loads pdf.js.
     */
    '/api/documents/*/ingest': ['./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'],
  },

  // Tracing also follows the worker's `sourceMappingURL` and pulls in a 5.2 MB
  // map that is never read at runtime. `outputFileTracingExcludes` does not
  // remove it — excludes appear not to apply to files brought in by an include
  // — so it rides along. At ~7.5 MB total in a single function this is well
  // inside Vercel's limit, and dead config that silently does nothing would be
  // more misleading than the wasted bytes.

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
