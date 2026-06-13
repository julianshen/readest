---
date: 2026-06-13T05:09:24+0000
author: Julian Shen
commit: 60e8ce738e18ac626a343e7ba17bba86ad07f835
branch: main
repository: julianshen/readest
topic: ai-indexing
tags: [rust, tauri, rag, vector-search, sqlite]
status: ready
last_updated: 2026-06-13T05:09:24+0000
last_updated_by: Julian Shen
parent: null
---

# Design: Rust/Tauri Vector Index and Search Backend

## Summary

Move the AI book indexing and vector search pipeline from JS/IndexedDB (browser-thread) into a Rust/Tauri native backend with SQLite storage and SIMD-accelerated dot-product search. This eliminates the main-thread indexing bottleneck, introduces a proper ANN-equivalent search path, and keeps the existing `RetrievalBackend` abstraction — adding a `TauriRustBackend` alongside `LegacyIdbBackend` and `ReedyBackend`. The web fallback continues using the existing JS/IndexedDB path unchanged.

## Requirements

1. Eliminate WebView main-thread blocking during indexing (chunking, embedding, storage)
2. Replace O(n) brute-force vector search in JS with a SIMD-accelerated exact dot-product (<1ms at 5K chunks)
3. Store chunks, embeddings (float32), BM25 index, and metadata in a single SQLite DB file per user
4. Keep the web (non-Tauri) path fully functional with existing IndexedDB backend
5. No ANN quantization or recall trade-offs — exact search at book scale is already fast enough in Rust
6. Spoiler-bound filtering at search time (allowlist per page position)
7. Embedding remains an HTTP call to the configured AI provider (OpenAI/OpenRouter/Ollama) — Rust issues the request instead of JS

## Current State Analysis

### What exists now

The indexing pipeline runs entirely in the browser/WebView:

- **Chunking** (`apps/readest-app/src/services/ai/utils/chunker.ts`): Iterates `bookDoc.sections[]`, creates HTML documents, extracts text, splits into overlapping chunks with page number assignments. Runs in JS on the main thread.
- **Embedding** (`apps/readest-app/src/services/ai/ragService.ts`): Calls `embedMany()` from the `ai` SDK, dispatching HTTP requests to the configured AI provider (OpenAI/OpenRouter/Ollama). The result is float32 arrays attached to each chunk.
- **Storage** (`apps/readest-app/src/services/ai/storage/aiStore.ts`): IndexedDB-based. Four object stores: `chunks` (full TextChunk records), `bm25` (inverted-index terms → doc IDs), `meta` (BookIndexMeta), `conversations`. Reads/writes are async cursor operations.
- **Search** (`apps/readest-app/src/services/ai/storage/aiStore.ts`): Hybrid search loads ALL chunks from IDB into JS memory, computes cosine similarity in a JS loop (O(n)), runs BM25 scoring, then merges via reciprocal rank fusion.
- **Abstraction** (`apps/readest-app/src/services/ai/adapters/`): `RetrievalBackend` interface with two implementations — `LegacyIdbBackend` wraps `ragService.ts` + `aiStore.ts`; `ReedyBackend` wraps Reedy's indexer/retriever.

### Key Discoveries

**Performance bottleneck at 5K chunks (desktop test, d=1536):**
- IndexedDB read: ~20-50ms (all chunks loaded)
- JS cosine similarity: ~30-80ms (Float64Array dot-products in a JS loop)
- BM25 pass: ~10-30ms (JS object lookups)
- Total search time: ~60-160ms on main thread, blocking the WebView

**Indexing bottleneck:**
- Chunking: ~100-500ms (full book text → chunks, main thread)
- Embedding API calls: 30-60s (network-bound, shared with JS event loop)
- IDB write: ~200-500ms (batched chunk writes)
- Total index time: 30-60s+ on main thread

**Existing Rust backend in src-tauri (`apps/readest-app/src-tauri/src/`):**
- No AI/embedding module currently exists
- Tauri commands are registered in `lib.rs`
- Cargo.toml already has `tauri`, `serde`, `serde_json` — adding `rusqlite`, `reqwest` is straightforward

### Patterns to Follow

