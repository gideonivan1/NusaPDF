/** Shared AI-module types. Mirrors the tables in PRD §8. */

export type PlanTier = 'anonymous' | 'free' | 'pro';

export type DocumentStatus =
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'expired';

export interface AiDocument {
  id: string;
  fileName: string;
  sizeBytes: number;
  pageCount: number | null;
  hasTextLayer: boolean | null;
  status: DocumentStatus;
  errorCode: string | null;
  createdAt: string;
}

export interface Citation {
  pageNumber: number;
  documentId?: string;
  snippet?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[] | null;
  createdAt: string;
  /** Client-only: true while the answer is still arriving. */
  streaming?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  documentIds: string[];
  messageCount: number;
  lastMessageAt: string;
}

export interface QuotaView {
  messagesRemaining: number;
  documentsRemaining: number;
  resetsAt: string;
  plan: PlanTier;
}
