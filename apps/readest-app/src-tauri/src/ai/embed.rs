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

/// Embed a batch of texts using the configured AI provider.
/// Returns one float32 vector per input text.
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
        .post(format!(
            "{}/embeddings",
            config.base_url.trim_end_matches('/')
        ))
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