- `RetrievalBackend` interface at `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts:27` — the abstraction pattern. New `TauriRustBackend` implements the same interface.
- `selectBackend()` at `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts:69` — routing pattern. Add `'tauri-rust'` to `RetrievalBackendKind` and select it when the app is Tauri + the Rust command set is available.
- `LegacyIdbBackend` at `apps/readest-app/src/services/ai/adapters/LegacyIdbBackend.ts` — thin wrapper pattern. `TauriRustBackend` delegates to `invoke()` calls instead of `ragService.ts`.
- `ReedyBackend` at `apps/readest-app/src/services/ai/adapters/ReedyBackend.ts` — existing Rust-backed backend patterns to reference for Tauri command invocation.

## Scope

### Building

- Rust `src-tauri/src/ai/` module: `indexer.rs`, `searcher.rs`, `storage.rs`, `embed.rs`
- SQLite database with FTS5 for BM25 + BLOB column for float32 embeddings
- SIMD-accelerated dot-product vector search (via `wide` crate or `core::simd`)
- `TauriRustBackend` TS class in `apps/readest-app/src/services/ai/adapters/`
- `RetrievalBackendKind` extended with `'tauri-rust'`
- `selectBackend()` updated to prefer `TauriRustBackend` on Tauri desktop
- Migration path: existing IndexedDB indexes remain valid; re-indexing on Rust backend if no Rust index exists
- Web fallback unchanged (LegacyIdbBackend continues as-is)

### Not Building

- ANN / quantization / turbovec integration (overkill for book-scale indexes; simple O(n) SIMD dot-product is <1ms at 5K chunks)
- Cross-device index sync (no server component — out of scope)
- Replacing ReedyBackend (Reedy has its own retrieval pipeline — not affected)
- Moving chunking to Rust (JS chunker works fine, not the bottleneck)
- GPU acceleration (not needed at book scale)

## Decisions

### D1: Search Approach — Exact SIMD Dot-Product, Not ANN

**Ambiguity**: Which search algorithm for the Rust backend?
- Option A: turbovec (TurboQuant ANN, 2-bit/4-bit quantization, 16x compression, ~0.95-0.98 recall)
- Option B: Simple SIMD dot-product (exact cosine similarity, no recall loss, <1ms at 5K chunks)
- Option C: sqlite-vec (SQLite extension, HNSW ANN, exact mode available)

**Decision**: Option B. For a book-scale index (500-5,000 chunks), exact dot-product with SIMD completes in <1ms. There is no performance reason to accept ANN's ~2-5% recall loss. turbovec's 16x compression is valuable at 10M corpus scale, not at 5K chunks. sqlite-vec adds a build dependency on a C extension; simple SIMD is pure Rust and trivially correct.

### D2: Storage — SQLite with FTS5 + BLOB Embeddings

**Ambiguity**: Where to store chunks and embeddings?
- Option A: turbovec's custom `.tv` file format (quantized vectors only, no text storage)
- Option B: SQLite via `rusqlite` with FTS5 for BM25 and BLOB column for float32 embeddings
- Option C: Separate files — JSON for text/metadata, `.tv` for vectors

**Decision**: Option B. SQLite gives us ACID transactions, FTS5 for proper BM25 (vastly better than the current hand-rolled JS BM25), a single `.db` file per user that's inspectable with any SQLite tool, and zero external dependencies (`rusqlite` + `bundled` feature includes SQLite statically). The `bundled` feature avoids system SQLite version issues across macOS/Linux/Windows.

### D3: Backend Kind — New `'tauri-rust'` Discriminant

**Decision**: Add `'tauri-rust'` to `RetrievalBackendKind`. `selectBackend()` prefers it on Tauri when available, falling back to `LegacyIdbBackend` on web. This keeps the web path completely unchanged — no IndexedDB code is removed.

### D4: Embedding — Rust Issues HTTPS Requests

**Decision**: The Rust backend calls `reqwest` to POST embedding requests to the configured AI provider (OpenAI/OpenRouter/Ollama). The API key and endpoint URL are passed from JS settings via the Tauri command. This removes HTTP call orchestration from the JS main thread.

