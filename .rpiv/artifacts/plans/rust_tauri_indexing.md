---
date: 2026-06-13T05:09:24+0000
author: Julian Shen
commit: 60e8ce738e18ac626a343e7ba17bba86ad07f835
branch: main
repository: julianshen/readest
topic: "Rust/Tauri Vector Index and Search Backend"
tags: [plan, rust, tauri, rag, vector-search, sqlite]
status: ready
parent: ".rpiv/artifacts/designs/rust_tauri_indexing.md"
phase_count: 5
phases:
  - { n: 1, title: "Rust SQLite Schema + Storage Commands" }
  - { n: 2, title: "Embedding HTTP Dispatch in Rust" }
  - { n: 3, title: "Indexing Pipeline" }
  - { n: 4, title: "SIMD Hybrid Search" }
  - { n: 5, title: "Final Verification & Integration Testing" }
last_updated: 2026-06-13T18:00:00+0800
last_updated_by: Julian Shen
---

# Rust/Tauri Vector Index and Search Backend — Implementation Plan

## Overview

Move the AI book indexing and vector search pipeline from JS/IndexedDB (browser-thread) into a Rust/Tauri native backend with SQLite storage and SIMD-accelerated dot-product search. Adds a `TauriRustBackend` to the existing `RetrievalBackend` abstraction alongside `LegacyIdbBackend` and `ReedyBackend`. The web fallback continues using the existing JS/IndexedDB path unchanged.

Design: `.rpiv/artifacts/designs/rust_tauri_indexing.md`

## Desired End State

- Book indexing runs in a Rust thread — no WebView main-thread stutter
- Vector search at 5K chunks completes in <1ms (SIMD dot-product) instead of ~100ms (JS brute-force)
- Storage in a single `ai_index.db` SQLite file with FTS5 for BM25 and BLOB column for float32 embeddings
- The `selectBackend()` routing prefers `TauriRustBackend` on Tauri desktop, falls back to `LegacyIdbBackend` on web
- Existing IndexedDB indexes remain untouched; users re-index on upgrade (auto-index feature from 60e8ce73)

## What We're NOT Doing

- ANN / quantization / turbovec integration (overkill for book-scale indexes — simple O(n) SIMD dot-product is <1ms at 5K chunks)
- Cross-device index sync (no server component)
- Replacing ReedyBackend (Reedy has its own retrieval pipeline)
- Moving chunking to Rust (JS chunker works fine, not the bottleneck)
- GPU acceleration
- Migration from IndexedDB — users re-index on first launch after upgrade

## Phase 1: Rust SQLite Schema + Storage Commands

### Overview
Create the Rust module structure, SQLite database schema, and basic Tauri commands for index metadata management. This is the foundation all other phases depend on.

### Changes Required:

#### 1. Rust Module Root
**File**: `src-tauri/src/ai/mod.rs` — NEW

```rust
pub mod embed;
pub mod indexer;
pub mod searcher;
pub mod storage;

pub use embed::*;
pub use indexer::*;
pub use searcher::*;
pub use storage::*;
```

#### 2. SQLite Storage Layer
**File**: `src-tauri/src/ai/storage.rs` — NEW

```rust
use rusqlite::{Connection, params};
use std::sync::Mutex;
use tauri::Manager;

pub struct IndexDb {
    pub conn: Mutex<Connection>,
}

impl IndexDb {
    pub fn new(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let app_dir = app_handle
            .path()
            .app_data_dir()
            .ok_or("Cannot resolve app data dir")?;
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
        let db_path = app_dir.join("ai_index.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Self::migrate(&conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn migrate(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                book_hash TEXT NOT NULL,
                section_index INTEGER NOT NULL,
                chapter_title TEXT,
                text TEXT NOT NULL,
                embedding BLOB,
                page_number INTEGER,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                text, content='chunks', content_rowid='id'
            );
            CREATE TABLE IF NOT EXISTS index_meta (
                book_hash TEXT PRIMARY KEY,
                book_title TEXT,
                author TEXT,
                total_sections INTEGER,
                total_chunks INTEGER,
                embedding_model TEXT,
                last_updated INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_hash);"
        ).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn is_book_indexed(book_hash: String, db: tauri::State<'_, IndexDb>) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM index_meta WHERE book_hash = ?1",
            params![book_hash],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(count > 0)
}

#[tauri::command]
pub fn get_chunk_count(book_hash: String, db: tauri::State<'_, IndexDb>) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE book_hash = ?1",
        params![book_hash],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_book_index(book_hash: String, db: tauri::State<'_, IndexDb>) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE book_hash = ?1", params![book_hash])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM index_meta WHERE book_hash = ?1", params![book_hash])
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

#### 3. Register Commands in lib.rs
**File**: `src-tauri/src/lib.rs` — MODIFY

Add `pub mod ai;` with module declarations, register `IndexDb` state and commands:

```rust
// Add to module declarations:
pub mod ai;

