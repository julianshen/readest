const COMMANDS: &[&str] = &[
    "get_epd_capabilities",
    "set_epd_mode",
    "do_epd_refresh",
    "register_listener",
    "remove_listener",
    "check_permissions",
    "request_permissions",
    "checkPermissions",
    "requestPermissions",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