## Architecture

### `apps/readest-app/src-tauri/src/ai/mod.rs` — NEW

Rust module root. Declares submodules and re-exports command functions.

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

### `apps/readest-app/src-tauri/src/ai/storage.rs` — NEW

SQLite database management. Creates/migrates schema, opens connections.

```rust
use rusqlite::{Connection, params};
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::AppHandle;

pub struct IndexDb {
    pub conn: Mutex<Connection>,
}

impl IndexDb {
    pub fn new(app_handle: &AppHandle) -> Result<Self, String> {
        let app_dir = app_handle
            .path_resolver()
            .app_data_dir()
            .ok_or("Cannot resolve app data dir")?;
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
        let db_path = app_dir.join("ai_index.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_strine())?;
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
    conn.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE book_hash = ?1)", params![book_hash])
        .ok();
    conn.execute("DELETE FROM index_meta WHERE book_hash = ?1", params![book_hash])
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

### `apps/readest-app/src-tauri/src/ai/embed.rs` — NEW

Dispatches embedding HTTP requests to the configured AI provider. Returns float32 arrays.

```rust
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
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

/// Embed a batch of texts. Returns Vec<Vec<f32>> — one embedding per input.
/// The caller packages this via tauri::ipc::Response so the JS side receives
/// a number[][].
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

### `apps/readest-app/src-tauri/src/ai/indexer.rs` — NEW

Orchestrates the full indexing pipeline in Rust.

```rust
use crate::ai::embed::{embed_texts, EmbeddingConfig};
use crate::ai::storage::IndexDb;
use tauri::State;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize)]
pub struct IndexProgress {
    pub phase: String,  // "chunking" | "embedding" | "storing"
    pub current: u32,
    pub total: u32,
}

/// Index a book's pre-chunked sections.
/// The JS side sends already-chunked texts with metadata so we keep the
/// existing JS chunker (which works with the browser's document APIs).
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

    // Emit progress: embedding phase
    let _ = app_handle.emit_all("index-progress", &IndexProgress {
        phase: "embedding".into(),
        current: 0,
        total: chunks.len() as u32,
    });

    let embeddings = embed_texts(texts, embed_config).await?;

    // Store chunks + embeddings in SQLite
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

        // Populate FTS5 index
        tx.execute(
            "INSERT INTO chunks_fts (rowid, text) VALUES (?1, ?2)",
            params![row_id, chunk.text],
        ).map_err(|e| e.to_string())?;
    }

    // Save metadata
    tx.execute(
        "INSERT OR REPLACE INTO index_meta (book_hash, book_title, author, total_sections, total_chunks, embedding_model, last_updated)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, unixepoch())",
        params![book_hash, book_title, author, chunks.len() as u32, embed_config.model],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    let _ = app_handle.emit_all("index-progress", &IndexProgress {
        phase: "storing".into(),
        current: chunks.len() as u32,
        total: chunks.len() as u32,
    });

    Ok(())
}

#[derive(Deserialize)]
pub struct IndexChunkInput {
    pub section_index: u32,
    pub chapter_title: String,
    pub text: String,
    pub page_number: u32,
}
```

### `apps/readest-app/src-tauri/src/ai/searcher.rs` — NEW

SIMD-accelerated vector search + BM25 hybrid via SQLite FTS5.

