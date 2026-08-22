/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import {
  degrees,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFNumber,
  type PDFRef,
} from 'pdf-lib';

/**
 * Heavy pdf-lib document surgery. Everything here runs off the main thread so
 * that merging twenty 100-page files never blocks interaction (PRD §13 US2).
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface MergeInput {
  /** Original file bytes. Transferred in; the worker owns them afterwards. */
  buffer: ArrayBuffer;
  /** 0-indexed pages to take, in the order they should appear. */
  pageIndices: number[];
  /** Extra rotation per included page, parallel to `pageIndices`. */
  rotations?: Rotation[];
}

export interface SplitOutput {
  fileName: string;
  bytes: Uint8Array;
}

export type CompressionLevel = 'ringan' | 'seimbang' | 'maksimal';

export interface CompressResult {
  bytes: Uint8Array;
  imagesRecompressed: number;
  /** True when the rebuilt file came out larger and we kept the original. */
  keptOriginal: boolean;
}

export interface ImageInput {
  buffer: ArrayBuffer;
  mimeType: string;
  fileName: string;
}

export interface ImagesToPdfOptions {
  pageSize: 'fit' | 'a4' | 'letter';
  orientation: 'auto' | 'portrait' | 'landscape';
  /** Margin in points (1pt = 1/72 inch). */
  margin: number;
}

type ProgressFn = (done: number, total: number) => void;

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };

/** Recompression budgets per level. Ref: PRD §13 US4 and risk R2. */
const COMPRESSION_PROFILE: Record<
  CompressionLevel,
  { quality: number; maxDimension: number }
> = {
  ringan: { quality: 0.82, maxDimension: 2400 },
  seimbang: { quality: 0.68, maxDimension: 1600 },
  maksimal: { quality: 0.5, maxDimension: 1100 },
};

function wrapLoadError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt/i.test(message)) throw new Error('E_ENCRYPTED');
  throw new Error(`E_CORRUPT:${message}`);
}

async function loadDocument(buffer: ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(buffer, {
      // Surface encrypted documents as an error rather than silently emitting a
      // broken file — the user needs to be told to unlock it first.
      ignoreEncryption: false,
      updateMetadata: false,
    });
  } catch (error) {
    wrapLoadError(error);
  }
}

/* ==========================================================================
   Merge
   ========================================================================== */

async function merge(inputs: MergeInput[], onProgress?: ProgressFn): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const totalPages = inputs.reduce((sum, input) => sum + input.pageIndices.length, 0);
  let done = 0;

  for (const input of inputs) {
    const source = await loadDocument(input.buffer);
    const copied = await out.copyPages(source, input.pageIndices);

    copied.forEach((page, i) => {
      const extra = input.rotations?.[i] ?? 0;
      if (extra !== 0) {
        // Preserve the page's own rotation instead of overwriting it.
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + extra) % 360));
      }
      out.addPage(page);
      onProgress?.(++done, totalPages);
    });
  }

  out.setProducer('NusaPDF');
  out.setCreator('NusaPDF');

  const bytes = await out.save({ useObjectStreams: true });
  return bytes;
}

/* ==========================================================================
   Split
   ========================================================================== */

async function split(
  buffer: ArrayBuffer,
  groups: number[][],
  baseName: string,
  onProgress?: ProgressFn,
): Promise<SplitOutput[]> {
  const source = await loadDocument(buffer);
  const outputs: SplitOutput[] = [];
  const pad = String(groups.length).length;

  for (const [index, pageIndices] of groups.entries()) {
    if (pageIndices.length === 0) continue;

    const out = await PDFDocument.create();
    const copied = await out.copyPages(source, pageIndices);
    copied.forEach((page) => out.addPage(page));
    out.setProducer('NusaPDF');

    // Name by the pages it actually contains — far easier to identify later
    // than a bare sequence number.
    const label =
      pageIndices.length === 1
        ? `hal-${pageIndices[0] + 1}`
        : `hal-${pageIndices[0] + 1}-${pageIndices[pageIndices.length - 1] + 1}`;

    outputs.push({
      fileName: `${baseName}_${String(index + 1).padStart(pad, '0')}_${label}.pdf`,
      bytes: await out.save({ useObjectStreams: true }),
    });

    onProgress?.(index + 1, groups.length);
  }

  return outputs;
}

/* ==========================================================================
   Compress
   ========================================================================== */

/**
 * Rebuilds embedded JPEG (DCTDecode) images at a lower resolution and quality.
 *
 * This is deliberately *not* a whole-page rasterisation: doing that would
 * shrink files far more but would destroy the text layer, and PRD §13 US4
 * requires text to stay selectable. Image-heavy PDFs — which are the ones that
 * are actually too large — still compress substantially.
 */
