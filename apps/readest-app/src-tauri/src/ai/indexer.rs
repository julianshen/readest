use crate::ai::embed::{embed_texts, EmbeddingConfig};
use crate::ai::storage::IndexDb;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub phase: String,
    pub current: u32,
    pub total: u32,
}

/// Index pre-chunked book sections. Accepts already-chunked texts with
/// metadata from JS (the JS chunker handles section→HTML→text conversion
/// using browser APIs). Rust handles embedding + SQLite storage.
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
    let total = chunks.len() as u32;

    let _ = app_handle.emit(
        "index-progress",
        &IndexProgress {
            phase: "embedding".into(),
            current: 0,
            total,
        },
    );

    let embedding_model = embed_config.model.clone();
    let embeddings = embed_texts(texts, embed_config).await?;

    let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for (i, chunk) in chunks.iter().enumerate() {
        let embedding_blob: Vec<u8> = embeddings[i]
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();

        tx.execute(
            "INSERT INTO chunks (book_hash, section_index, chapter_title, text, embedding, page_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                book_hash,
                chunk.section_index,
                chunk.chapter_title,
                chunk.text,
                embedding_blob,
                chunk.page_number,
            ],
        )
        .map_err(|e| e.to_string())?;

        let row_id = tx.last_insert_rowid();

        tx.execute(
            "INSERT INTO chunks_fts (rowid, text) VALUES (?1, ?2)",
            rusqlite::params![row_id, chunk.text],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "INSERT OR REPLACE INTO index_meta (book_hash, book_title, author, total_sections, total_chunks, embedding_model, last_updated)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, unixepoch())",
        rusqlite::params![
            book_hash,
            book_title,
            author,
            chunks.len() as u32,
            embedding_model,
        ],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

    let _ = app_handle.emit(
        "index-progress",
        &IndexProgress {
            phase: "indexing".into(),
            current: total,
            total,
        },
    );

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