// Inside the tauri::Builder::default() chain, before .run():
use ai::storage::IndexDb;

.setup(|app| {
    match IndexDb::new(app.handle()) {
        Ok(db) => {
            app.manage(db);
            Ok(())
        }
        Err(e) => {
            eprintln!("Failed to initialize AI index DB: {}; AI backend disabled", e);
            Ok(())
        }
    }
})
.invoke_handler(tauri::generate_handler![
    // existing handlers (window_state, transfer_file, etc.)...
    ai::storage::is_book_indexed,
    ai::storage::get_chunk_count,
    ai::storage::clear_book_index,
])
```

#### 4. Add Cargo Dependencies
**File**: `src-tauri/Cargo.toml` — MODIFY

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
```

### Success Criteria:

#### Automated Verification:
- [ ] `cargo build` compiles without errors
- [ ] `cargo test` passes for any new tests
- [ ] Tauri app launches and `ai_index.db` is created in the app data dir on first launch
- [ ] `is_book_indexed` returns `false` for a hash with no index
- [ ] `clear_book_index` runs without error on a missing hash
- [ ] `get_chunk_count` returns 0 for an empty book

#### Manual Verification:
- [ ] Open app, verify `~/Library/Application Support/com.jlnshen.reader/ai_index.db` exists
- [ ] Inspect schema: `sqlite3 ai_index.db .schema` shows chunks, chunks_fts, index_meta tables

---

## Phase 2: Embedding HTTP Dispatch in Rust

### Overview
Create the Rust module that dispatches embedding HTTP requests to the configured AI provider (OpenAI/OpenRouter/Ollama). This replaces the JS `embedMany()` call that currently runs on the main thread.

### Changes Required:

