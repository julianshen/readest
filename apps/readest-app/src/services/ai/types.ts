import type { LanguageModel, EmbeddingModel } from 'ai';

export type AIProviderName = 'ollama' | 'ai-gateway' | 'openrouter' | 'openai';

export interface AIProvider {
  id: AIProviderName;
  name: string;
  requiresAuth: boolean;

  getModel(): LanguageModel;
  getEmbeddingModel(): EmbeddingModel;

  isAvailable(): Promise<boolean>;
  healthCheck(): Promise<boolean>;
}

export interface AISettings {
  enabled: boolean;
  provider: AIProviderName;

  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbeddingModel: string;

  aiGatewayApiKey?: string;
  aiGatewayModel?: string;
  aiGatewayCustomModel?: string;
  aiGatewayEmbeddingModel?: string;

  // Generic OpenAI-compatible endpoint (OpenRouter, Together, Groq, vLLM, ...).
  // Defaults to OpenRouter; distinct from the dedicated `openai*` block below,
  // which is reserved for the user's own OpenAI (or Azure OpenAI) account.
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
  openrouterModel?: string;
  openrouterEmbeddingModel?: string;

  // OpenAI's official API (or any deployment exposing the same schema, e.g.
  // Azure OpenAI / a proxy) — distinct from the generic `openrouter*` fields
  // so translation can use OpenAI even when the assistant uses another
  // provider. API key only; ChatGPT OAuth is deliberately out of scope.
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiEmbeddingModel?: string;

  spoilerProtection: boolean;
  maxContextChunks: number;
  indexingMode: 'on-demand' | 'background';

  /**
   * Output language for AI summaries/recap and selected-text Explain/Define.
   * `book` (default) uses the book's language; `app` uses the UI language.
   * Selected-text "Simplify" always uses the book's language regardless.
   */
  answerLanguage?: 'book' | 'app';

  /**
   * Reedy MVP retrieval (Turso vector + Tantivy FTS + CFI citations).
   * MVP is desktop-only — the runtime gate in `selectBackend()` enforces
   * isTauri() regardless of this flag. UI in M1.8 disables the toggle on web.
   */
  reedy?: {
    enabled: boolean;
    /**
     * 'mvp' (default) keeps the Phase 1B path: lookupPassage tool wired
     * through @assistant-ui/react's adapter. 'agent' switches the
     * notebook AI tab to the Phase 4 ReedyAssistant (custom AgentRuntime
     * + thread UI). Requires `reedy.enabled && isTauri() &&
     * runtime === 'agent'` to engage.
     */
    runtime?: 'mvp' | 'agent';
  };
}

export interface TextChunk {
  id: string;
  bookHash: string;
  sectionIndex: number;
  chapterTitle: string;
  text: string;
  embedding?: number[];
  pageNumber: number; // page number using Readest's 1500 chars/page formula
}

export interface ScoredChunk extends TextChunk {
  score: number;
  searchMethod: 'bm25' | 'vector' | 'hybrid';
}

export interface BookIndexMeta {
  bookHash: string;
  bookTitle: string;
  authorName: string;
  totalSections: number;
  totalChunks: number;
  embeddingModel: string;
  lastUpdated: number;
}

export interface IndexingState {
  bookHash: string;
  status: 'idle' | 'indexing' | 'complete' | 'error';
  progress: number;
  chunksProcessed: number;
  totalChunks: number;
  error?: string;
}

export interface EmbeddingProgress {
  current: number;
  total: number;
  phase: 'chunking' | 'embedding' | 'indexing';
}

// stored AI conversation for a book
export interface AIConversation {
  id: string;
  bookHash: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

// single message in an AI conversation
export interface AIMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export interface ChapterSummary {
  /** `${bookHash}:${sectionIndex}` */
  key: string;
  bookHash: string;
  sectionIndex: number;
  /** hash of the section text — invalidates when content changes */
  contentHash: string;
  summary: string;
  createdAt: number;
}