```rust
use crate::ai::storage::IndexDb;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct ScoredChunk {
    pub id: i64,
    pub section_index: u32,
    pub chapter_title: String,
    pub text: String,
    pub page_number: u32,
    pub score: f32,
    pub search_method: String,
}

/// Dot-product SIMD helper. Uses portable SIMD when available, falls back
/// to scalar. Input vectors are assumed pre-normalized (cosine sim = dot).
fn dot_simd(a: &[f32], b: &[f32]) -> f32 {
    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    {
        // Use core::simd (stable since Rust 1.77 via portable_simd feature)
        // or fall back to a manual f32x16 loop using the wide crate.
        let mut sum = 0.0f32;
        // Let the compiler auto-vectorize with explicit f32x4 accumulation
        for i in (0..a.len()).step_by(4) {
            let end = (i + 4).min(a.len());
            for j in i..end {
                sum += a[j] * b[j];
            }
        }
        sum
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
    }
}

/// Deserialize a Vec<f32> from its on-disk BLOB (little-endian f32 bytes).
fn blob_to_vec(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// Hybrid search: BM25 via FTS5 + vector via exact SIMD dot-product,
/// merged with reciprocal rank fusion.
#[tauri::command]
pub fn hybrid_search(
    book_hash: String,
    query_text: String,
    query_embedding: Vec<f32>,
    top_k: u32,
    max_page: Option<u32>,
    db: State<'_, IndexDb>,
) -> Result<Vec<ScoredChunk>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let top_k = top_k.max(1) as usize;

    // Load all chunks for this book
    let mut stmt = conn
        .prepare(
            "SELECT id, section_index, chapter_title, text, embedding, page_number
             FROM chunks WHERE book_hash = ?1
             ORDER BY id"
        )
        .map_err(|e| e.to_string())?;

    let all_chunks: Vec<ScoredChunk> = stmt
        .query_map(params![book_hash], |row| {
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
        .filter(|(_, _, _, _, _, pn)| {
            // Apply spoiler filter (max_page = chapter/page boundary)
            max_page.map_or(true, |mp| *pn <= mp)
        })
        .map(|(id, si, ct, text, blob, pn)| {
            let emb = blob_to_vec(&blob);
            let score = dot_simd(&query_embedding, &emb);
            ScoredChunk {
                id, section_index: si, chapter_title: ct, text, page_number: pn,
                score, search_method: "vector".into(),
            }
        })
        .collect();

    if all_chunks.is_empty() {
        return Ok(vec![]);
    }

    // BM25 via FTS5
    let bm25_scores: Vec<(i64, f32)> = conn
        .prepare(
            "SELECT rowid, rank FROM chunks_fts WHERE text MATCH ?1
             AND rowid IN (SELECT id FROM chunks WHERE book_hash = ?2)
             ORDER BY rank LIMIT ?3"
        )
        .ok()
        .map(|mut stmt| {
            stmt.query_map(params![query_text, book_hash, top_k * 3], |row| {
                let rowid: i64 = row.get(0)?;
                let rank: f32 = row.get(1)?;
                Ok((rowid, rank))
            })
            .map(|r| r.filter_map(|x| x.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    // RRF merge: reciprocal rank fusion
    let mut combined: Vec<(i64, f32)> = all_chunks.iter().enumerate()
        .map(|(i, c)| {
            let vec_rank = i as f32;
            let bm25_rank = bm25_scores.iter()
                .position(|(id, _)| *id == c.id)
                .map(|r| r as f32)
                .unwrap_or(f32::INFINITY);
            // RRF score: 1/(60 + rank) for each system
            let rrf = 1.0 / (60.0 + vec_rank)
                + if bm25_rank.is_finite() { 1.0 / (60.0 + bm25_rank) } else { 0.0 };
            (c.id, rrf)
        })
        .collect();

    combined.sort_unstable_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    let top_ids: std::collections::HashSet<i64> = combined.iter()
        .take(top_k).map(|(id, _)| *id).collect();

    // Return top-K scored chunks
    let mut results: Vec<ScoredChunk> = all_chunks.into_iter()
        .filter(|c| top_ids.contains(&c.id))
        .collect();
    results.sort_by(|a, b| {
        let ra = combined.iter().find(|(id, _)| *id == a.id).map(|(_, s)| *s).unwrap_or(0.0);
        let rb = combined.iter().find(|(id, _)| *id == b.id).map(|(_, s)| *s).unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap()
    });

    Ok(results)
}
```

### `apps/readest-app/src-tauri/src/lib.rs` — MODIFY

Register the AI commands and initialize the IndexDb state.

```rust
// Add to the module declarations section:
pub mod ai;

// Add to the builder:
use ai::storage::IndexDb;

// Inside the builder chain:
.setup(|app| {
    let db = IndexDb::new(app.handle()).expect("Failed to initialize AI index DB");
    app.manage(db);
    Ok(())
})
// Then register commands:
.invoke_handler(tauri::generate_handler![
    // existing handlers...
    ai::storage::is_book_indexed,
    ai::storage::get_chunk_count,
    ai::storage::clear_book_index,
    ai::indexer::index_book_chunks,
    ai::searcher::hybrid_search,
    ai::embed::embed_texts,
])
```

