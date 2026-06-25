use sha2::{Digest, Sha256};

/// Metadata for a single model file to download on first use.
pub struct ModelFile {
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// Expected size in bytes. `ocr_models_present` compares this against the
    /// on-disk size so a same-filename model swap (changed content, e.g. fp32 →
    /// int8) is detected as not-present and re-downloaded — without hashing.
    pub size: u64,
}

/// Filename of the shared, language-agnostic text-block detector.
pub const DETECTOR_FILE: &str = "comic-text-detector.onnx";
/// Subdirectory (under `ocr-models/`) holding files shared across all languages.
pub const OCR_SHARED_DIR: &str = "shared";

impl ModelFile {
    /// True for files shared across all languages (the detector), which live in
    /// the shared cache dir instead of a per-language dir.
    pub fn is_shared(&self) -> bool {
        self.name == DETECTOR_FILE
    }
}

/// Returns true iff sha256(bytes) hex-equals `hex` (case-insensitive).
pub fn verify_sha256(bytes: &[u8], hex: &str) -> bool {
    let digest = Sha256::digest(bytes);
    hex::encode(digest).eq_ignore_ascii_case(hex)
}

// Dynamic-int8 quantized detector (53.4 MB vs 94.7 MB fp32); detection accuracy
// preserved (verified). The cache filename stays `comic-text-detector.onnx`.
const JA_DETECTOR_URL: &str = "https://github.com/julianshen/readest/releases/download/models-ja-v1/comic-text-detector.int8.onnx";
const JA_DETECTOR_SHA: &str = "d6b4b1136f028a65eade6316c9c7707fab2c59fa08d20b46a75e68b814773aa2";
const JA_DETECTOR_SIZE: u64 = 53_352_863;

/// The 4 Japanese model files to download on first use.
pub fn ja_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            name: DETECTOR_FILE,
            url: JA_DETECTOR_URL,
            sha256: JA_DETECTOR_SHA,
            size: JA_DETECTOR_SIZE,
        },
        ModelFile {
            name: "encoder_model.onnx",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "encoder_model.onnx"
            ),
            sha256: "f87668ae0f62d6f032dac6b213e8c0fea84cd15895ac8cab624cc9a2f49d4a27",
            size: 22_356_885,
        },
        ModelFile {
            name: "decoder_model.onnx",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "decoder_model.onnx"
            ),
            sha256: "6b1fb216d542c4b2a4fa5b9d7ae3522081eb85fb959d2cecd28055af956a8a5e",
            size: 118_053_454,
        },
        ModelFile {
            name: "vocab.txt",
            url: concat!(
                "https://github.com/julianshen/readest/releases/download/models-ja-v1/",
                "vocab.txt"
            ),
            sha256: "344fbb6b8bf18c57839e924e2c9365434697e0227fac00b88bb4899b78aa594d",
            size: 24_072,
        },
    ]
}

/// Per-language CTC recognizer spec: filenames in the cache dir + input height.
pub struct CtcSpec {
    pub rec_onnx: &'static str,
    pub dict: &'static str,
    pub input_h: u32,
}

/// CTC spec for ko/zh (PaddleOCR PP-OCRv5). None for non-CTC languages (ja).
pub fn ctc_spec(lang: &str) -> Option<CtcSpec> {
    match lang {
        // input_h = 48 confirmed by reading the ONNX graph input dim for BOTH
        // models (the monkt config.json's "32" is stale; the graph says 48).
        "ko" | "zh" => Some(CtcSpec {
            rec_onnx: "rec.onnx",
            dict: "dict.txt",
            input_h: 48,
        }),
        _ => None,
    }
}

