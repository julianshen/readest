use sha2::{Digest, Sha256};

/// Metadata for a single model file to download on first use.
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// Returns true iff sha256(bytes) hex-equals `hex` (case-insensitive).
pub fn verify_sha256(bytes: &[u8], hex: &str) -> bool {
    let digest = Sha256::digest(bytes);
    hex::encode(digest).eq_ignore_ascii_case(hex)
}

/// The 4 Japanese model files to download on first use.
pub fn ja_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            name: "comic-text-detector.onnx",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "comic-text-detector.onnx"
            ),
            sha256: "1a86ace74961413cbd650002e7bb4dcec4980ffa21b2f19b86933372071d718f",
        },
        ModelFile {
            name: "encoder_model.onnx",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "encoder_model.onnx"
            ),
            sha256: "f87668ae0f62d6f032dac6b213e8c0fea84cd15895ac8cab624cc9a2f49d4a27",
        },
        ModelFile {
            name: "decoder_model.onnx",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "decoder_model.onnx"
            ),
            sha256: "6b1fb216d542c4b2a4fa5b9d7ae3522081eb85fb959d2cecd28055af956a8a5e",
        },
        ModelFile {
            name: "vocab.txt",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "vocab.txt"
            ),
            sha256: "344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d",
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_sha256_known_vectors() {
        // SHA-256("abc") = ba7816bf...
        assert!(verify_sha256(
            b"abc",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        assert!(!verify_sha256(
            b"abd",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
    }

    #[test]
    fn ja_manifest_has_four_valid_entries() {
        let manifest = ja_manifest();
        assert_eq!(manifest.len(), 4);
        for entry in &manifest {
            assert_eq!(
                entry.sha256.len(),
                64,
                "sha256 for {} should be 64 hex chars",
                entry.name
            );
            assert!(
                entry.url.starts_with("https://"),
                "url for {} should start with https://",
                entry.name
            );
            assert!(!entry.sha256.is_empty());
        }
    }
}
