'use client';

import * as Comlink from 'comlink';
import { NusaError, type ErrorCode } from '@/lib/errors';
import type {
  CompressionLevel,
  CompressResult,
  ImageInput,
  ImagesToPdfOptions,
  MergeInput,
  PdfWorkerApi,
  Rotation,
  SplitOutput,
} from './worker';

export type { CompressionLevel, Rotation, SplitOutput, ImagesToPdfOptions };

let worker: Worker | null = null;
let api: Comlink.Remote<PdfWorkerApi> | null = null;

function getApi(): Comlink.Remote<PdfWorkerApi> {
  if (!api) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'nusapdf-engine',
    });
    api = Comlink.wrap<PdfWorkerApi>(worker);
  }
  return api;
}

/**
 * Terminates the engine mid-operation. pdf-lib has no cancellation hooks, so
 * killing the worker is the only way to honour the cancel button within the
 * one-second budget in PRD §13 US10. The next call spins up a fresh one.
 */
export function terminateEngine(): void {
  worker?.terminate();
  worker = null;
  api = null;
}

/**
 * The worker communicates failures as message strings (`E_ENCRYPTED`,
 * `E_CORRUPT:detail`) because Error subclasses do not survive structured
 * cloning. This puts them back into the typed error the UI expects.
 */
function rethrow(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const [code, ...rest] = message.split(':');

  const known: ErrorCode[] = [
    'E_ENCRYPTED',
    'E_CORRUPT',
    'E_TOO_LARGE',
    'E_OOM',
    'E_UNSUPPORTED_TYPE',
    'E_CANCELED',
    'E_UNKNOWN',
  ];

  if (known.includes(code as ErrorCode)) {
    throw new NusaError(code as ErrorCode, rest.join(':') || undefined);
  }
  if (/out of memory|allocation failed/i.test(message)) {
    throw new NusaError('E_OOM');
  }
  throw new NusaError('E_UNKNOWN', message);
}

export type ProgressCallback = (done: number, total: number) => void;

export async function mergePdfs(
  inputs: MergeInput[],
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    return await getApi().merge(
      Comlink.transfer(
        inputs,
        inputs.map((input) => input.buffer),
      ),
      onProgress ? Comlink.proxy(onProgress) : undefined,
    );
  } catch (error) {
    rethrow(error);
  }
}

export async function splitPdf(
  buffer: ArrayBuffer,
  groups: number[][],
  baseName: string,
  onProgress?: ProgressCallback,
): Promise<SplitOutput[]> {
  try {
    return await getApi().split(
      Comlink.transfer(buffer, [buffer]),
      groups,
      baseName,
      onProgress ? Comlink.proxy(onProgress) : undefined,
    );
  } catch (error) {
    rethrow(error);
  }
}

export async function compressPdf(
  buffer: ArrayBuffer,
  level: CompressionLevel,
  onProgress?: ProgressCallback,
): Promise<CompressResult> {
  try {
    return await getApi().compress(
      Comlink.transfer(buffer, [buffer]),
      level,
      onProgress ? Comlink.proxy(onProgress) : undefined,
    );
  } catch (error) {
    rethrow(error);
  }
}

export async function imagesToPdf(
  images: ImageInput[],
  options: ImagesToPdfOptions,
  onProgress?: ProgressCallback,
): Promise<Uint8Array> {
  try {
    return await getApi().imagesToPdf(
      Comlink.transfer(
        images,
        images.map((image) => image.buffer),
      ),
      options,
      onProgress ? Comlink.proxy(onProgress) : undefined,
    );
  } catch (error) {
    rethrow(error);
  }
}

export async function countPdfPages(buffer: ArrayBuffer): Promise<number> {
  try {
    return await getApi().countPages(Comlink.transfer(buffer, [buffer]));
  } catch (error) {
    rethrow(error);
  }
}
