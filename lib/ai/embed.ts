import 'server-only';
import { withGeminiKey } from './key-pool';

/**
 * Embedding generation for the RAG index.
 *
 * Every call goes through the key pool, so a spent key fails over rather than
 * failing the ingest. Indexing a large document is the most quota-hungry thing
 * NusaPDF does, which is precisely where the pool earns its keep.
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

/** Keeps each request comfortably under the API's per-call payload ceiling. */
export const BATCH_SIZE = 32;

/**
 * How many batches are in flight at once.
 *
 * Measured cost is ~1.8s per batch and almost all of it is the round trip, not
 * computation — so running batches sequentially left the connection idle most
 * of the time and made indexing the single slowest thing in the app. Three
 * concurrent batches cut that roughly threefold while staying well inside the
 * free tier's per-minute request limit; the key pool absorbs a 429 by rotating
 * keys if it ever does trip.
 */
export const EMBED_CONCURRENCY = 3;

/**
 * Asymmetric retrieval: documents and queries are embedded with different task
 * types so a question lands near the passages that *answer* it rather than near
 * passages that merely resemble a question.
 */
type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

async function embedBatch(texts: string[], taskType: TaskType): Promise<number[][]> {
  return withGeminiKey(async (client) => {
    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Embedding tidak lengkap: diminta ${texts.length}, diterima ${embeddings.length}`,
      );
    }

    return embeddings.map((embedding) => {
      const values = embedding.values;
      if (!values || values.length === 0) throw new Error('Embedding kosong dari Gemini');
      return normalise(values);
    });
  });
}

/**
 * gemini-embedding-001 only returns unit-normalised vectors at its native
 * dimensionality. Once truncated to 768 the norm drifts, which skews cosine
 * distance — so renormalise before storing.
 */
function normalise(values: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += value * value;

  const magnitude = Math.sqrt(sumOfSquares);
  if (magnitude === 0) return values;

  return values.map((value) => value / magnitude);
}

export async function embedDocuments(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const batches: string[][] = [];
  for (let index = 0; index < texts.length; index += BATCH_SIZE) {
    batches.push(texts.slice(index, index + BATCH_SIZE));
  }

  // Results are written back by index, so concurrency never reorders vectors
  // relative to their chunks — a silent misalignment there would make every
  // citation point at the wrong page.
  const results: number[][][] = new Array(batches.length);
  let next = 0;
  let completed = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= batches.length) return;

      results[index] = await embedBatch(batches[index], 'RETRIEVAL_DOCUMENT');

      completed += batches[index].length;
      onProgress?.(completed, texts.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, worker),
  );

  return results.flat();
}

export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text], 'RETRIEVAL_QUERY');
  return embedding;
}