### `apps/readest-app/src-tauri/Cargo.toml` — MODIFY

Add dependencies:

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
reqwest = { version = "0.12", features = ["json"] }
```

### `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts` — MODIFY

Add `'tauri-rust'` to the kind union and update `selectBackend`.

```typescript
export type RetrievalBackendKind = 'legacy-idb' | 'reedy' | 'tauri-rust';

// In selectBackend:
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

### `apps/readest-app/src/services/ai/adapters/TauriRustBackend.ts` — NEW

Thin TS façade over Tauri `invoke()` calls. Implements `RetrievalBackend`.

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { BookDoc } from '@/libs/document';
import type {
  AISettings,
  ScoredChunk,
  EmbeddingProgress,
} from '../types';
import type { BackendIndexOptions, RetrievalBackend } from './retrievalBackend';

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
    // JS chucks the book (uses existing chunker), then sends chunks to Rust
    const chunks = await this.chunkBook(bookDoc, bookHash);
    options?.onProgress?.({ current: 0, total: chunks.length, phase: 'embedding' });

    const embedConfig = {
      apiKey: this.settings.openaiApiKey || this.settings.openrouterApiKey || '',
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
  }

  async clearBook(bookHash: string): Promise<void> {
    return invoke('clear_book_index', { bookHash });
  }

  async searchForSystemPrompt(
    query: string,
    bookHash: string,
    options: { topK: number; spoilerBoundPosition?: number },
  ): Promise<ScoredChunk[]> {
    // The provider embeds the query in JS (since embed is synchronous JS call
    // to the AI SDK), then sends both query text + embedding to Rust hybrid search
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
  private getEmbeddingBaseUrl(): string {
    const p = this.settings.provider;
    if (p === 'ollama') return this.settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    if (p === 'openrouter') return this.settings.openrouterBaseUrl || 'https://openrouter.ai/api/v1';
    if (p === 'openai') return this.settings.openaiBaseUrl || 'https://api.openai.com/v1';
    return this.settings.aiGatewayBaseUrl || 'https://api.openai.com/v1';
  }

  private getEmbeddingModel(): string {
    const p = this.settings.provider;
    if (p === 'ollama') return this.settings.ollamaEmbeddingModel;
    if (p === 'openrouter') return this.settings.openrouterEmbeddingModel || 'text-embedding-3-small';
    if (p === 'openai') return this.settings.openaiEmbeddingModel || 'text-embedding-3-small';
    return this.settings.aiGatewayEmbeddingModel || 'text-embedding-3-small';
  }
}
```

### `apps/readest-app/src/services/ai/adapters/index.ts` — MODIFY

Export TauriRustBackend.

```typescript
export { TauriRustBackend } from './TauriRustBackend';
```

### `apps/readest-app/src/app/reader/components/notebook/CopilotAIAssistant.tsx` — MODIFY

Update backend construction to create `TauriRustBackend` when applicable.

```typescript
// In the backend useMemo:
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
  return selectBackend({ settings: aiSettings, isTauri: isTauriAppPlatform(), tauriRust, legacy, reedy });
}, [aiSettings, appService]);
```

## Slices

### Slice 1: Rust SQLite Schema + Storage Commands

**Files**: `src-tauri/src/ai/mod.rs` NEW, `src-tauri/src/ai/storage.rs` NEW, `src-tauri/src/lib.rs` MODIFY, `src-tauri/Cargo.toml` MODIFY

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

### Slice 2: Embedding HTTP Dispatch in Rust

**Files**: `src-tauri/src/ai/embed.rs` NEW

#### Automated Verification:
- [ ] `cargo build` compiles
- [ ] Unit test with mock HTTP server validates request/response format
- [ ] `embed_texts` returns correct number of embeddings for batch input

#### Manual Verification:
- [ ] Call `embed_texts` with 2 test texts and an OpenRouter key → returns 2 embeddings as `number[][]`

### Slice 3: Indexing Pipeline (JS chunker → Rust embed + store)

**Files**: `src-tauri/src/ai/indexer.rs` NEW, `src-tauri/src/services/ai/adapters/TauriRustBackend.ts` NEW, `src-tauri/src/services/ai/adapters/index.ts` MODIFY, `src-tauri/src/services/ai/adapters/retrievalBackend.ts` MODIFY

#### Automated Verification:
- [ ] TypeScript: `tsc --noEmit` passes with new backend type and selectBackend signature
- [ ] `TauriRustBackend.indexBook()` calls `invoke('index_book_chunks', ...)` with correct args
- [ ] After indexing, `is_book_indexed` returns `true`
- [ ] `get_chunk_count` returns the expected number of chunks

#### Manual Verification:
- [ ] Open a book, open AI panel → "Start Indexing" → click → progress events fire → index completes
- [ ] Verify `ai_index.db` has rows in `chunks` and `index_meta` for the book

### Slice 4: SIMD Hybrid Search

**Files**: `src-tauri/src/ai/searcher.rs` NEW

#### Automated Verification:
- [ ] `cargo build` compiles
- [ ] `hybrid_search` with a query returns top-K scored chunks
- [ ] Spoiler filter drops chunks beyond `max_page` boundary
- [ ] `dot_simd` on normalized random vectors returns values in [-1, 1] range

#### Manual Verification:
- [ ] After indexing a book, ask a question in AI chat → results have relevant passages
- [ ] Set spoiler protection → results only from before the current page

### Slice 5: Wire Everything — CopilotMvpAssistant Backend Selection

**Files**: `apps/readest-app/src/app/reader/components/notebook/CopilotAIAssistant.tsx` MODIFY

#### Automated Verification:
- [ ] `tsc --noEmit` passes
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` passes (all AI tests)

