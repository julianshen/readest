use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Unsupported platform")]
    UnsupportedPlatform,
    #[error("EPD controller not available")]
    ControllerNotAvailable,
    #[error("Unknown EPD mode: {0}")]
    UnknownMode(String),
    #[error("{0}")]
    PluginInvoke(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
