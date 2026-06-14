use crate::ai::storage::IndexDb;
use rusqlite::{params_from_iter, Connection, ToSql};
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

/// Escape a user query so it can be safely passed to an FTS5 MATCH expression.
/// Removes FTS5 syntax metacharacters, splits into tokens, and joins them with
/// spaces so multi-word prompts match documents containing the terms (AND
/// semantics) rather than requiring the exact phrase.
fn escape_fts5_query(query: &str) -> String {
    let sanitized: String = query
        .chars()
        .map(|c| match c {
            '"' | '*' | '(' | ')' | '+' | '-' | '~' | '^' | '<' | '>' | '@' | '#' => ' ',
            _ => c,
        })
        .collect();
    let tokens: Vec<&str> = sanitized.split_whitespace().collect();
    tokens.join(" ")
}

/// Run a BM25 query via FTS5, optionally constrained to chunks at or before
/// `max_page`. Returns `(rowid, rank)` pairs ordered by BM25 rank.
fn run_bm25(
    conn: &Connection,
    escaped_query: &str,
    book_hash: &str,
    max_page: Option<u32>,
    limit: usize,
) -> Result<Vec<(i64, f32)>, String> {
    if escaped_query.is_empty() {
        return Ok(vec![]);
    }
    let max_page_i64 = max_page.map(|mp| mp as i64);
    let (sql, mut sql_params): (&str, Vec<&dyn ToSql>) = match max_page_i64 {
        Some(ref mp) => (
            "SELECT f.rowid, f.rank FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE f.text MATCH ?1 AND c.book_hash = ?2 AND c.page_number <= ?3
             ORDER BY f.rank LIMIT ?4",
            vec![&escaped_query, &book_hash, mp],
        ),
        None => (
            "SELECT f.rowid, f.rank FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE f.text MATCH ?1 AND c.book_hash = ?2
             ORDER BY f.rank LIMIT ?3",
            vec![&escaped_query, &book_hash],
        ),
    };
    let limit_i64 = limit as i64;
    sql_params.push(&limit_i64 as &dyn ToSql);
    let mut bm25_stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = bm25_stmt
        .query_map(params_from_iter(sql_params), |row| {
            let rowid: i64 = row.get(0)?;
            let rank: f32 = row.get(1)?;
            Ok((rowid, rank))
        })
        .map_err(|e| e.to_string())?;
    let scores = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(scores)
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

/// Cosine similarity helper. Normalizes both vectors before computing the dot
/// product so the score is independent of vector magnitude, matching the
/// behavior of the legacy IndexedDB backend.
fn cosine_sim(a: &[f32], b: &[f32]) -> Result<f32, String> {
    if a.len() != b.len() {
        return Err(format!(
            "Embedding dimension mismatch: query={}, stored={}",
            a.len(),
            b.len()
        ));
    }
    fn norm(v: &[f32]) -> f32 {
        v.iter().map(|x| x * x).sum::<f32>().sqrt()
    }
    let norm_a = norm(a);
    let norm_b = norm(b);
    if norm_a == 0.0 || norm_b == 0.0 {
        return Ok(0.0);
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    Ok(dot / (norm_a * norm_b))
}

/// BM25-only search via FTS5. Used as a fallback when query embedding fails.
#[tauri::command]
pub fn text_search(
    book_hash: String,
    query_text: String,
    top_k: u32,
    max_page: Option<u32>,
    db: tauri::State<'_, IndexDb>,
) -> Result<Vec<ScoredChunk>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let top_k = top_k.max(1) as usize;

    let mut stmt = conn
        .prepare(
            "SELECT id, section_index, chapter_title, text, page_number
             FROM chunks WHERE book_hash = ?1
             ORDER BY id",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i64, u32, String, String, u32)> = stmt
        .query_map(rusqlite::params![book_hash], |row| {
            let id: i64 = row.get(0)?;
            let section_index: u32 = row.get(1)?;
            let chapter_title: String = row.get(2)?;
            let text: String = row.get(3)?;
            let page_number: u32 = row.get(4)?;
            Ok((id, section_index, chapter_title, text, page_number))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(_, _, _, _, pn)| max_page.map_or(true, |mp| *pn <= mp))
        .collect();

    let escaped_query = escape_fts5_query(&query_text);
    let bm25_scores = run_bm25(&conn, &escaped_query, &book_hash, max_page, top_k * 3)?;

    let top_ids: std::collections::HashSet<String> = bm25_scores
        .iter()
        .take(top_k)
        .map(|(id, _)| id.to_string())
        .collect();

    let mut results: Vec<ScoredChunk> = rows
        .into_iter()
        .filter(|(id, _, _, _, _)| top_ids.contains(&id.to_string()))
        .map(|(id, si, ct, text, pn)| ScoredChunk {
            id: id.to_string(),
            book_hash: book_hash.clone(),
            section_index: si,
            chapter_title: ct,
            text,
            page_number: pn,
            score: 0.0,
            search_method: "bm25".into(),
        })
        .collect();

    results.sort_by(|a, b| {
        let ra = bm25_scores
            .iter()
            .find(|(id, _)| id.to_string() == a.id)
            .map(|(_, r)| *r)
            .unwrap_or(f32::INFINITY);
        let rb = bm25_scores
            .iter()
            .find(|(id, _)| id.to_string() == b.id)
            .map(|(_, r)| *r)
            .unwrap_or(f32::INFINITY);
        ra.total_cmp(&rb)
    });

    Ok(results)
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
            Ok((
                id,
                section_index,
                chapter_title,
                text,
                embedding_blob,
                page_number,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|(_, _, _, _, _, pn)| max_page.map_or(true, |mp| *pn <= mp))
        .collect();

    if raw_rows.is_empty() {
        return Ok(vec![]);
    }

    // Deserialize embeddings and compute vector scores
    let mut vec_scored: Vec<(i64, u32, String, String, u32, f32)> = raw_rows
        .into_iter()
        .map(
            |(id, si, ct, text, blob, pn)| -> Result<(i64, u32, String, String, u32, f32), String> {
                let emb = blob_to_vec(&blob)?;
                let score = cosine_sim(&query_embedding, &emb)?;
                Ok((id, si, ct, text, pn, score))
            },
        )
        .collect::<Result<Vec<_>, _>>()?;

    // Sort by vector score descending so vec_rank reflects actual similarity
    vec_scored.sort_unstable_by(|a, b| b.5.total_cmp(&a.5));

    // BM25 via FTS5
    let escaped_query = escape_fts5_query(&query_text);
    let bm25_scores = run_bm25(&conn, &escaped_query, &book_hash, max_page, top_k * 3)?;

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

    let top_ids: std::collections::HashSet<String> = combined
        .iter()
        .take(top_k)
        .map(|(id, _)| id.clone())
        .collect();

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
