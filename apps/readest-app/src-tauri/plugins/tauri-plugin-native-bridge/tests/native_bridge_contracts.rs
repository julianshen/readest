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
fn ios_secure_item_set_updates_existing_entries_instead_of_value_delete() {
    // Regression contract for the review finding: `SecItemDelete` must not
    // receive a query containing kSecValueData — the value is not part of a
    // Keychain item's identity, so the old token survives the delete and the
    // following SecItemAdd fails with errSecDuplicateItem.
    let swift = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("ios/Sources/NativeBridgePlugin.swift"),
    )
    .unwrap();
    let set_fn_start = swift.find("func set_secure_item").expect("set_secure_item exists");
    let set_fn_end = swift[set_fn_start..]
        .find("@objc public func get_secure_item")
        .map(|i| set_fn_start + i)
        .expect("get_secure_item follows set_secure_item");
    let set_fn = &swift[set_fn_start..set_fn_end];

    assert!(
        set_fn.contains("SecItemUpdate"),
        "set_secure_item must update existing items in place"
    );
    assert!(
        !set_fn.contains("SecItemDelete"),
        "set_secure_item must not delete with a value-bearing query"
    );
    assert!(
        set_fn.contains("errSecItemNotFound"),
        "set_secure_item must add only when no item exists"
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
fn android_oauth_callbacks_require_the_active_provider_target() {
    let google: AuthRequest = serde_json::from_value(json!({
        "authUrl": "https://provider.example/authorize",
        "callbackUrl": "com.googleusercontent.apps.209390247301-ctpmep68ppfa56r1b8tr35e4qi4p60kq:/oauthredirect"
    }))
    .unwrap();
    let onedrive: AuthRequest = serde_json::from_value(json!({
        "authUrl": "https://provider.example/authorize",
        "callbackUrl": "readest-onedrive://auth"
    }))
    .unwrap();
    let android_dir =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("android/src/main/java");
    let kotlin_source = std::fs::read_to_string(android_dir.join("NativeBridgePlugin.kt")).unwrap();
    let callback_target_source =
        std::fs::read_to_string(android_dir.join("OAuthCallbackTarget.kt")).unwrap();
    let pending_request_source =
        std::fs::read_to_string(android_dir.join("OAuthPendingRequest.kt")).unwrap();
    let auth_page_source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/app/auth/page.tsx"),
    )
    .unwrap();
    let kotlin_test_source =
        std::fs::read_to_string(android_dir.join("../../test/java/OAuthCallbackTargetTest.kt"))
            .unwrap();
    let pending_request_test_source =
        std::fs::read_to_string(android_dir.join("../../test/java/OAuthPendingRequestTest.kt"))
            .unwrap();

    assert_eq!(
        serde_json::to_value(google).unwrap()["callbackUrl"],
        "com.googleusercontent.apps.209390247301-ctpmep68ppfa56r1b8tr35e4qi4p60kq:/oauthredirect"
    );
    assert_eq!(
        serde_json::to_value(onedrive).unwrap()["callbackUrl"],
        "readest-onedrive://auth"
    );
    assert!(kotlin_source.contains("var callbackUrl: String? = null"));
    assert!(kotlin_source.contains("private const val OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000L"));
    assert!(kotlin_source.contains("OAuthPendingRequest<Invoke>"));
    assert!(kotlin_source.contains("OAuth authorization already in progress"));
    assert!(kotlin_source.contains("OAuth authorization timed out"));
    assert!(kotlin_source.contains("if (intent.action == Intent.ACTION_VIEW)"));
    assert!(kotlin_source.contains("pendingAuthRequest.takeMatching(uri.toString())"));
    assert!(callback_target_source
        .contains("fun matches(callbackUrl: String): Boolean = parse(callbackUrl) == this"));
    assert!(callback_target_source.contains("scheme = scheme.lowercase(Locale.ROOT)"));
    assert!(callback_target_source.contains("path = normalizeRootPath(uri.rawPath)"));
    assert!(auth_page_source
        .contains("authWithCustomTab({ authUrl: data.url, callbackUrl: redirectTo })"));
    for fixture in [
        "googleCallback_matchesItsReverseDnsSchemeAndRegisteredPath",
        "supabaseCallback_matchesOnlyItsRegisteredDestination",
        "oneDriveCallback_matchesOnlyItsExpectedHostAndRootPath",
        "COM.GOOGLEUSERCONTENT.APPS",
        "READEST-ONEDRIVE://auth/?code=CODE&state=STATE",
        "readest-onedrive://attacker/?code=CODE",
        "https://provider.example/oauthredirect?code=CODE",
        "readest://auth-callback#access_token=ACCESS&refresh_token=REFRESH",
    ] {
        assert!(kotlin_test_source.contains(fixture));
    }
    for fixture in [
        "timeout_clearsTheRequestAndAllowsAnotherAuthorization",
        "replacement_doesNotOverwriteTheActiveAuthorization",
        "exactCallback_clearsTheRequestAndCancelsItsDeadline",
        "callbackCleanup_ignoresRepeatedCallbackAndCancelledDeadline",
        "arbitraryCallback_leavesTheActiveAuthorizationUntouched",
    ] {
        assert!(pending_request_test_source.contains(fixture));
    }
    assert!(pending_request_source.contains("interface OAuthDeadlineScheduler"));
    assert!(pending_request_source.contains("interface OAuthDeadline"));
    assert!(pending_request_source.contains("fun begin("));
    assert!(pending_request_source.contains("fun takeMatching("));
    assert!(pending_request_source.contains("fun remove("));
    assert!(!kotlin_source.contains("uri.scheme == \"readest\""));
    assert!(!kotlin_source.contains("scheme.startsWith(\"com.googleusercontent.apps.\")"));
}

#[test]
fn desktop_deep_link_config_registers_all_oauth_schemes() {
    let tauri_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(tauri_dir.join("tauri.conf.json")).unwrap())
            .unwrap();
    let schemes = config["plugins"]["deep-link"]["desktop"]["schemes"]
        .as_array()
        .unwrap();

    for scheme in [
        "readest",
        "com.googleusercontent.apps.209390247301-ctpmep68ppfa56r1b8tr35e4qi4p60kq",
        "readest-onedrive",
    ] {
        assert!(schemes.iter().any(|registered| registered == scheme));
    }
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
