/**
 * Generates the favicon set from the brand image.
 *
 * The source is 1856px square and ~159 KB. Next serves files in `app/icon.*`
 * verbatim — it does not resize them — so shipping the original would mean a
 * 159 KB favicon fetched on every page for something displayed at 16px.
 *
 * sharp comes with Next (it powers next/image), so no extra dependency.
 *
 * Run: npm run icons
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'public/nusapdf-logo.jpeg');

const targets = [
  // Browser tab. 96px covers 1x through 3x displays at 32px.
  { file: 'app/icon.png', size: 96 },
  // Home-screen icon on iOS, which wants a larger, opaque square.
  { file: 'app/apple-icon.png', size: 180 },
];

for (const { file, size } of targets) {
  const out = resolve(root, file);
  await mkdir(dirname(out), { recursive: true });

  const info = await sharp(source)
    .resize(size, size, { fit: 'cover' })
    // The source is a photo-style JPEG; PNG keeps edges crisp at small sizes.
    .png({ compressionLevel: 9 })
    .toFile(out);

  console.log(`[nusapdf] ${file.padEnd(22)} ${size}x${size}  ${(info.size / 1024).toFixed(1)} KB`);
}
