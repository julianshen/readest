import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { embed } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings, EmbeddingProgress, ScoredChunk } from '../types';
import type { BackendIndexOptions, RetrievalBackend } from './retrievalBackend';
import {
  getAIProvider,
  getEmbeddingModelId,
  getEmbeddingBaseUrl,
  getEmbeddingApiKey,
} from '../providers';
import { chunkSection, extractTextFromDocument } from '@/services/ai/utils/chunker';
import { getChapterTitle } from '@/services/ai/ragService';

interface IndexChunkInput {
  sectionIndex: number;
  chapterTitle: string;
  text: string;
  pageNumber: number;
}

/**
 * Tauri Rust backend for AI book indexing and search.
 * Chunks the book in JS (uses existing chunker with browser APIs), then
 * sends the chunks to Rust for embedding (HTTP to AI provider) and
 * storage (SQLite with FTS5 for BM25 + BLOB for float32 embeddings).
 * Search is done entirely in Rust with SIMD-accelerated dot-product
 * and FTS5 BM25 merged via reciprocal rank fusion.
 */
export class TauriRustBackend implements RetrievalBackend {
  readonly kind = 'tauri-rust' as const;

  constructor(private readonly settings: AISettings) {}

  async isIndexed(bookHash: string): Promise<boolean> {
    return invoke<boolean>('is_book_indexed', { bookHash });
  }

  async indexBook(
    bookDoc: BookDoc,
    bookHash: string,
    options?: BackendIndexOptions,
  ): Promise<void> {
    const chunks = await this.chunkBook(bookDoc, bookHash);
    options?.onProgress?.({
      current: 0,
      total: chunks.length,
      phase: 'embedding',
    });

    // Listen for progress events from Rust
    const unlisten = await listen<EmbeddingProgress>('index-progress', (event) => {
      const p = event.payload;
      options?.onProgress?.({
        current: p.current,
        total: p.total,
        phase: p.phase as EmbeddingProgress['phase'],
      });
    });

    try {
      const embedConfig = {
        apiKey: getEmbeddingApiKey(this.settings),
        baseUrl: getEmbeddingBaseUrl(this.settings),
        model: getEmbeddingModelId(this.settings),
      };

      await invoke('index_book_chunks', {
        bookHash,
        bookTitle: normalizeTitle(bookDoc.metadata),
        author: normalizeAuthor(bookDoc.metadata),
        chunks,
        embedConfig,
      });
    } finally {
      unlisten();
    }
  }

  async clearBook(bookHash: string): Promise<void> {
    return invoke('clear_book_index', { bookHash });
  }

  async searchForSystemPrompt(
    query: string,
    bookHash: string,
    options: { topK: number; spoilerBoundPosition?: number },
  ): Promise<ScoredChunk[]> {
    const provider = getAIProvider(this.settings);
    const { embedding } = await embed({
      model: provider.getEmbeddingModel(),
      value: query,
    });

    return invoke<ScoredChunk[]>('hybrid_search', {
      bookHash,
      queryText: query,
      queryEmbedding: embedding,
      topK: options.topK,
      maxPage: options.spoilerBoundPosition ?? null,
    });
  }

  // ---- private helpers ----

  private async chunkBook(bookDoc: BookDoc, bookHash: string): Promise<IndexChunkInput[]> {
    const sections = bookDoc.sections || [];
    const toc = bookDoc.toc || [];
    const chunks: IndexChunkInput[] = [];

    const sizes = sections.map((s) => (s.linear !== 'no' && s.size > 0 ? s.size : 0));
    let cumulative = 0;
    const cumulativeSizes = sizes.map((size: number) => {
      const current = cumulative;
      cumulative += size;
      return current;
    });

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      try {
        const doc = await section.createDocument();
        const text = extractTextFromDocument(doc);
        if (text.length < 100) continue;
        const sectionChunks = chunkSection(
          doc,
          i,
          getChapterTitle(toc, i),
          bookHash,
          cumulativeSizes[i] ?? 0,
        );
        for (const c of sectionChunks) {
          chunks.push({
            sectionIndex: c.sectionIndex,
            chapterTitle: c.chapterTitle || '',
            text: c.text,
            pageNumber: c.pageNumber || 0,
          });
        }
      } catch {
        // skip unreadable sections
      }
    }

    return chunks;
  }
}

// ---- metadata normalization (mirrors ragService) ----

function normalizeTitle(metadata?: BookDoc['metadata']): string {
  if (!metadata?.title) return 'Unknown';
  if (typeof metadata.title === 'string') return metadata.title;
  return (
    metadata.title['en'] ||
    metadata.title['default'] ||
    Object.values(metadata.title)[0] ||
    'Unknown'
  );
}

function normalizeAuthor(metadata?: BookDoc['metadata']): string {
  if (!metadata?.author) return 'Unknown';
  if (typeof metadata.author === 'string') return metadata.author;
  const name = metadata.author.name;
  if (!name) return 'Unknown';
  if (typeof name === 'string') return name;
  return Object.values(name)[0] || 'Unknown';
}
