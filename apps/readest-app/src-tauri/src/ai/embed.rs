use serde::{Deserialize, Serialize};
use std::time::Duration;

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

const BATCH_SIZE: usize = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Embed texts using the configured AI provider, batching to avoid
/// provider payload limits. Returns one float32 vector per input text.
#[tauri::command]
pub async fn embed_texts(
    texts: Vec<String>,
    config: EmbeddingConfig,
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
    let mut embeddings = Vec::with_capacity(texts.len());
    for batch in texts.chunks(BATCH_SIZE) {
        let body = EmbeddingRequest {
            model: config.model.clone(),
            input: batch.to_vec(),
        };
        let resp = client
            .post(format!(
                "{}/embeddings",
                config.base_url.trim_end_matches('/')
            ))
            .header("Authorization", format!("Bearer {}", config.api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Embedding request failed: {}", e))?
            .error_for_status()
            .map_err(|e| format!("Embedding API returned error: {}", e))?;
        let parsed: EmbeddingResponse = resp
            .json()
            .await
            .map_err(|e| format!("Embedding parse failed: {}", e))?;
        if parsed.data.len() != batch.len() {
            return Err(format!(
                "Mismatched embeddings count: expected {}, got {}",
                batch.len(),
                parsed.data.len()
            ));
        }
        for d in parsed.data {
            embeddings.push(d.embedding);
        }
    }
    Ok(embeddings)
}
