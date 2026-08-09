use serde_json::json;
use tauri_plugin_native_bridge::{
    AuthRequest, GetSecureItemRequest, ICloudContainerStatusResponse,
    ICloudEnsureDownloadedRequest, ICloudEnsureDownloadedResponse, SecureItemResponse,
    SetSecureItemRequest,
};

#[test]
fn secure_item_requests_and_responses_use_the_js_wire_contract() {
    let set: SetSecureItemRequest = serde_json::from_value(json!({
        "key": "gdrive-token",
        "value": "secret"
    }))
    .unwrap();
    let get: GetSecureItemRequest =
        serde_json::from_value(json!({ "key": "gdrive-token" })).unwrap();

    assert_eq!(
        serde_json::to_value(set).unwrap(),
        json!({ "key": "gdrive-token", "value": "secret" }),
    );
    assert_eq!(
        serde_json::to_value(get).unwrap(),
        json!({ "key": "gdrive-token" }),
    );
    assert_eq!(
        serde_json::to_value(SecureItemResponse {
            success: true,
            error: None,
        })
        .unwrap(),
        json!({ "success": true, "error": null }),
    );
}

#[test]
fn auth_request_forwards_an_optional_callback_scheme_to_mobile() {
    let request: AuthRequest = serde_json::from_value(json!({
        "authUrl": "https://provider.example/authorize",
        "callbackScheme": "com.googleusercontent.apps.example"
    }))
    .unwrap();

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({
            "authUrl": "https://provider.example/authorize",
            "callbackScheme": "com.googleusercontent.apps.example"
        }),
    );
}

#[test]
fn auth_request_omits_an_unspecified_callback_scheme() {
    let request: AuthRequest = serde_json::from_value(json!({
        "authUrl": "https://provider.example/authorize"
    }))
    .unwrap();

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        json!({ "authUrl": "https://provider.example/authorize" }),
    );
}

#[test]
fn icloud_capability_and_apple_signing_include_container_access() {
    let tauri_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let capability: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(tauri_dir.join("capabilities/default.json")).unwrap(),
    )
    .unwrap();
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(tauri_dir.join("tauri.conf.json")).unwrap())
            .unwrap();
    let macos_entitlements =
        std::fs::read_to_string(tauri_dir.join("profiles/direct-entitlements.plist")).unwrap();
    let ios_entitlements =
        std::fs::read_to_string(tauri_dir.join("gen/apple/Readest_iOS/Readest_iOS.entitlements"))
            .unwrap();
    let ios_project =
        std::fs::read_to_string(tauri_dir.join("gen/apple/Readest.xcodeproj/project.pbxproj"))
            .unwrap();
    let capability_json = capability.to_string();

    assert!(capability_json
        .contains("$HOME/Library/Mobile Documents/iCloud.com.bilingify.readest/Documents/**/*"));
    assert!(capability_json.contains(
        "/private/var/mobile/Library/Mobile Documents/iCloud.com.bilingify.readest/Documents/**/*"
    ));
    assert_eq!(
        config["bundle"]["macOS"]["entitlements"],
        "./profiles/direct-entitlements.plist"
    );
    for entitlements in [&macos_entitlements, &ios_entitlements] {
        assert!(entitlements.contains("com.apple.developer.icloud-container-identifiers"));
        assert!(entitlements.contains("CloudDocuments"));
    }
    assert!(ios_project.contains("CODE_SIGN_ENTITLEMENTS = Readest_iOS/Readest_iOS.entitlements"));
}

#[test]
fn icloud_models_use_camel_case_wire_names() {
    let request: ICloudEnsureDownloadedRequest =
        serde_json::from_value(json!({ "path": "/container/Documents/a.json", "timeoutMs": 5000 }))
            .unwrap();
    assert_eq!(request.path, "/container/Documents/a.json");
    assert_eq!(request.timeout_ms, Some(5000));

    assert_eq!(
        serde_json::to_value(ICloudContainerStatusResponse {
            available: false,
            documents_path: None,
        })
        .unwrap(),
        json!({ "available": false }),
    );
    assert_eq!(
        serde_json::to_value(ICloudEnsureDownloadedResponse {
            status: "notFound".to_owned(),
        })
        .unwrap(),
        json!({ "status": "notFound" }),
    );
}
