# Tasks: E-Ink / Boox 閱讀器深度優化

## Task 1: 建立 tauri-plugin-eink 外掛骨架
**Priority:** P0
**Estimate:** Small
**Dependencies:** None

### Description
建立 `tauri-plugin-eink` 目錄結構（Rust + Android Kotlin），作為 EPD 控制的核心外掛。

### Acceptance Criteria
- [ ] `src-tauri/plugins/tauri-plugin-eink/` 目錄存在
- [ ] Rust `lib.rs` 有 `@TauriPlugin` 標記和基本的 `Command` handler
- [ ] Android `EinkPlugin.kt` 繼承 `Plugin(activity)`
- [ ] Plugin 在 `Cargo.toml` 中註冊
- [ ] `pnpm build` 通過

### Files to Create
- `src-tauri/plugins/tauri-plugin-eink/Cargo.toml`
- `src-tauri/plugins/tauri-plugin-eink/src/lib.rs`
- `src-tauri/plugins/tauri-plugin-eink/android/src/main/java/EinkPlugin.kt`
- `src-tauri/plugins/tauri-plugin-eink/build.rs`
- `src-tauri/plugins/tauri-plugin-eink/plugin.json`

### Testing
- [ ] `pnpm clippy:check` 通過
- [ ] APK build 通過

---

## Task 2: 實作 ReflectionEpdBridge — Boox EPD 反射橋接
**Priority:** P0
**Estimate:** Medium
**Dependencies:** Task 1

### Description
在 `EinkPlugin.kt` 中實作反射式 EPD controller。透過 `Class.forName("com.onyx.android.sdk.device.EpdController")` 動態載入 Boox SDK，無硬依賴，非 Boox 裝置自動降級。

### Acceptance Criteria
- [ ] `initReflection()` 嘗試載入 `EpdController` class
- [ ] `reflectPostInvalidate(view, mode)` 反射呼叫 `EpdController.postInvalidate()`
- [ ] `reflectSetMode(context, mode)` 反射呼叫 `EpdController.setMode()`
- [ ] `reflectClearScreen()` 全刷（GC mode）
- [ ] `getCapabilities()` 回傳是否支援 EPD + 可用 mode list
- [ ] 所有反射呼叫在 ClassNotFoundException 時優雅降級（回傳空/關閉功能）
- [ ] `@Volatile isAvailable: Boolean` 快取檢測結果

### Files to Modify
- `src-tauri/plugins/tauri-plugin-eink/android/src/main/java/EinkPlugin.kt`

### Testing
- [ ] Unit test: 反射載入成功路徑
- [ ] Unit test: 非 Boox 裝置降級路徑
- [ ] APK build 通過

---

## Task 3: NativeBridgePlugin 擴充 — 3 個 EPD Commands
**Priority:** P0
**Estimate:** Small
**Dependencies:** Task 2

### Description
在 `NativeBridgePlugin.kt` 新增 3 個 `@Command` 方法，讓 JS 層可以觸發 EPD 功能。

### Acceptance Criteria
- [ ] `get_epd_capabilities(invoke)` — 回傳 `{ available: boolean, modes: string[] }`
- [ ] `set_epd_mode(invoke)` — 接受 `mode: string` 參數（AUTO/TEXT/A2/GC16/REGAL）
- [ ] `do_epd_refresh(invoke)` — 對 decor view 發送 GC 全刷
- [ ] 使用 `pluginScope` 確保不在主線程做 I/O
- [ ] `if (isActive)` guard

### Files to Modify
- `src-tauri/plugins/tauri-plugin-native-bridge/android/src/main/java/NativeBridgePlugin.kt`

### Testing
- [ ] APK build 通過
- [ ] JS invoke 正確轉發

---

## Task 4: JS 層 — 翻頁全刷 Hook
**Priority:** P0
**Estimate:** Medium
**Dependencies:** Task 3

### Description
在 reader 的 JS 層實作翻頁計數器，每 N 頁觸發一次 `do_epd_refresh`。同時讀取 EPD capabilities 並初始化 refresh interval。

### Acceptance Criteria
- [ ] Reader 頁面變更時更新計數器
- [ ] 計數到達 `refreshInterval`（預設 5）時呼叫 `invoke('do_epd_refresh')`
- [ ] 重置計數器
- [ ] 從 `get_epd_capabilities` 讀取裝置支援
- [ ] refreshInterval 可透過 settings store 調整

### Files to Modify
- `src/components/reader/Reader.tsx`（或相關 reader component）
- `src/hooks/useEinkMode.ts` — 擴充 EPD 控制
- `src/store/readerStore.ts` — 加入 `epdRefreshInterval` state（如適用）