#### 1. Embedding Module
**File**: `src-tauri/src/ai/embed.rs` — NEW

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Serialize)]
struct EmbeddingRequest {
    model: String,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[tauri::command]
pub async fn embed_texts(
    texts: Vec<String>,
    config: EmbeddingConfig,
) -> Result<Vec<Vec<f32>>, String> {
    let client = reqwest::Client::new();
    let body = EmbeddingRequest {
        model: config.model.clone(),
        input: texts,
    };
    let resp = client
        .post(format!("{}/embeddings", config.base_url.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Embedding request failed: {}", e))?;
    let parsed: EmbeddingResponse = resp
        .json()
        .await
        .map_err(|e| format!("Embedding parse failed: {}", e))?;
    Ok(parsed.data.into_iter().map(|d| d.embedding).collect())
}
```

#### 2. Register Command in lib.rs
**File**: `src-tauri/src/lib.rs` — MODIFY

Add to the `invoke_handler` list:
```rust
ai::embed::embed_texts,
```

#### 3. reqwest already in Cargo.toml
**File**: `src-tauri/Cargo.toml` — NO CHANGE

`reqwest` is already declared at line 38 with `features = ["json", "stream"]`. No addition needed.

### Success Criteria:

#### Automated Verification:
- [ ] `cargo build` compiles
- [ ] Unit test with mock HTTP server validates request/response format
- [ ] `embed_texts` returns correct number of embeddings for batch input

#### Manual Verification:
- [ ] Call `embed_texts` with 2 test texts and an OpenRouter key → returns 2 embeddings as `number[][]`

---

## Phase 3: Indexing Pipeline

### Overview
Create the Rust indexing orchestration command that accepts pre-chunked section data from JS, dispatches embedding via Phase 2, and stores everything in SQLite via Phase 1. Also create the TS-side `TauriRustBackend` adapter and update `selectBackend`.

### Changes Required:

#### 1. Indexing Orchestrator
**File**: `src-tauri/src/ai/indexer.rs` — NEW

```rust
use crate::ai::embed::{embed_texts, EmbeddingConfig};
use crate::ai::storage::IndexDb;
use tauri::State;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub phase: String,
    pub current: u32,
    pub total: u32,
}

#[tauri::command]
pub async fn index_book_chunks(
    book_hash: String,
    book_title: String,
    author: String,
    chunks: Vec<IndexChunkInput>,
    embed_config: EmbeddingConfig,
    db: State<'_, IndexDb>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();

    let _ = app_handle.emit("index-progress", &IndexProgress {
        phase: "embedding".into(),
        current: 0,
        total: chunks.len() as u32,
    });

    let embeddings = embed_texts(texts, embed_config).await?;

    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for (i, chunk) in chunks.iter().enumerate() {
        let embedding_blob: Vec<u8> = embeddings[i]
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        tx.execute(
            "INSERT INTO chunks (book_hash, section_index, chapter_title, text, embedding, page_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                book_hash,
                chunk.section_index,
                chunk.chapter_title,
                chunk.text,
                embedding_blob,
                chunk.page_number,
            ],
        ).map_err(|e| e.to_string())?;

        let row_id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunks_fts (rowid, text) VALUES (?1, ?2)",
            params![row_id, chunk.text],
        ).map_err(|e| e.to_string())?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO index_meta (book_hash, book_title, author, total_sections, total_chunks, embedding_model, last_updated)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, unixepoch())",
        params![book_hash, book_title, author, chunks.len() as u32, embed_config.model],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    let _ = app_handle.emit("index-progress", &IndexProgress {
        phase: "indexing".into(),
        current: chunks.len() as u32,
        total: chunks.len() as u32,
    });

    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChunkInput {
    pub section_index: u32,
    pub chapter_title: String,
    pub text: String,
    pub page_number: u32,
}
```

#### 2. Register Command in lib.rs
**File**: `src-tauri/src/lib.rs` — MODIFY

Add to the `invoke_handler` list:
```rust
ai::indexer::index_book_chunks,
```

#### 3. RetrievalBackend Interface — Add `'tauri-rust'` Kind
**File**: `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts` — MODIFY

```typescript
export type RetrievalBackendKind = 'legacy-idb' | 'reedy' | 'tauri-rust';

// In selectBackend — add tauriRust parameter:
export function selectBackend(args: {
  settings: AISettings;
  isTauri: boolean;
  tauriRust: RetrievalBackend | null;
  legacy: RetrievalBackend;
  reedy: RetrievalBackend | null;
}): RetrievalBackend {
  if (args.settings.reedy?.enabled && args.isTauri && args.reedy) {
    return args.reedy;
  }
  if (args.isTauri && args.tauriRust) {
    return args.tauriRust;
  }
  return args.legacy;
}
```

#### 4. TauriRustBackend TS Adapter
**File**: `apps/readest-app/src/services/ai/adapters/TauriRustBackend.ts` — NEW

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { embed } from 'ai';
import type { BookDoc } from '@/libs/document';
import type {
  AISettings,
  ScoredChunk,
  EmbeddingProgress,
} from '../types';
import type {
  BackendIndexOptions,
  RetrievalBackend,
} from './retrievalBackend';
import { getAIProvider } from '../providers';
import {
  chunkSection,
  extractTextFromDocument,
} from '@/services/ai/utils/chunker';
import { getChapterTitle } from '@/services/ai/ragService';

interface IndexChunkInput {
  section_index: number;
  chapter_title: string;
  text: string;
  page_number: number;
}

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
    const chunks = await this.chunkBook(bookDoc);
    options?.onProgress?.({
      current: 0,
      total: chunks.length,
      phase: 'embedding',
    });

    // Listen for progress events from Rust
    const unlisten = await listen<EmbeddingProgress>(
      'index-progress',
      (event) => {
        const p = event.payload;
        options?.onProgress?.({
          current: p.current,
          total: p.total,
          phase: p.phase as EmbeddingProgress['phase'],
        });
      },
    );

    try {
      const embedConfig = {
        apiKey:
          this.settings.openaiApiKey ||
          this.settings.openrouterApiKey ||
          '',
        baseUrl: this.getEmbeddingBaseUrl(),
        model: this.getEmbeddingModel(),
      };

      await invoke('index_book_chunks', {
        bookHash,
        bookTitle: bookDoc.metadata?.title || 'Unknown',
        author: bookDoc.metadata?.author || 'Unknown',
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

  // Private helpers
  private async chunkBook(
    bookDoc: BookDoc,
  ): Promise<IndexChunkInput[]> {
    const sections: any[] = (bookDoc as any).sections || [];
    const toc = (bookDoc as any).toc || [];
    const chunks: IndexChunkInput[] = [];

    const sizes = sections.map((s: any) =>
      s.linear !== 'no' && s.size > 0 ? s.size : 0,
    );
    let cumulative = 0;
    const cumulativeSizes = sizes.map((size: number) => {
      const current = cumulative;
      cumulative += size;
      return current;
    });

    const bookHash = (bookDoc as any).hash || '';

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
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
            section_index: c.sectionIndex,
            chapter_title: c.chapterTitle || '',
            text: c.text,
            page_number: c.pageNumber || 0,
          });
        }
      } catch {
        // skip unreadable sections
      }
    }

    return chunks;
  }

  private getEmbeddingBaseUrl(): string {
    const p = this.settings.provider;
    if (p === 'ollama')
      return this.settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    if (p === 'openrouter')
      return (
        this.settings.openrouterBaseUrl || 'https://openrouter.ai/api/v1'
      );
    if (p === 'openai')
      return this.settings.openaiBaseUrl || 'https://api.openai.com/v1';
    return (
      this.settings.aiGatewayBaseUrl || 'https://api.openai.com/v1'
    );
  }

  private getEmbeddingModel(): string {
    const p = this.settings.provider;
    if (p === 'ollama') return this.settings.ollamaEmbeddingModel;
    if (p === 'openrouter')
      return (
        this.settings.openrouterEmbeddingModel ||
        'text-embedding-3-small'
      );
    if (p === 'openai')
      return (
        this.settings.openaiEmbeddingModel || 'text-embedding-3-small'
      );
    return (
      this.settings.aiGatewayEmbeddingModel || 'text-embedding-3-small'
    );
  }
}
```

#### 5. Export TauriRustBackend from Barrel
**File**: `apps/readest-app/src/services/ai/adapters/index.ts` — MODIFY

```typescript
export { TauriRustBackend } from './TauriRustBackend';
```

#### 6. Update CopilotMvpAssistant Call Site (Atomic with selectBackend Change)
**File**: `apps/readest-app/src/app/reader/components/notebook/CopilotAIAssistant.tsx` — MODIFY

Update the backend `useMemo` to include `TauriRustBackend` in the same changeset as the `selectBackend` signature change, so the app never enters a broken intermediate state.

```typescript
const backend = useMemo<RetrievalBackend | null>(() => {
  if (!aiSettings) return null;
  const legacy = new LegacyIdbBackend(aiSettings);
  const tauriRust: RetrievalBackend | null =
    appService && isTauriAppPlatform()
      ? new TauriRustBackend(aiSettings)
      : null;
  const reedy: RetrievalBackend | null =
    appService && isTauriAppPlatform()
      ? new ReedyBackend(appService as AppService, aiSettings)
      : null;
  return selectBackend({
    settings: aiSettings,
    isTauri: isTauriAppPlatform(),
    tauriRust,
    legacy,
    reedy,
  });
}, [aiSettings, appService]);
```

#### 7. Update retrievalBackend.test.ts
**File**: `apps/readest-app/src/__tests__/reedy/retrievalBackend.test.ts` — MODIFY

Add `tauriRust: null` to each existing `selectBackend` call and add a new test case for `'tauri-rust'` priority:

```typescript
describe('selectBackend', () => {
  it('returns Reedy when reedy.enabled=true and isTauri=true and a reedy backend is provided', () => {
    const out = selectBackend({
      settings: settingsWith(true),
      isTauri: true,
      legacy: fakeLegacy,
      tauriRust: null,
      reedy: fakeReedy,
    });
    expect(out.kind).toBe('reedy');
  });

  // ... existing tests updated with tauriRust: null ...

  it('prefers tauri-rust over legacy-idb when both are available', () => {
    const fakeTauriRust: RetrievalBackend = {
      kind: 'tauri-rust',
      isIndexed: vi.fn(async () => true),
      indexBook: vi.fn(async () => {}),
      clearBook: vi.fn(async () => {}),
    };
    const out = selectBackend({
      settings: settingsWith(false),
      isTauri: true,
      legacy: fakeLegacy,
      tauriRust: fakeTauriRust,
      reedy: null,
    });
    expect(out.kind).toBe('tauri-rust');
  });
});
```

### Success Criteria:

#### Automated Verification:
- [ ] TypeScript: `tsc --noEmit` passes with new backend type and selectBackend signature
- [ ] `TauriRustBackend.indexBook()` calls `invoke('index_book_chunks', ...)` with correct args
- [ ] After indexing, `is_book_indexed` returns `true`
- [ ] `get_chunk_count` returns the expected number of chunks

#### Manual Verification:
- [ ] Open a book, open AI panel → click "Start Indexing" → progress events fire → index completes
- [ ] Verify `ai_index.db` has rows in `chunks` and `index_meta` for the book

---

## Phase 4: SIMD Hybrid Search

### Overview
Create the Rust hybrid search that combines exact SIMD dot-product vector search with SQLite FTS5 BM25 scoring, merged via reciprocal rank fusion. Also supports spoiler-bound filtering by page number.

### Changes Required:

#### 1. Search Module
**File**: `src-tauri/src/ai/searcher.rs` — NEW

```rust
use crate::ai::storage::IndexDb;
use serde::Serialize;
use tauri::State;
use std::collections::HashSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoredChunk {
    pub id: String,
    pub book_hash: String,
    pub section_index: u32,
    pub chapter_title: String,
    pub text: String,
    pub page_number: u32,
    pub score: f32,
    pub search_method: String,
}

fn blob_to_vec(blob: &[u8]) -> Result<Vec<f32>, String> {
    if blob.len() % 4 != 0 {
        return Err(format!(
            "Corrupted embedding BLOB: length {} is not a multiple of 4",
            blob.len()
        ));
    }
    Ok(blob
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

fn dot_simd(a: &[f32], b: &[f32]) -> f32 {
    // Auto-vectorized f32 dot product
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

#[tauri::command]
pub fn hybrid_search(
    book_hash: String,
    query_text: String,
    query_embedding: Vec<f32>,
    top_k: u32,
    max_page: Option<u32>,
    db: tauri::State<'_, IndexDb>,
) -> Result<Vec<ScoredChunk>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let top_k = top_k.max(1) as usize;

    let mut stmt = conn
        .prepare(
            "SELECT id, section_index, chapter_title, text, embedding, page_number
             FROM chunks WHERE book_hash = ?1
             ORDER BY id"
        )
        .map_err(|e| e.to_string())?;

    // Collect raw rows with the embedding blob
    let raw_rows: Vec<(i64, u32, String, String, Vec<u8>, u32)> = stmt
        .query_map(rusqlite::params![book_hash], |row| {
            let id: i64 = row.get(0)?;
            let section_index: u32 = row.get(1)?;
            let chapter_title: String = row.get(2)?;
            let text: String = row.get(3)?;
            let embedding_blob: Vec<u8> = row.get(4)?;
            let page_number: u32 = row.get(5)?;
            Ok((id, section_index, chapter_title, text, embedding_blob, page_number))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter(|(_, _, _, _, _, pn)| max_page.map_or(true, |mp| *pn <= mp))
        .collect();

    if raw_rows.is_empty() {
        return Ok(vec![]);
    }

    // Deserialize embeddings and compute vector scores, then sort by score descending
    let mut vec_scored: Vec<(i64, u32, String, String, u32, f32)> = raw_rows
        .into_iter()
        .map(|(id, si, ct, text, blob, pn)| {
            let emb = blob_to_vec(&blob).unwrap_or_default();
            let score = dot_simd(&query_embedding, &emb);
            (id, si, ct, text, pn, score)
        })
        .collect();

    // Sort by vector score descending so vec_rank reflects actual similarity
    vec_scored.sort_unstable_by(|a, b| b.5.partial_cmp(&a.5).unwrap());

    // BM25 via FTS5
    let bm25_scores: Vec<(i64, f32)> = conn
        .prepare(
            "SELECT rowid, rank FROM chunks_fts WHERE text MATCH ?1
             AND rowid IN (SELECT id FROM chunks WHERE book_hash = ?2)
             ORDER BY rank LIMIT ?3"
        )
        .ok()
        .map(|mut stmt| {
            stmt.query_map(rusqlite::params![query_text, book_hash, top_k * 3], |row| {
                let rowid: i64 = row.get(0)?;
                let rank: f32 = row.get(1)?;
                Ok((rowid, rank))
            })
            .map(|r| r.filter_map(|x| x.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    // RRF merge using properly scored vec_rank
    let mut combined: Vec<(String, f32)> = vec_scored.iter().enumerate()
        .map(|(i, (id, _, _, _, _, vec_score))| {
            let vec_rank = i as f32;
            let bm25_rank = bm25_scores.iter()
                .position(|(bid, _)| *bid == *id)
                .map(|r| r as f32)
                .unwrap_or(f32::INFINITY);
            let rrf = 1.0 / (60.0 + vec_rank)
                + if bm25_rank.is_finite() { 1.0 / (60.0 + bm25_rank) } else { 0.0 };
            (id.to_string(), rrf)
        })
        .collect();

    combined.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    let top_ids: std::collections::HashSet<String> = combined.iter()
        .take(top_k).map(|(id, _)| id.clone()).collect();

    let mut results: Vec<ScoredChunk> = vec_scored.into_iter()
        .filter(|(id, _, _, _, _, _)| top_ids.contains(&id.to_string()))
        .map(|(id, si, ct, text, pn, score)| {
            ScoredChunk {
                id: id.to_string(),
                book_hash: book_hash.clone(),
                section_index: si,
                chapter_title: ct,
                text,
                page_number: pn,
                score,
                search_method: "hybrid".into(),
            }
        })
        .collect();

    // Sort results by RRF score descending
    results.sort_by(|a, b| {
        let ra = combined.iter().find(|(id, _)| *id == a.id).map(|(_, s)| *s).unwrap_or(0.0);
        let rb = combined.iter().find(|(id, _)| *id == b.id).map(|(_, s)| *s).unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap()
    });

    Ok(results)
}
```

#### 2. Register Command in lib.rs
**File**: `src-tauri/src/lib.rs` — MODIFY

Add to the `invoke_handler` list:
```rust
ai::searcher::hybrid_search,
```

### Success Criteria:

#### Automated Verification:
- [ ] `cargo build` compiles
- [ ] `hybrid_search` with a query returns top-K scored chunks
- [ ] Spoiler filter drops chunks beyond `max_page` boundary
- [ ] `dot_simd` on normalized random vectors returns values in [-1, 1] range
- [ ] **Benchmark**: `hybrid_search` with 5K synthetic d=1536 embeddings completes in <1ms end-to-end
- [ ] **Benchmark**: `hybrid_search` with 50K synthetic d=1536 embeddings completes in <10ms end-to-end

#### Manual Verification:
- [ ] After indexing a book, ask a question in AI chat → results have relevant passages
- [ ] Set spoiler protection → results only from before the current page
- [ ] **Cross-backend comparison**: Compare search results between Rust and JS backends for the same book+query — verify result sets overlap (modulo f32 rounding)
- [ ] **Memory profile**: Profile RSS during `hybrid_search` for a 5K-chunk book — confirm <25MB peak

---

## Phase 5: Final Verification & Integration Testing

### Overview

Wire the `TauriRustBackend` into the chat adapter's backend selection logic (CopilotMvpAssistant `useMemo` already updated in Phase 3). This phase adds the remaining integration tests and verification criteria to confirm the full pipeline (JS chunk → Rust embed → SQLite store → Rust search → inject into AI prompt) works end-to-end on Tauri desktop.

### Changes Required:

_Backend wiring in CopilotMvpAssistant was applied atomically with the `selectBackend` signature change in Phase 3 §6. No additional code changes needed in this phase — this phase focuses on verification._

### Success Criteria:

#### Automated Verification:
- [ ] `tsc --noEmit` passes
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (all AI tests)

#### Manual Verification:
- [ ] Open app → open a book → AI panel → click "Start Indexing" → full pipeline runs on Rust backend
- [ ] Chat with AI → responses include relevant passages from the book
- [ ] No WebView stutter during indexing (progress bar updates via events from Rust)
- [ ] **Indexing timing**: Measure end-to-end indexing for a typical book (5K chunks) — verify completes within 60 seconds
- [ ] **Auto-index trigger**: On first launch with no `ai_index.db`, verify auto-indexing fires when AI chat is opened (no manual "Start Indexing" click required)
- [ ] **.app size**: After full build, check `.app` bundle size — confirm `rusqlite` bundled contribution is ~2MB and total is reasonable
- [ ] Web version (non-Tauri) still uses `LegacyIdbBackend` — no regression
- [ ] `pnpm check:translations` still passes (no locale file changes in this work)

---

## Testing Strategy

### Automated:
- `cargo build` — compiles for all phases
- `cargo test` — Rust unit tests for storage, search, embedding
- `tsc --noEmit` — TypeScript type checking
- `pnpm build` — full Next.js build
- `pnpm test` — existing AI test suite (35 tests)
- `pnpm check:translations` — no locale regressions

### Manual Testing Steps:
1. After Phase 1: verify `ai_index.db` created on app launch
2. After Phase 3: index a book via the AI panel, verify SQLite rows
3. After Phase 4: compare search results between Rust and JS backends — results should overlap
4. After Phase 5: full end-to-end test — Recap/Chapter Summary with Rust backend
5. Verify web version (`pnpm dev-web`) still works with LegacyIdbBackend

## Performance Considerations

- **Vector search at 5K chunks, d=1536**: ~0.5ms (SIMD dot-product × 5,000 + sort)
- **Vector search at 50K chunks, d=1536**: ~5ms — still well below human perception
- **Indexing (same as today)**: 30-60s for a typical book — but runs in a Rust thread, no WebView stutter
- **SQLite overhead**: All chunk inserts wrapped in a single transaction (see indexer.rs) to batch writes
- **Memory**: All chunks for one book loaded into memory at search time (~2-20MB) — negligible on desktop

## Migration Notes

- Existing IndexedDB indexes remain on disk but are no longer read by the new Rust backend
- On first launch after upgrade: `ai_index.db` starts empty. Auto-indexing triggers on first AI chat
- No data migration from IndexedDB to SQLite — re-indexing is fast enough
- The `bundled` feature for rusqlite adds ~2MB to the Tauri binary — verify .app size stays reasonable

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 5._

### Code Review Findings (artifact-code-reviewer)

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| ------ | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| code | Phase 1 §2 (storage.rs) | apps/readest-app/src-tauri/src/window_state.rs:85 | blocker | actionability | `app_handle.path_resolver().app_data_dir()` uses Tauri v1 API; project uses Tauri v2.10.3 where the API is `app_handle.path().app_data_dir()` (requires `use tauri::Manager;`) | Replace with `app_handle.path().app_data_dir()` and add `use tauri::Manager;` | applied: replaced path_resolver with path(), added use tauri::Manager |
| code | Phase 2 §1 (embed.rs) | apps/readest-app/src-tauri/src/macos/apple_auth.rs:21 | blocker | codebase-fit | `EmbeddingConfig` derives `Deserialize` without `#[serde(rename_all = "camelCase")]`; TS sends `{ apiKey, baseUrl, model }`. Codebase convention uses `#[serde(rename_all = "camelCase")]` for IPC structs | Add `#[serde(rename_all = "camelCase")]` to `EmbeddingConfig`, `IndexChunkInput`, `ScoredChunk`, `IndexProgress` | applied: added #[serde(rename_all = "camelCase")] to all four structs |
| code | Phase 2 §3 (Cargo.toml) | apps/readest-app/src-tauri/Cargo.toml:38 | blocker | actionability | Phase 2 adds `reqwest = { version = "0.12", features = ["json"] }` but `reqwest` is already declared at line 38 with `default-features = false, features = ["json", "stream"]` | Remove the Phase 2 reqwest addition; existing entry already includes `"json"` | applied: removed duplicate reqwest, replaced with NO CHANGE note |
| code | Phase 3 §1 (indexer.rs) | apps/readest-app/src-tauri/src/lib.rs:36 | blocker | actionability | `app_handle.emit_all("index-progress", …)` uses Tauri v1 API; in Tauri v2 the `Emitter` trait uses `.emit()` | Replace with `app_handle.emit(...)` using `use tauri::Emitter;` | applied: replaced emit_all with emit |
| code | Phase 3 §3 (retrievalBackend.ts) + Phase 5 §1 (CopilotAIAssistant.tsx) | apps/readest-app/src/services/ai/adapters/retrievalBackend.ts:62 | blocker | actionability | Phase 3 changes `selectBackend` signature to add `tauriRust` param, but CopilotMvpAssistant call site (line 116) and test file are not updated until Phase 5 — type-check failure between Phase 3 and Phase 5 | Update call site and test file atomically within Phase 3, or add Phase 0 scaffold | applied: added CopilotMvpAssistant call site (P3 §6) and test file update (P3 §7) atomically with selectBackend change |
| code | Phase 4 §1 (searcher.rs) + Phase 3 §4 (TauriRustBackend.ts) | apps/readest-app/src/services/ai/types.ts:118 | blocker | actionability | Rust `ScoredChunk` has `id: i64` but TS expects `id: string` and `bookHash: string`; snake_case fields mismatch TS camelCase | Add `book_hash: String` to Rust, change `id` to String, add `#[serde(rename_all = "camelCase")]` | applied: added book_hash, changed id to String, added camelCase serde |
| code | Phase 3 §3 (retrievalBackend.ts) + Phase 5 | apps/readest-app/src/__tests__/reedy/retrievalBackend.test.ts:28 | blocker | actionability | `retrievalBackend.test.ts` calls `selectBackend({ settings, isTauri, legacy, reedy })` with 4-param shape; Phase 3 adds 5th param `tauriRust` — test file will fail to compile | Add `tauriRust: null` to each `selectBackend` call in test file; add test case for `'tauri-rust'` priority | applied: test file update added as Phase 3 §7 with tauriRust: null and new test case |
| code | Phase 4 §1 (searcher.rs) | <n/a> | concern | code-quality | RRF uses `vec_rank = i` (insertion order) instead of ranking by dot-product score descending — BM25 rank dominates artificially | Sort `all_chunks` by `dot_simd` score descending before computing `vec_rank` | applied: restructured hybrid_search to sort by vec score before RRF |
| code | Phase 3 §4 (TauriRustBackend.ts) + Phase 3 §1 (indexer.rs) | <n/a> | concern | code-quality | `indexBook()` calls `invoke('index_book_chunks', …)` without `listen('index-progress', …)` — progress events emitted by Rust are never received on TS side | Add `listen('index-progress', …)` via `@tauri-apps/api/event` in `indexBook` | applied: added listen('index-progress') with cleanup in finally block |
| code | Phase 3 §1 (indexer.rs) | <n/a> | concern | code-quality | `db.conn.lock()` held for entire transaction (30-60s) — `is_book_indexed`, `hybrid_search`, etc. block | Consider `Connection::try_clone()` or async-compatible pool | dismissed: only one index operation runs at a time; concurrent read during index is rare and acceptable for alpha |
| code | Phase 3 §1 (indexer.rs) + Phase 3 §4 (TauriRustBackend.ts) | apps/readest-app/src/services/ai/types.ts:110 | concern | code-quality | Rust emits `phase: "storing"` but TS `EmbeddingProgress` only accepts `'chunking' | 'embedding' | 'indexing'` | Change Rust phase to `"indexing"` or extend TS union | applied: changed Rust phase string from "storing" to "indexing" |
| code | Phase 1 §3 (lib.rs) | apps/readest-app/src-tauri/src/lib.rs:354-357 | concern | code-quality | `.expect("Failed to initialize AI index DB")` will panic and crash app on failure | Replace with proper error propagation and graceful disable | applied: replaced expect with match + eprintln + graceful disable |
| code | Phase 3 §4 (TauriRustBackend.ts) | apps/readest-app/src/services/ai/adapters/TauriRustBackend.ts:79 | suggestion | code-quality | `chunkBook` uses `(bookDoc as any).sections` and `(bookDoc as any).toc`, bypassing type safety | Use typed `BookDoc` parameters directly | applied: kept minimal as any for runtime shape divergence, but imports are now static top-level |
| code | Phase 4 §1 (searcher.rs) | <n/a> | suggestion | code-quality | `blob_to_vec` uses `chunks_exact(4)` which silently discards trailing bytes on corrupted BLOB | Add length check after `blob_to_vec` to assert `blob.len() % 4 == 0` | applied: blob_to_vec now returns Result with length validation |
| code | Phase 3 §4 (TauriRustBackend.ts) | apps/readest-app/src/services/ai/adapters/TauriRustBackend.ts:103 | suggestion | codebase-fit | `chunkBook` uses dynamic `await import(...)` inside a private method; other backends use static top-level imports | Lift imports to top of file as static imports | applied: chunkSection, extractTextFromDocument, getChapterTitle are now static top-level imports |

### Coverage Review Findings (artifact-coverage-reviewer)

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| ------ | -------- | ------------ | -------- | --------- | ------- | -------------- | ---------- |
| coverage | ## Testing Strategy §9 | <n/a> | blocker | verification-coverage | Manual step "compare Rust vs JS search results" — no phase success criteria names that comparison | Add Manual Verification bullet under Phase 4: "Compare search results between Rust and JS backends for same book+query — verify result sets overlap (modulo f32 rounding)" | applied: added cross-backend comparison to Phase 4 Manual Verification |
| coverage | ## Performance Considerations §1 | <n/a> | blocker | verification-coverage | Performance bullet "~0.5ms at 5K chunks" — no phase criteria includes latency benchmark | Add Automated Verification bullet under Phase 4: "Benchmark hybrid_search with 5K synthetic d=1536 embeddings — assert <1ms end-to-end latency" | applied: added 5K latency benchmark to Phase 4 Automated Verification |
| coverage | ## Performance Considerations §2 | <n/a> | concern | verification-coverage | "~5ms at 50K chunks" — no criteria measures latency at 50K scale | Add Automated/Manual Verification bullet under Phase 4: "Benchmark with 50K synthetic chunks — assert <10ms latency" | applied: added 50K latency benchmark to Phase 4 Automated Verification |
| coverage | ## Performance Considerations §3 | <n/a> | concern | verification-coverage | "Indexing 30-60s" — Phase 5 Manual covers "no WebView stutter" but 30-60s timing target has no criteria | Add Manual Verification bullet under Phase 5: "Measure end-to-end indexing for a typical book (5K chunks) — verify completes within 60 seconds" | applied: added indexing timing to Phase 5 Manual Verification |
| coverage | ## Performance Considerations §5 | <n/a> | suggestion | verification-coverage | "~2-20MB memory — negligible" — no criteria measures memory usage | Add lightweight Manual Verification: "Profile RSS during hybrid_search for 5K-chunk book — confirm <25MB peak" | applied: added RSS memory profile to Phase 4 Manual Verification |
| coverage | ## Migration Notes §2 | <n/a> | concern | verification-coverage | "Auto-indexing triggers on first AI chat" — no criteria tests the auto-index trigger | Add Manual Verification under Phase 5: "On first launch with no ai_index.db, verify auto-indexing fires when AI chat is opened" | applied: added auto-index trigger test to Phase 5 Manual Verification |
| coverage | ## Migration Notes §4 | <n/a> | concern | verification-coverage | "bundled feature adds ~2MB — verify .app size" — no phase criteria checks binary size | Add Manual Verification under Phase 1 or Phase 5: "After full build, check .app bundle size — confirm rusqlite contribution is ~2MB" | applied: added .app size check to Phase 5 Manual Verification |

**Totals: 8 blockers, 8 concerns, 3 suggestions**

## Developer Context

Plan Review (Step 4): all 19 findings (8 blockers, 8 concerns, 3 suggestions) triaged and applied. Status flipped to `ready`. Key fixes applied:
- Tauri v1→v2 API migration: `path_resolver()`→`path()`, `emit_all()`→`emit()`
- `#[serde(rename_all = "camelCase")]` added to all IPC structs
- Duplicate `reqwest` removal from Cargo.toml
- RRF vector ranking fixed: scores sorted before rank computation
- `blob_to_vec` now returns `Result` with length validation
- TauriRustBackend: static imports, `listen('index-progress')` for progress events
- CopilotMvpAssistant call site and test file updated atomically in Phase 3
- ScoredChunk fields aligned: `id: String`, `book_hash: String`, camelCase serde
- `.expect()` replaced with graceful error handling in lib.rs setup
- Phase string `"storing"`→`"indexing"` to match TS `EmbeddingProgress` type
- Missing verification criteria added: cross-backend comparison, latency benchmarks, memory profile, indexing timing, .app size check, auto-index trigger
- Backend selection: Reedy still has highest priority, then tauri-rust, then legacy-idb web fallback
- Mutex<Connection> concern deferred: single index op at a time is fine for alpha

## References

- Design: `.rpiv/artifacts/designs/rust_tauri_indexing.md`
- turbovec: <https://github.com/RyanCodrai/turbovec> — evaluated and deferred
- TurboQuant paper: <https://arxiv.org/abs/2504.19874> — evaluated and deferred
- Current JS pipeline: `apps/readest-app/src/services/ai/ragService.ts`
- Current JS storage: `apps/readest-app/src/services/ai/storage/aiStore.ts`
- Auto-indexing feature: commit `60e8ce73`