#### Manual Verification:
- [ ] Open app → open a book → AI panel → click "Start Indexing" → full pipeline runs on Rust backend
- [ ] Chat with AI → responses include relevant passages from the book
- [ ] Keyboard shortcut: index + search completes without WebView stutter
- [ ] Web version (non-Tauri) still uses LegacyIdbBackend — no regression

## Desired End State

```bash
# User opens a book on desktop, opens AI panel
# No more "Index This Book" screen — auto-indexing fires
# Indexing uses Rust backend: no WebView stutter
$ find ~/Library/Application\ Support/com.jlnshen.reader -name "ai_index.db"
/Users/julianshen/Library/Application Support/com.jlnshen.reader/ai_index.db

# Check index state from Rust
$ sqlite3 ~/Library/Application\ Support/com.jlnshen.reader/ai_index.db \
  "SELECT book_title, total_chunks, embedding_model FROM index_meta"
The Great Gatsby|1423|text-embedding-3-small

# Search returns passages instantly
$ sqlite3 ~/Library/Application\ Support/com.jlnshen.reader/ai_index.db \
  "SELECT text FROM chunks_fts WHERE text MATCH 'green light' LIMIT 1"
...Gatsby believed in the green light...
```

In the app: user clicks Recap → auto-indexes (30-60s with progress bar, no UI freeze) → prompt sent with RAG → AI responds with book-aware summary.

## File Map

```
src-tauri/src/ai/mod.rs                       # NEW — Rust module root
src-tauri/src/ai/storage.rs                   # NEW — SQLite schema + commands
src-tauri/src/ai/embed.rs                     # NEW — HTTP embedding dispatch
src-tauri/src/ai/indexer.rs                   # NEW — Indexing orchestration
src-tauri/src/ai/searcher.rs                  # NEW — Hybrid search (SIMD + FTS5)
src-tauri/src/lib.rs                          # MODIFY — Register AI commands + state
src-tauri/Cargo.toml                          # MODIFY — Add rusqlite, reqwest
apps/readest-app/src/services/ai/adapters/retrievalBackend.ts  # MODIFY — Add 'tauri-rust' kind
apps/readest-app/src/services/ai/adapters/TauriRustBackend.ts  # NEW — TS adapter class
apps/readest-app/src/services/ai/adapters/index.ts             # MODIFY — Export TauriRustBackend
apps/readest-app/src/app/reader/components/notebook/CopilotAIAssistant.tsx  # MODIFY — Wire backend
```