### Testing
- [ ] `pnpm test` 通過
- [ ] 翻頁計數器邏輯的正確性

---

## Task 5: Android 動畫停用
**Priority:** P1
**Estimate:** Small
**Dependencies:** Task 1?（理論上獨立）

### Description
在 `MainActivity.kt` 中，當 E-Ink 裝置啟用時，停用所有 Android window animations 和 activity transitions。

### Acceptance Criteria
- [ ] `window.setWindowAnimations(0)` 在 e-ink 模式時執行
- [ ] `overridePendingTransition(0, 0)` 在 `onCreate` 中執行
- [ ] Activity restore 時（`onResume`）也停用 transition
- [ ] 非 e-ink 裝置不受影響

### Files to Modify
- `apps/readest-app/src-tauri/gen/android/app/src/main/java/com/jlnshen/reader/MainActivity.kt`

### Testing
- [ ] APK build 通過
- [ ] 非 e-ink 裝置無行為改變

---

## Task 6: Boox 實體按鍵支援
**Priority:** P1
**Estimate:** Small
**Dependencies:** None

### Description
在 `MainActivity.kt` 的 `dispatchKeyEvent` 中，加入 Boox 裝置專用 key codes（KEYCODE_PAGE_UP=92, KEYCODE_PAGE_DOWN=93, KEYCODE_PROG_RED=142, KEYCODE_PROG_GREEN=143）。

### Acceptance Criteria
- [ ] 92/93 map 到 PageUp/PageDown
- [ ] 142/143 map 到 AppSwitch/Refresh
- [ ] 與現有 `interceptPageTurnerKeysEnabled` / `keyLearnModeEnabled` 整合
- [ ] 非 Boox 裝置不受影響

### Files to Modify
- `apps/readest-app/src-tauri/gen/android/app/src/main/java/com/jlnshen/reader/MainActivity.kt`

### Testing
- [ ] APK build 通過
- [ ] Key forwarding 邏輯正確

---

## Task 7: WebView 渲染優化
**Priority:** P2
**Estimate:** Small
**Dependencies:** None

### Description
在 e-ink 模式下對 WebView 進行渲染優化：
- Software layer type（避免 hardware layer 更新造成閃爍）
- 減少 repaint 排程
- 白底設定

### Acceptance Criteria
- [ ] `webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)` 在 e-ink 模式
- [ ] WebView 背景白色
- [ ] `onWebViewCreate` 中處理

### Files to Modify
- `apps/readest-app/src-tauri/gen/android/app/src/main/java/com/jlnshen/reader/MainActivity.kt`

### Testing
- [ ] APK build 通過
- [ ] 非 e-ink 裝置無行為改變

---

## Task 8: Settings UI 擴充
**Priority:** P2
**Estimate:** Medium
**Dependencies:** Task 3

### Description
在 Settings → Misc 的 E-Ink section 加入：
- 螢幕更新模式選擇器（AUTO/TEXT/A2/GC16/REGAL）
- 翻頁全刷間隔滑桿（0=關閉, 1-20 頁）
- 只在 E-Ink Mode 開啟時顯示

### Acceptance Criteria
- [ ] 更新模式 Select 元件，選項來自 `get_epd_capabilities`
- [ ] 全刷間隔 Slider，範圍 1-20，預設 5
- [ ] 設定存到 viewSettings
- [ ] E-Ink Mode 關閉時隱藏
- [ ] 非 Android / web 平台隱藏

### Files to Modify
- `src/components/settings/ControlPanel.tsx`
- `src/services/constants.ts` — 加入 EPD view settings 預設值
- `src/types/book.ts` — 加入 `epdMode` / `epdRefreshInterval` 型別

### Testing
- [ ] `pnpm test` 通過
- [ ] 設定值正確持久化

---

## Task 9: 驗證與測試
**Priority:** P2
**Estimate:** Medium
**Dependencies:** Task 1-8

### Description
完整測試流程：
1. 所有 unit tests 通過
2. APK build 通過
3. 前端 e-ink CSS regression test 通過
4. 手動驗證 on Boox device（需實體裝置）

### Acceptance Criteria
- [ ] `pnpm test` 全部通過
- [ ] `pnpm lint` 全部通過
- [ ] APK arm64 build 成功
- [ ] EPD refresh 在 Boox 裝置上正常觸發
- [ ] 非 Boox 裝置無 crash / regression

### Testing
- [ ] Full test suite
- [ ] Regression test: dropdown-toggle e-ink test
- [ ] Regression test: eink selection styles test
