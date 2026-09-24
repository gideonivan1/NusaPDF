/**
 * Draws laid-out pages with pdf-lib.
 *
 * Layout works top-down like a Word page; PDF is bottom-up, so every y is
 * flipped here and nowhere else. Operations draw in stacking order: objects
 * behind the text, the text layer, then objects in front — each group in the
 * order Word stacks them.
 */

import {
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSqueeze,
  type PDFDocument,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import type { DocxImage } from './document';
import type { LaidOutPage, Layered } from './layout';

export type ImageConverter = (image: DocxImage) => Promise<{ data: Uint8Array; type: 'png' | 'jpg' } | null>;

/**
 * Scales a picture down to about `width` × `height` pixels and re-encodes
 * it (an opaque one as JPEG), or returns null to keep it as it is. The
 * browser does this through <canvas>.
 */
export type ImageResampler = (image: DocxImage, width: number, height: number) => Promise<{ data: Uint8Array; type: 'png' | 'jpg' } | null>;

/**
 * Pixels per inch a picture keeps at the size it is shown — what Office's
 * own PDF export keeps by default. Anything sharper only makes the file big.
 */
const TARGET_PPI = 220;

/** A PNG this large is worth trying as JPEG. */
const HEAVY_PNG = 256 * 1024;

/** A PNG's pixel size, from its header. */
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function colour(hex: string | undefined) {
  const value = (hex ?? '#000000').replace('#', '');
  const channel = (index: number) => parseInt(value.slice(index, index + 2), 16) / 255;
  return rgb(channel(0) || 0, channel(2) || 0, channel(4) || 0);
}

export async function renderPages(
  pdf: PDFDocument,
  pages: LaidOutPage[],
  images: Map<string, DocxImage>,
  convert?: ImageConverter,
  onPage?: (index: number) => void,
  resample?: ImageResampler,
): Promise<void> {
  const embedded = new Map<string, Promise<PDFImage | null>>();

  // The largest size each picture is shown at, in points (a crop shows only
  // part of the whole picture, so the whole is larger).
  const shown = new Map<string, { w: number; h: number }>();
  for (const page of pages) {
    for (const { op } of page.ops) {
      if (op.kind !== 'image') continue;
      const w = op.w / Math.max(0.01, 1 - (op.crop?.left ?? 0) - (op.crop?.right ?? 0));
      const h = op.h / Math.max(0.01, 1 - (op.crop?.top ?? 0) - (op.crop?.bottom ?? 0));
      const known = shown.get(op.image);
      shown.set(op.image, { w: Math.max(known?.w ?? 0, w), h: Math.max(known?.h ?? 0, h) });
    }
  }

  const imageFor = (key: string): Promise<PDFImage | null> => {
    let pending = embedded.get(key);
    if (!pending) {
      pending = (async () => {
        const image = images.get(key);
        if (!image) return null;
        try {
          const size = shown.get(key);
          const pixels = image.type === 'png' ? pngSize(image.data) : null;
          if (resample && size && pixels) {
            const width = Math.ceil((size.w / 72) * TARGET_PPI);
            const height = Math.ceil((size.h / 72) * TARGET_PPI);
            // Worth it for pictures well over the target, and for heavy PNGs
            // that are opaque after all: Office's own export stores those as
            // JPEG (a 1.6 MB illustration became 80 KB).
            const oversized = pixels.width > width * 1.25 && pixels.height > height * 1.25;
            if (oversized || image.data.length > HEAVY_PNG) {
              const smaller = await resample(image, width, height);
              if (smaller) return smaller.type === 'png' ? await pdf.embedPng(smaller.data) : await pdf.embedJpg(smaller.data);
            }
          }
          if (image.type === 'png') return await pdf.embedPng(image.data);
          if (image.type === 'jpg') return await pdf.embedJpg(image.data);
          const converted = convert ? await convert(image) : null;
          if (!converted) return null;
          return converted.type === 'png' ? await pdf.embedPng(converted.data) : await pdf.embedJpg(converted.data);
        } catch {
          // A picture that cannot be decoded must not sink the document.
          return null;
        }
      })();
      embedded.set(key, pending);
    }
    return pending;
  };

  for (const [index, laidOut] of pages.entries()) {
    const page = pdf.addPage([laidOut.width, laidOut.height]);
    const ordered = laidOut.ops
      .map((layered, sequence) => ({ layered, sequence }))
      .sort((a, b) => a.layered.layer - b.layered.layer || a.layered.order - b.layered.order || a.sequence - b.sequence)
      .map((entry) => entry.layered);

    for (const layered of ordered) await draw(page, laidOut.height, layered, imageFor);
    onPage?.(index);
  }
}

async function draw(
  page: PDFPage,
  height: number,
  { op }: Layered,
  imageFor: (key: string) => Promise<PDFImage | null>,
): Promise<void> {
  switch (op.kind) {
    case 'text': {
      if (!op.text) return;
      // A look-alike font is stretched to the widths the text was set with.
      // So is kerned text, to the width it was set at.
      const target = op.width ?? (op.face.proxied ? op.face.width(op.text, op.size) : undefined);
      const drawn = target !== undefined ? op.face.drawnWidth(op.text, op.size) : 0;
      const squeeze = drawn > 0 && target !== undefined ? (target / drawn) * 100 : 100;
      if (Math.abs(squeeze - 100) > 0.01) page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze));
      page.drawText(op.text, { x: op.x, y: height - op.y, size: op.size, font: op.face.pdf, color: colour(op.color), opacity: op.opacity });
      if (Math.abs(squeeze - 100) > 0.01) page.pushOperators(popGraphicsState());
      return;
    }

    case 'rect':
      page.drawRectangle({
        x: op.x,
        y: height - op.y - op.h,
        width: op.w,
        height: op.h,
        color: op.fill ? colour(op.fill) : undefined,
        opacity: op.fillOpacity,
        borderColor: op.stroke ? colour(op.stroke) : undefined,
        borderWidth: op.stroke ? op.strokeWidth ?? 0.75 : undefined,
        borderOpacity: op.strokeOpacity,
      });
      return;

    case 'line':
      page.drawLine({
        start: { x: op.x1, y: height - op.y1 },
        end: { x: op.x2, y: height - op.y2 },
        thickness: op.width,
        color: colour(op.color),
        dashArray: op.dash,
      });
      return;

    case 'path':
      page.drawSvgPath(op.d, {
        x: 0,
        y: height,
        color: op.fill ? colour(op.fill) : undefined,
        opacity: op.fillOpacity,
        borderColor: op.stroke ? colour(op.stroke) : undefined,
        borderWidth: op.stroke ? op.strokeWidth ?? 0.75 : undefined,
        borderOpacity: op.strokeOpacity,
        borderDashArray: op.dash,
        borderLineCap: op.cap,
      });
      return;

    case 'image': {
      const image = await imageFor(op.image);
      if (!image || op.w <= 0 || op.h <= 0) return;
      const crop = op.crop;
      if (!crop) {
        page.drawImage(image, { x: op.x, y: height - op.y - op.h, width: op.w, height: op.h, opacity: op.opacity });
        return;
      }
      // Word crops by stretching the whole picture and showing a window of
      // it; the same with a clipping rectangle.
      const fullW = op.w / Math.max(0.01, 1 - crop.left - crop.right);
      const fullH = op.h / Math.max(0.01, 1 - crop.top - crop.bottom);
      page.pushOperators(pushGraphicsState(), rectangle(op.x, height - op.y - op.h, op.w, op.h), clip(), endPath());
      page.drawImage(image, {
        x: op.x - crop.left * fullW,
        y: height - (op.y - crop.top * fullH) - fullH,
        width: fullW,
        height: fullH,
        opacity: op.opacity,
      });
      page.pushOperators(popGraphicsState());
      return;
    }
  }
}
