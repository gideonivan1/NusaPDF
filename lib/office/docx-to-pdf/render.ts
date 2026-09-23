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
  type PDFDocument,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import type { DocxImage } from './document';
import type { LaidOutPage, Layered } from './layout';

export type ImageConverter = (image: DocxImage) => Promise<{ data: Uint8Array; type: 'png' | 'jpg' } | null>;

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
): Promise<void> {
  const embedded = new Map<string, Promise<PDFImage | null>>();

  const imageFor = (key: string): Promise<PDFImage | null> => {
    let pending = embedded.get(key);
    if (!pending) {
      pending = (async () => {
        const image = images.get(key);
        if (!image) return null;
        try {
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
      page.drawText(op.text, { x: op.x, y: height - op.y, size: op.size, font: op.face.pdf, color: colour(op.color) });
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
      });
      return;

    case 'image': {
      const image = await imageFor(op.image);
      if (!image || op.w <= 0 || op.h <= 0) return;
      const crop = op.crop;
      if (!crop) {
        page.drawImage(image, { x: op.x, y: height - op.y - op.h, width: op.w, height: op.h });
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
      });
      page.pushOperators(popGraphicsState());
      return;
    }
  }
}
