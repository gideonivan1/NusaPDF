/**
 * Module resolve hook for the verification scripts.
 *
 * Node's ESM loader requires explicit file extensions and knows nothing about
 * the `@/*` path alias, both of which the application source relies on because
 * a bundler normally handles them. This bridges that gap so the scripts can
 * import application modules directly instead of duplicating their logic.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '.mjs', '.js'];

export async function resolve(specifier, context, nextResolve) {
  // `@/lib/foo` -> `<root>/lib/foo`
  if (specifier.startsWith('@/')) {
    const base = pathToFileURL(resolvePath(root, specifier.slice(2))).href;
    return tryCandidates(base, context, nextResolve);
  }

  // Extensionless relative import -> try the TypeScript source.
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
    const base = new URL(specifier, context.parentURL).href;
    return tryCandidates(base, context, nextResolve);
  }

  return nextResolve(specifier, context);
}

async function tryCandidates(base, context, nextResolve) {
  for (const suffix of ['', ...CANDIDATE_SUFFIXES]) {
    try {
      return await nextResolve(base + suffix, context);
    } catch {
      // Try the next candidate extension.
    }
  }
  return nextResolve(base, context);
}
