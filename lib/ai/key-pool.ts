import { GoogleGenAI } from '@google/genai';

/**
 * A rotating pool of Gemini API keys with automatic failover.
 *
 * Free-tier Gemini keys carry both per-minute and per-day limits. With a single
 * key, hitting either one takes AI PDF down entirely. The pool keeps up to four
 * keys and moves to the next as soon as one reports exhaustion, so a spent
 * primary key degrades throughput instead of availability.
 *
 * State is per server instance and held in memory. On a serverless platform
 * each instance therefore learns the exhausted set independently — the cost of
 * that is a single wasted request per instance per key, which is far cheaper
 * than a round trip to shared storage on every call.
 */

export interface KeySlot {
  label: string;
  apiKey: string;
  /** Epoch ms until which this key is considered spent. */
  cooldownUntil: number;
  lastError: string | null;
  successes: number;
  failures: number;
}

/** Per-minute rate limits clear quickly; daily quotas do not. */
const COOLDOWN_RATE_LIMIT_MS = 90_000;
const COOLDOWN_DAILY_MS = 3 * 60 * 60 * 1000;

let pool: KeySlot[] | null = null;
/** Round-robin cursor so load spreads instead of always starting at key 1. */
let cursor = 0;

function buildPool(): KeySlot[] {
  const slots: KeySlot[] = [];

  const candidates: { label: string; value: string | undefined }[] = [
    { label: 'GEMINI_API_KEY', value: process.env.GEMINI_API_KEY },
    { label: 'GEMINI_API_KEY_2', value: process.env.GEMINI_API_KEY_2 },
    { label: 'GEMINI_API_KEY_3', value: process.env.GEMINI_API_KEY_3 },
    { label: 'GEMINI_API_KEY_4', value: process.env.GEMINI_API_KEY_4 },
  ];

  const seen = new Set<string>();

  for (const candidate of candidates) {
    const apiKey = candidate.value?.trim();
    if (!apiKey || seen.has(apiKey)) continue;
    // Sloppy env templating turns a missing value into the literal strings
    // below. Such a "key" fails every request and would otherwise consume a
    // failover attempt on each call.
    if (apiKey === 'undefined' || apiKey === 'null') continue;
    seen.add(apiKey);
    slots.push({
      label: candidate.label,
      apiKey,
      cooldownUntil: 0,
      lastError: null,
      successes: 0,
      failures: 0,
    });
  }

  return slots;
}

export function getPool(): KeySlot[] {
  pool ??= buildPool();
  return pool;
}

export function hasAnyKey(): boolean {
  return getPool().length > 0;
}

/** Clears memoised state — used by tests and after an env change in dev. */
export function resetPool(): void {
  pool = null;
  cursor = 0;
}

const clients = new Map<string, GoogleGenAI>();

function clientFor(slot: KeySlot): GoogleGenAI {
  let client = clients.get(slot.apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey: slot.apiKey });
    clients.set(slot.apiKey, client);
  }
  return client;
}

/**
 * Distinguishes "this key is spent" from "this request was bad".
 * Only the former should trigger failover — retrying a malformed request
 * against all four keys would burn the whole pool on a client mistake.
 */
export function isQuotaError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 429) return true;

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    message.includes('resource_exhausted') ||
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429')
  );
}

/**
 * Model-side overload (503 UNAVAILABLE, "experiencing high demand").
 *
 * Distinct from a quota error: the key is fine, the model is busy. Rotating to
 * another key would not help — the same model is busy for every key — so the
 * right response is a short retry on the same key rather than burning the pool.
 */
export function isOverloadError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (status === 503) return true;

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    message.includes('unavailable') ||
    message.includes('high demand') ||
    message.includes('overloaded') ||
    message.includes('"code": 503') ||
    message.includes('"code":503')
  );
}

/** Retries for an overloaded model, on the same key. */
const OVERLOAD_ATTEMPTS = 3;
const OVERLOAD_BACKOFF_MS = [400, 1200];

function cooldownFor(error: unknown): number {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const daily =
    message.includes('per day') ||
    message.includes('perday') ||
    message.includes('daily limit') ||
    message.includes('generaterequestsperdayperproject');
  return daily ? COOLDOWN_DAILY_MS : COOLDOWN_RATE_LIMIT_MS;
}

export class AllKeysExhaustedError extends Error {
  // Written out rather than declared as a constructor parameter property:
  // Node's type-stripping loader rejects that syntax, and the verification
  // script imports this module directly.
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Seluruh ${attempts} kunci Gemini sedang tidak tersedia`);
    this.name = 'AllKeysExhaustedError';
    this.attempts = attempts;
  }
}

export class NoKeyConfiguredError extends Error {
  constructor() {
    super('Tidak ada GEMINI_API_KEY yang dikonfigurasi');
    this.name = 'NoKeyConfiguredError';
  }
}

/**
 * Runs `task` against the first available key, failing over on quota errors.
 *
 * Keys already in cooldown are skipped, but if every key is cooling down the
 * pool tries them anyway rather than failing outright — a cooldown is an
 * estimate, and an optimistic retry beats a certain error.
 */
async function attemptWithOverloadRetry<T>(run: () => Promise<T>): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < OVERLOAD_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isOverloadError(error) || attempt === OVERLOAD_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, OVERLOAD_BACKOFF_MS[attempt] ?? 1200));
    }
  }

  throw lastError;
}

export async function withGeminiKey<T>(
  task: (client: GoogleGenAI, slot: KeySlot) => Promise<T>,
): Promise<T> {
  const slots = getPool();
  if (slots.length === 0) throw new NoKeyConfiguredError();

  const now = Date.now();
  const start = cursor % slots.length;
  cursor = (cursor + 1) % slots.length;

  const ordered = Array.from({ length: slots.length }, (_, i) => slots[(start + i) % slots.length]);
  const available = ordered.filter((slot) => slot.cooldownUntil <= now);
  const attempts = available.length > 0 ? available : ordered;

  let lastError: unknown = null;

  for (const slot of attempts) {
    try {
      // Retries here cover model overload only, and only while opening the
      // call — no output has reached the user yet, so a retry cannot duplicate
      // text they already read.
      const result = await attemptWithOverloadRetry(() => task(clientFor(slot), slot));
      slot.successes++;
      slot.cooldownUntil = 0;
      slot.lastError = null;
      return result;
    } catch (error) {
      lastError = error;

      if (isOverloadError(error)) {
        // Retries are spent and the model is still busy. Not this key's fault,
        // so leave its cooldown alone and let the caller surface it.
        throw error;
      }

      if (!isQuotaError(error)) {
        // A bad request will fail identically on every key.
        throw error;
      }

      slot.failures++;
      slot.lastError = error instanceof Error ? error.message : String(error);
      slot.cooldownUntil = Date.now() + cooldownFor(error);
    }
  }

  throw lastError instanceof Error && !isQuotaError(lastError)
    ? lastError
    : new AllKeysExhaustedError(attempts.length);
}

/** Diagnostics for an ops endpoint — never exposes the key material itself. */
export function poolStatus() {
  const now = Date.now();
  return getPool().map((slot) => ({
    label: slot.label,
    available: slot.cooldownUntil <= now,
    cooldownSeconds: Math.max(0, Math.ceil((slot.cooldownUntil - now) / 1000)),
    successes: slot.successes,
    failures: slot.failures,
    lastError: slot.lastError,
  }));
}
