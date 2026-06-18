//! Thin wrapper over ONNX Runtime (`ort`). Proves the runtime works and gives
//! later phases the load + run primitives. Errors are Strings to match the
//! Tauri-command convention used across this codebase.

use ndarray::Array1;
use ort::session::Session;
use ort::value::TensorRef;

/// Build an `ort` Session from ONNX model bytes (CPU execution provider).
pub fn session_from_bytes(model: &[u8]) -> Result<Session, String> {
    Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .commit_from_memory(model)
        .map_err(|e| format!("ort load model: {e}"))
}

/// Run the `add_one` fixture model: input "x" -> output "y" = x + 1.
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

#[cfg(test)]
mod tests {
    use super::*;

    const ADD_ONE: &[u8] = include_bytes!("../tests-fixtures/add_one.onnx");

    #[test]
    fn runs_a_trivial_onnx_model_on_cpu() {
        let mut session = session_from_bytes(ADD_ONE).expect("load fixture");
        let y = run_add_one(&mut session, vec![1.0, 2.0, 3.0]).expect("run");
        assert_eq!(y, vec![2.0, 3.0, 4.0]);
    }
}
