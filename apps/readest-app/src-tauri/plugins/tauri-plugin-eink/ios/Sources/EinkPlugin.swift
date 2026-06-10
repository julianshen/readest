import Tauri
import UIKit

class EinkPlugin: Plugin {
    @objc public override func load(webview: WKWebView) {
        webview.configuration.userContentController.add(self, name: "eink")
    }
    
    @objc func getEpdCapabilities(_ invoke: Invoke) throws {
        invoke.resolve(["available": false, "modes": [] as [String]])
    }
    
    @objc func setEpdMode(_ invoke: Invoke) throws {
        invoke.reject("Not supported on iOS")
    }
    
    @objc func doEpdRefresh(_ invoke: Invoke) throws {
        invoke.reject("Not supported on iOS")
    }
}
