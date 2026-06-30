//! ORT session construction policy for the OCR models. Centralizes the
//! execution-provider configuration so every session is built the same way.

/// Build an `ort` Session for an OCR model with the CPU memory arena disabled.
///
/// By default ORT registers the CPU execution provider with a memory arena that
/// pools activation buffers and never returns them to the OS while the session
/// lives. The OCR pipeline is cached for the whole process, so that arena
/// retains hundreds of MB after the first inference. Registering the CPU EP with
/// `with_arena_allocator(false)` emits `DisableCpuMemArena`, so ORT frees
/// activation buffers after each `run()` instead. This is an allocation-strategy
/// change only — model outputs are identical.
#[cfg(feature = "onnx")]
pub(crate) fn build_session(path: &std::path::Path) -> Result<ort::session::Session, String> {
    use ort::ep::CPUExecutionProvider;
    ort::session::Session::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .with_execution_providers([CPUExecutionProvider::default()
            .with_arena_allocator(false)
            .build()])
        .map_err(|e| format!("ort cpu ep: {e}"))?
        .commit_from_file(path)
        .map_err(|e| format!("ort load model {}: {e}", path.display()))
}

#[cfg(all(test, feature = "onnx"))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn build_session_loads_and_runs_with_arena_disabled() {
        // A session built with the CPU memory arena disabled must still load and
        // run a model correctly (outputs are unaffected by the allocation
        // strategy). Uses the embedded add_one fixture (y = x + 1).
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests-fixtures/add_one.onnx");
        let mut session = build_session(&fixture).expect("build_session should load the fixture");
        let y = crate::runtime::run_add_one(&mut session, vec![1.0, 2.0, 3.0]).expect("run");
        assert_eq!(y, vec![2.0, 3.0, 4.0]);
    }
}
