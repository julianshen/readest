use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
pub struct EpdCapabilities {
    pub available: bool,
    pub modes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, JsonSchema)]
pub struct SetEpdModeRequest {
    pub mode: String,
}
