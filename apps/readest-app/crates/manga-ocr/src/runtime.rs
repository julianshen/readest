//! Thin wrapper over ONNX Runtime (`ort`). Proves the runtime works and gives
//! later phases the load + run primitives. Errors are Strings to match the
//! Tauri-command convention used across this codebase.
//!
//! `ort` is compiled only with the `onnx` feature (enabled for Android; opt-in
//! on desktop). Without it, `selftest` reports that the runtime isn't built in,
//! and the heavier load/run helpers are absent — so default desktop builds skip
//! `ort-sys` entirely.

#[cfg(feature = "onnx")]
use ndarray::Array1;
#[cfg(feature = "onnx")]
use ort::session::Session;
#[cfg(feature = "onnx")]
use ort::value::TensorRef;

/// A trivial ONNX model computing `y = x + 1`, embedded so the runtime can be
/// self-tested on any platform (notably to verify ONNX Runtime links + runs on
/// Android, where the dylib is loaded dynamically at runtime).
#[cfg(feature = "onnx")]
const ADD_ONE: &[u8] = include_bytes!("../tests-fixtures/add_one.onnx");

/// Load the embedded fixture and run it; returns `[2.0, 3.0, 4.0]` when the
/// ONNX runtime is healthy. Used by the `ocr_runtime_selftest` Tauri command.
#[cfg(feature = "onnx")]
pub fn selftest() -> Result<Vec<f32>, String> {
    let mut session = session_from_bytes(ADD_ONE)?;
    run_add_one(&mut session, vec![1.0, 2.0, 3.0])
}

/// Fallback when ONNX isn't compiled in (default desktop builds). Returns an
/// error rather than a value so callers can surface "runtime unavailable".
#[cfg(not(feature = "onnx"))]
pub fn selftest() -> Result<Vec<f32>, String> {
    Err("ONNX runtime not compiled in this build (enable the `onnx` feature)".to_string())
}

/// Build an `ort` Session from ONNX model bytes (CPU execution provider).
#[cfg(feature = "onnx")]
pub fn session_from_bytes(model: &[u8]) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .commit_from_memory(model)
        .map_err(|e| format!("ort load model: {e}"))
}

/// Run the `add_one` fixture model: input "x" -> output "y" = x + 1.
#[cfg(feature = "onnx")]
pub fn run_add_one(session: &mut Session, x: Vec<f32>) -> Result<Vec<f32>, String> {
    let input = Array1::from_vec(x);
    let tensor =
        TensorRef::from_array_view(input.view()).map_err(|e| format!("ort inputs: {e}"))?;
    let outputs = session
        .run(ort::inputs!["x" => tensor])
        .map_err(|e| format!("ort run: {e}"))?;
    let y = outputs["y"]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("ort extract: {e}"))?;
    Ok(y.1.to_vec())
}

#[cfg(all(test, feature = "onnx"))]
mod tests {
    use super::*;

    #[test]
    fn runs_a_trivial_onnx_model_on_cpu() {
        let mut session = session_from_bytes(ADD_ONE).expect("load fixture");
        let y = run_add_one(&mut session, vec![1.0, 2.0, 3.0]).expect("run");
        assert_eq!(y, vec![2.0, 3.0, 4.0]);
    }

    #[test]
    fn selftest_returns_x_plus_one() {
        assert_eq!(selftest().expect("selftest"), vec![2.0, 3.0, 4.0]);
    }
}
