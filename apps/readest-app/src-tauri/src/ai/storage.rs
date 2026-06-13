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
            .map_err(|e| format!("Cannot resolve app data dir: {}", e))?;
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
        let db_path = app_dir.join("ai_index.db");
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
            CREATE INDEX IF NOT EXISTS idx_chunks_book ON chunks(book_hash);",
        )
        .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn is_book_indexed(
    book_hash: String,
    db: tauri::State<'_, IndexDb>,
) -> Result<bool, String> {
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
pub fn get_chunk_count(
    book_hash: String,
    db: tauri::State<'_, IndexDb>,
) -> Result<i64, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT COUNT(*) FROM chunks WHERE book_hash = ?1",
        params![book_hash],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_book_index(
    book_hash: String,
    db: tauri::State<'_, IndexDb>,
) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE book_hash = ?1", params![book_hash])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM index_meta WHERE book_hash = ?1",
        params![book_hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
