use std::time::Duration;

use cocoa::base::{id, nil};
use objc::{class, msg_send, sel, sel_impl};

use crate::models::{
    ICloudContainerStatusResponse, ICloudEnsureDownloadedRequest, ICloudEnsureDownloadedResponse,
};

pub fn icloud_container_status() -> crate::Result<ICloudContainerStatusResponse> {
    use cocoa::foundation::NSString;

    let container_path = unsafe {
        let file_manager: id = msg_send![class!(NSFileManager), defaultManager];
        let url: id = msg_send![file_manager, URLForUbiquityContainerIdentifier: nil];
        if url == nil {
            return Ok(ICloudContainerStatusResponse {
                available: false,
                documents_path: None,
            });
        }
        let path: id = msg_send![url, path];
        let c_string = NSString::UTF8String(path);
        std::ffi::CStr::from_ptr(c_string)
            .to_string_lossy()
            .into_owned()
    };

    let documents = std::path::Path::new(&container_path).join("Documents");
    std::fs::create_dir_all(&documents).map_err(|error| {
        crate::Error::NativeBridgeError(format!("create Documents failed: {error}"))
    })?;
    Ok(ICloudContainerStatusResponse {
        available: true,
        documents_path: Some(documents.to_string_lossy().into_owned()),
    })
}

pub fn icloud_ensure_downloaded(
    payload: ICloudEnsureDownloadedRequest,
) -> crate::Result<ICloudEnsureDownloadedResponse> {
    let response = |status: &str| {
        Ok(ICloudEnsureDownloadedResponse {
            status: status.to_owned(),
        })
    };
    let target = std::path::PathBuf::from(&payload.path);
    if target.exists() {
        return response("ready");
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let placeholder = target.with_file_name(format!(".{name}.icloud"));
    if !placeholder.exists() {
        return response("notFound");
    }

    start_downloading_ubiquitous_item(&payload.path);
    let deadline =
        std::time::Instant::now() + Duration::from_millis(payload.timeout_ms.unwrap_or(60_000));
    while std::time::Instant::now() < deadline {
        if target.exists() {
            return response("ready");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    response("timeout")
}

fn start_downloading_ubiquitous_item(path: &str) {
    use cocoa::foundation::NSString;

    unsafe {
        let file_manager: id = msg_send![class!(NSFileManager), defaultManager];
        let ns_path: id = NSString::alloc(nil).init_str(path);
        let url: id = msg_send![class!(NSURL), fileURLWithPath: ns_path];
        let _: objc::runtime::BOOL =
            msg_send![file_manager, startDownloadingUbiquitousItemAtURL: url error: nil];
    }
}
