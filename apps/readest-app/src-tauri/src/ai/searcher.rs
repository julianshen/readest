use crate::ai::storage::IndexDb;
use serde::Serialize;

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

/// Deserialize a `Vec<f32>` from its on-disk BLOB (little-endian f32 bytes).
/// Returns an error if the blob length is not a multiple of 4.
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

/// Dot-product helper for normalized vectors (cosine sim = dot).
/// The compiler auto-vectorizes the f32 accumulation.
fn dot_simd(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// Hybrid search: BM25 via FTS5 + vector via exact SIMD dot-product,
/// merged with reciprocal rank fusion. Supports spoiler-bound filtering.
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
             ORDER BY id",
        )
        .map_err(|e| e.to_string())?;

    // Collect raw rows with embedding blob
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

    // Deserialize embeddings and compute vector scores
    let mut vec_scored: Vec<(i64, u32, String, String, u32, f32)> = raw_rows
        .into_iter()
        .map(|(id, si, ct, text, blob, pn)| {
            let emb = blob_to_vec(&blob).unwrap_or_default();
            let score = dot_simd(&query_embedding, &emb);
            (id, si, ct, text, pn, score)
        })
        .collect();

    // Sort by vector score descending so vec_rank reflects actual similarity
    vec_scored.sort_unstable_by(|a, b| b.5.total_cmp(&a.5));

    // BM25 via FTS5
    let bm25_scores: Vec<(i64, f32)> = conn
        .prepare(
            "SELECT rowid, rank FROM chunks_fts WHERE text MATCH ?1
             AND rowid IN (SELECT id FROM chunks WHERE book_hash = ?2)
             ORDER BY rank LIMIT ?3",
        )
        .ok()
        .and_then(|mut stmt| {
            stmt.query_map(
                rusqlite::params![query_text, book_hash, top_k * 3],
                |row| {
                    let rowid: i64 = row.get(0)?;
                    let rank: f32 = row.get(1)?;
                    Ok((rowid, rank))
                },
            )
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    // RRF merge: 1/(60 + rank) per system, summed
    let mut combined: Vec<(String, f32)> = vec_scored
        .iter()
        .enumerate()
        .map(|(i, (id, _, _, _, _, _))| {
            let vec_rank = i as f32;
            let bm25_rank = bm25_scores
                .iter()
                .position(|(bid, _)| *bid == *id)
                .map(|r| r as f32)
                .unwrap_or(f32::INFINITY);
            let rrf = 1.0 / (60.0 + vec_rank)
                + if bm25_rank.is_finite() {
                    1.0 / (60.0 + bm25_rank)
                } else {
                    0.0
                };
            (id.to_string(), rrf)
        })
        .collect();

    combined.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));

    let top_ids: std::collections::HashSet<String> =
        combined.iter().take(top_k).map(|(id, _)| id.clone()).collect();

    // Build scored chunks, keeping only top-K
    let mut results: Vec<ScoredChunk> = vec_scored
        .into_iter()
        .filter(|(id, _, _, _, _, _)| top_ids.contains(&id.to_string()))
        .map(|(id, si, ct, text, pn, score)| ScoredChunk {
            id: id.to_string(),
            book_hash: book_hash.clone(),
            section_index: si,
            chapter_title: ct,
            text,
            page_number: pn,
            score,
            search_method: "hybrid".into(),
        })
        .collect();

    // Sort results by RRF score descending
    results.sort_by(|a, b| {
        let ra = combined
            .iter()
            .find(|(id, _)| *id == a.id)
            .map(|(_, s)| *s)
            .unwrap_or(0.0);
        let rb = combined
            .iter()
            .find(|(id, _)| *id == b.id)
            .map(|(_, s)| *s)
            .unwrap_or(0.0);
        rb.total_cmp(&ra)
    });

    Ok(results)
}
