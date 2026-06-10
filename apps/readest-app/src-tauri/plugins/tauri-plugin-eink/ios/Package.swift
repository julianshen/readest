// swift-tools-version:5.3
import PackageDescription
let package = Package(
    name: "tauri-plugin-eink",
    platforms: [.macOS(.v10_13), .iOS(.v14)],
    products: [
        .library(name: "tauri-plugin-eink", type: .static, targets: ["tauri-plugin-eink"])
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(name: "tauri-plugin-eink", dependencies: [.byName(name: "Tauri")], path: "Sources")
    ]
)
