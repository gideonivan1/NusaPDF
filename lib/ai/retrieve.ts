import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embed';
import type { RetrievedChunk } from './gemini';

/** How many passages to put in front of the model. */
const MATCH_COUNT = 10;
const MIN_SIMILARITY = 0.25;
/** Guard so a pathological set of chunks cannot blow up the prompt. */
const MAX_CONTEXT_CHARS = 14_000;

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  /** Pages the model is permitted to cite, derived from what it actually saw. */
  allowedPages: Set<number>;
}

export async function retrieveContext(
  supabase: SupabaseClient,
  documentIds: string[],
  question: string,
): Promise<RetrievalResult> {
  const embedding = await embedQuery(question);

  const { data, error } = await supabase.rpc('match_document_chunks', {
    query_embedding: embedding,
    target_document_ids: documentIds,
    match_count: MATCH_COUNT,
    min_similarity: MIN_SIMILARITY,
  });

  if (error) throw new Error(`Retrieval gagal: ${error.message}`);

  const rows = (data ?? []) as {
    page_number: number;
    content: string;
    similarity: number;
  }[];

  const chunks: RetrievedChunk[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (const row of rows) {
    if (row.content.length > budget) break;
    budget -= row.content.length;
    chunks.push({
      pageNumber: row.page_number,
      content: row.content,
      similarity: row.similarity,
    });
  }

  // Reading order beats relevance order once the set is chosen: passages that
  // follow the document's own sequence are easier for the model to narrate.
  chunks.sort((a, b) => a.pageNumber - b.pageNumber);

  return {
    chunks,
    allowedPages: new Set(chunks.map((chunk) => chunk.pageNumber)),
  };
}