/// Korean model files (detector shared from models-ja-v1 + PP-OCRv5 KO rec).
pub fn ko_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            name: DETECTOR_FILE,
            url: JA_DETECTOR_URL,
            sha256: JA_DETECTOR_SHA,
            size: JA_DETECTOR_SIZE,
        },
        ModelFile {
            name: "rec.onnx",
            url: "https://github.com/julianshen/readest/releases/download/models-ko-v1/rec.onnx",
            sha256: "322f140154c820fcb83c3d24cfe42c9ec70dd1a1834163306a7338136e4f1eaa",
            size: 13_401_252,
        },
        ModelFile {
            name: "dict.txt",
            url: "https://github.com/julianshen/readest/releases/download/models-ko-v1/dict.txt",
            sha256: "a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7",
            size: 47_451,
        },
    ]
}

/// Chinese model files (detector shared + PP-OCRv5 mobile rec: Simplified+Traditional+JP).
pub fn zh_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            name: DETECTOR_FILE,
            url: JA_DETECTOR_URL,
            sha256: JA_DETECTOR_SHA,
            size: JA_DETECTOR_SIZE,
        },
        ModelFile {
            name: "rec.onnx",
            url: "https://github.com/julianshen/readest/releases/download/models-zh-v1/rec.onnx",
            sha256: "da72dc72ca4dc220df0dfde68c1dedc31c58d3e76a25871122e5056227d50092",
            size: 16_534_782,
        },
        ModelFile {
            name: "dict.txt",
            url: "https://github.com/julianshen/readest/releases/download/models-zh-v1/dict.txt",
            sha256: "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b",
            size: 74_012,
        },
    ]
}

/// Download manifest for a supported language; None if unsupported.
pub fn manifest_for(lang: &str) -> Option<Vec<ModelFile>> {
    match lang {
        "ja" => Some(ja_manifest()),
        "ko" => Some(ko_manifest()),
        "zh" => Some(zh_manifest()),
        _ => None,
    }
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

    #[test]
    fn ko_zh_manifests_valid_and_share_detector() {
        for manifest in [ko_manifest(), zh_manifest()] {
            assert_eq!(manifest.len(), 3); // detector + rec.onnx + dict.txt
            for e in &manifest {
                assert_eq!(e.sha256.len(), 64, "{} sha len", e.name);
                assert!(e.url.starts_with("https://"), "{} url", e.name);
            }
        }
        assert_eq!(ko_manifest()[0].sha256, ja_manifest()[0].sha256);
        assert_eq!(zh_manifest()[0].sha256, ja_manifest()[0].sha256);
    }

    #[test]
    fn ctc_spec_and_manifest_for_dispatch() {
        assert!(ctc_spec("ko").is_some());
        assert!(ctc_spec("zh").is_some());
        assert!(ctc_spec("ja").is_none());
        assert!(manifest_for("ja").is_some());
        assert!(manifest_for("ko").is_some());
        assert!(manifest_for("zh").is_some());
        assert!(manifest_for("xx").is_none());
    }

    #[test]
    fn detector_is_the_only_shared_file() {
        for m in [ja_manifest(), ko_manifest(), zh_manifest()] {
            let shared: Vec<&str> = m.iter().filter(|f| f.is_shared()).map(|f| f.name).collect();
            assert_eq!(
                shared,
                vec![DETECTOR_FILE],
                "exactly the detector is shared"
            );
        }
        assert_eq!(OCR_SHARED_DIR, "shared");
    }

    #[test]
    fn every_manifest_entry_has_a_plausible_size() {
        // `ocr_models_present` compares on-disk size against `ModelFile::size`,
        // so a zero/missing expected size would make the check vacuous.
        for m in [ja_manifest(), ko_manifest(), zh_manifest()] {
            for e in &m {
                assert!(e.size > 0, "{} must have a non-zero expected size", e.name);
            }
        }
        // The detector size const is the int8 detector (53.4 MB), shared by all langs.
        assert_eq!(JA_DETECTOR_SIZE, 53_352_863);
        assert_eq!(ja_manifest()[0].size, JA_DETECTOR_SIZE);
        assert_eq!(ko_manifest()[0].size, JA_DETECTOR_SIZE);
        assert_eq!(zh_manifest()[0].size, JA_DETECTOR_SIZE);
    }
}