async function compress(
  buffer: ArrayBuffer,
  level: CompressionLevel,
  onProgress?: ProgressFn,
): Promise<CompressResult> {
  const originalSize = buffer.byteLength;
  // `PDFDocument.load` detaches nothing, but we keep a pristine copy so we can
  // fall back to the original if recompression turns out to be counterproductive.
  const original = new Uint8Array(buffer.slice(0));

  const doc = await loadDocument(buffer);
  const profile = COMPRESSION_PROFILE[level];

  const imageRefs: { ref: PDFRef; stream: PDFRawStream }[] = [];

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    // Only raw JPEG streams can be round-tripped safely through a canvas.
    // Flate-encoded bitmaps need colour-space handling we deliberately skip.
    if (object.dict.get(PDFName.of('Filter')) !== PDFName.of('DCTDecode')) continue;
    imageRefs.push({ ref, stream: object });
  }

  let recompressed = 0;

  for (const [index, { ref, stream }] of imageRefs.entries()) {
    onProgress?.(index, imageRefs.length);

    try {
      const source = stream.getContents();
      const bitmap = await createImageBitmap(
        new Blob([source as BlobPart], { type: 'image/jpeg' }),
      );

      // Images carrying a soft mask must keep their dimensions, otherwise the
      // mask and the image disagree in some viewers.
      const hasSMask = stream.dict.has(PDFName.of('SMask'));
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = hasSMask ? 1 : Math.min(1, profile.maxDimension / longest);

      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        bitmap.close();
        continue;
      }

      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: profile.quality,
      });
      const encoded = new Uint8Array(await blob.arrayBuffer());

      // Only accept a clear win; a marginal one is not worth the quality cost.
      if (encoded.byteLength >= source.byteLength * 0.9) continue;

      const dict = stream.dict;
      dict.set(PDFName.of('Width'), PDFNumber.of(width));
      dict.set(PDFName.of('Height'), PDFNumber.of(height));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));

      doc.context.assign(ref, PDFRawStream.of(dict, encoded));
      recompressed++;
    } catch {
      // A single unreadable image must never fail the whole document.
      continue;
    }
  }

  onProgress?.(imageRefs.length, imageRefs.length);

  doc.setProducer('NusaPDF');
  // Metadata strings can carry surprising amounts of bytes in exported files.
  doc.setTitle('');
  doc.setAuthor('');
  doc.setSubject('');
  doc.setKeywords([]);

  const bytes = await doc.save({ useObjectStreams: true });

  if (bytes.byteLength >= originalSize) {
    return { bytes: original, imagesRecompressed: recompressed, keptOriginal: true };
  }

  return { bytes, imagesRecompressed: recompressed, keptOriginal: false };
}

/* ==========================================================================
   Images -> PDF
   ========================================================================== */

async function imagesToPdf(
  images: ImageInput[],
  options: ImagesToPdfOptions,
  onProgress?: ProgressFn,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();

  for (const [index, image] of images.entries()) {
    let bytes = new Uint8Array(image.buffer);
    let mime = image.mimeType;

    // pdf-lib embeds JPEG and PNG only; anything else is transcoded first.
    if (mime !== 'image/jpeg' && mime !== 'image/png') {
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('E_UNKNOWN:OffscreenCanvas tidak tersedia');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      bytes = new Uint8Array(await blob.arrayBuffer());
      mime = 'image/jpeg';
    }

    const embedded =
      mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

    const isLandscape = embedded.width > embedded.height;

    let pageWidth: number;
    let pageHeight: number;

    if (options.pageSize === 'fit') {
      // Page hugs the image; margin expands the sheet rather than cropping.
      pageWidth = embedded.width + options.margin * 2;
      pageHeight = embedded.height + options.margin * 2;
    } else {
      const sheet = options.pageSize === 'a4' ? A4 : LETTER;
      const landscape =
        options.orientation === 'landscape' ||
        (options.orientation === 'auto' && isLandscape);
      pageWidth = landscape ? sheet.height : sheet.width;
      pageHeight = landscape ? sheet.width : sheet.height;
    }

    const page = doc.addPage([pageWidth, pageHeight]);

    const availableWidth = pageWidth - options.margin * 2;
    const availableHeight = pageHeight - options.margin * 2;
    const scale = Math.min(
      availableWidth / embedded.width,
      availableHeight / embedded.height,
      // Never upscale past native resolution — it only adds bytes and blur.
      options.pageSize === 'fit' ? 1 : Number.POSITIVE_INFINITY,
    );

    const drawWidth = embedded.width * scale;
    const drawHeight = embedded.height * scale;

    page.drawImage(embedded, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });

    onProgress?.(index + 1, images.length);
  }

  doc.setProducer('NusaPDF');
  return doc.save({ useObjectStreams: true });
}

/* ==========================================================================
   Inspect (page count without a full pdf.js load — used for queue rows)
   ========================================================================== */

async function countPages(buffer: ArrayBuffer): Promise<number> {
  const doc = await loadDocument(buffer);
  return doc.getPageCount();
}

const api = { merge, split, compress, imagesToPdf, countPages };

export type PdfWorkerApi = typeof api;

// Named exports let the pure document operations be exercised directly from
// Node in tests, without a Worker or a DOM.
export { merge, split, compress, imagesToPdf, countPages };

// Only wire up Comlink when actually running inside a worker. Importing this
// module in Node (tests, tooling) would otherwise throw on the missing
// `postMessage` endpoint.
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  Comlink.expose(api);
}
