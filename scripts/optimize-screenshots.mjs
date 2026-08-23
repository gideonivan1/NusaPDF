/**
 * Optimises the README screenshots in docs/.
 *
 * Raw captures are 2x-density PNGs of several hundred KB or more, and images
 * committed to a repository are downloaded by everyone who clones it — not just
 * by people who read the README. Shrinking them is worth a build step.
 *
 * Settings were chosen by measuring this project's own screenshot rather than
 * by habit:
 *
 *   png level 9      323 KB
 *   png palette q90  105 KB  <- chosen
 *   png palette q80   92 KB
 *   webp q88          75 KB
 *
 * WebP is smallest, but 30 KB is not worth depending on every renderer and
 * mirror supporting it. Palette quality stays at 90 because the home page has
 * radial-gradient circles, and quantising harder makes those band visibly.
 *
 * Run: npm run optimize:screenshots
 */
import { readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docs = resolve(root, 'docs');

/** GitHub renders READMEs at ~900px, so 1800 gives 2x crispness and no more. */
const TARGET_WIDTH = 1800;

let files;
try {
  files = (await readdir(docs)).filter((name) => extname(name).toLowerCase() === '.png');
} catch {
  console.log('[nusapdf] docs/ belum ada — tidak ada yang dioptimasi.');
  process.exit(0);
}

if (files.length === 0) {
  console.log('[nusapdf] Tidak ada PNG di docs/.');
  process.exit(0);
}

for (const name of files) {
  const path = join(docs, name);
  const before = (await stat(path)).size;

  const image = sharp(path);
  const meta = await image.metadata();

  const optimised = await image
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
    // Screenshots have no meaningful transparency, and an alpha channel costs
    // 25% of the pixel data. Flattening onto the canvas colour keeps any
    // rounded corners looking intentional rather than black.
    .flatten({ background: '#F3F0EE' })
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toBuffer();

  // Never write a "optimised" file that is larger than what came in.
  if (optimised.length >= before) {
    console.log(`[nusapdf] ${name}: sudah optimal (${(before / 1024).toFixed(0)} KB), dilewati`);
    continue;
  }

  await writeFile(path, optimised);

  const after = (await stat(path)).size;
  const saved = (100 - (after / before) * 100).toFixed(0);
  console.log(
    `[nusapdf] ${name}: ${meta.width}x${meta.height} ${(before / 1024).toFixed(0)} KB ` +
      `-> ${TARGET_WIDTH}px ${(after / 1024).toFixed(0)} KB (-${saved}%)`,
  );
}