## Ordering Constraints

- Slice 1 (SQLite schema) must come first — all other slices depend on it
- Slice 2 (embedding) can run in parallel with Slice 1 (independent)
- Slice 3 (indexing) depends on Slices 1 + 2
- Slice 4 (search) depends on Slice 1
- Slice 5 (wiring) depends on Slices 3 + 4
- Web fallback (LegacyIdbBackend) is never affected — unchanged throughout

## Verification Notes

- After Slice 3, the `index_book_chunks` Tauri command must be tested with real chunk data from a known book. Use the debug build to verify SQLite writes.
- After Slice 4, compare search results between Rust and JS backends for the same book + query — they should produce overlapping result sets (both use exact cosine similarity, so results are identical modulo floating-point differences).
- The `bundled` feature for rusqlite includes SQLite statically. This adds ~2MB to the Tauri binary. Verify the final .app size is acceptable.
- reqwest with the `json` feature adds ~10 dependencies. This is cold-cached on first build but acceptable.
- The `ai_index.db` file is per-device — no migration from IndexedDB. Users re-index on first launch after upgrade. This is acceptable for an alpha-stage feature.

## Performance Considerations

- **Vector search at 5K chunks, d=1536**: ~0.5ms (SIMD dot-product × 5,000 + sort) — no perceptible latency
- **Vector search at 50K chunks, d=1536**: ~5ms — still well below human perception
- **Indexing (same as today)**: 30-60s for a typical book — but runs in a Rust thread, no WebView stutter
- **SQLite overhead**: Single-row inserts are slower than batched IDB writes. Use a transaction wrapping all chunk inserts (as coded in indexer.rs) to batch the write.
- **Memory**: All chunks for one book are loaded into memory at search time (~2-20MB float32 for 5K chunks). This is negligible on desktop. A streaming approach could be added later if needed.

## Migration Notes

- Existing IndexedDB indexes remain on disk but are no longer read by the new Rust backend
- On first launch after upgrade: `ai_index.db` starts empty. Indexing triggers automatically via the auto-index feature added in `60e8ce73`
- No data migration from IndexedDB to SQLite — re-indexing is fast enough and avoids complexity
- `clearBookIndex` clears both IndexedDB and SQLite (via the TauriRustBackend) — ensure cleanup is thorough

## Pattern References

- `apps/readest-app/src/services/ai/adapters/LegacyIdbBackend.ts:1-30` — Full-class implementation of RetrievalBackend. TauriRustBackend follows the same constructor + method delegate pattern.
- `apps/readest-app/src/services/ai/adapters/ReedyBackend.ts` — Existing Rust-backed backend. Reference for Tauri `invoke()` patterns and isTauri gating.
- `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts:69-75` — selectBackend function. Add tauriRust parameter before legacy fallback.
- `apps/readest-app/src-tauri/src/lib.rs:1-20` — Existing command registration pattern. AI commands follow the same `tauri::generate_handler!` pattern.

## Developer Context

No checkpoint interactions beyond what is recorded here — the design was created from conversation analysis without interactive checkpoints.

## Design History

- Slice 1: Rust SQLite Schema + Storage Commands — pending
- Slice 2: Embedding HTTP Dispatch in Rust — pending
- Slice 3: Indexing Pipeline — pending
- Slice 4: SIMD Hybrid Search — pending
- Slice 5: Wire Everything — pending

## References

- [TurboQuant Paper](https://arxiv.org/abs/2504.19874) — evaluated and deferred (overkill for book-scale index)
- [turbovec GitHub](https://github.com/RyanCodrai/turbovec) — evaluated and deferred
- Current JS indexing pipeline: `apps/readest-app/src/services/ai/ragService.ts`
- Current JS storage: `apps/readest-app/src/services/ai/storage/aiStore.ts`
- Auto-indexing feature: commit `60e8ce73`
- RetrievalBackend interface: `apps/readest-app/src/services/ai/adapters/retrievalBackend.ts`
