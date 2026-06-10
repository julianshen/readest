# Android 無回應 / Timeout 診斷報告

分析基於 fork `julianshen/readest` 的 `main` 分支。

## 🔴 高風險

### 1. NativeBridge 主線程執行所有 I/O
**檔案：** `apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/android/src/main/java/NativeBridgePlugin.kt`

所有 `@Command` 方法都在主線程同步執行，未使用 `Dispatchers.IO`：
- `copy_uri_to_path` (L271-295)：大型檔案複製阻塞主線程
- `get_sys_fonts_list` (L436-477)：掃描 `/system/fonts` 數百字型在主線程
- `get_external_sdcard_path` (L699-713)：遍歷外部儲存目錄

**影響：** 每次 I/O 凍結 UI 100ms～數秒，頻繁觸發即 ANR。

**建議修復：** 所有涉及 I/O 的 `@Command` 改為 `Dispatchers.IO`。

### 2. ClipUrlController WebView 記憶體洩漏 + 30 秒硬超時
**檔案：** `ClipUrlController.kt` (L69-346)

- `finish()` 從未呼叫 `webView?.destroy()`，多次調用累積多個 WebView 實例
- `HARD_TIMEOUT_MS = 30000` (L83)：應用完全凍結 30 秒
- WebView JS 評估 `outerHTML` (L293) 在主線程長時間執行

**建議修復：** `finish()` 中顯式 `webView?.destroy()`；考慮快取；降低超時。

### 3. KeyDownInterceptor 未被 Activity 實作（靜默失敗）
**檔案：** `NativeBridgePlugin.kt` (L122-127)

`intercept_keys` 檢查 `activity is KeyDownInterceptor`，但 Tauri 預設 Android Activity 未實作此介面。攔截操作被吞掉，前後端都不知道失敗。

**建議修復：** 確保 Activity 實作 `KeyDownInterceptor`，或前端檢測時 fallback。

## 🟡 中風險

### 4. TTS 事件通道無限緩衝（即使未啟用 TTS）
**檔案：** `NativeTTSPlugin.kt` (L252-253)

`eventChannels` 使用 `Channel(UNLIMITED)`。雖然未啟用 TTS 時不會觸發，但啟用後大量 `onRangeStart` 事件可能淹沒主線程。

### 5. MediaPlaybackService 持續佔用資源
**檔案：** `MediaPlaybackService.kt` (L64-112)

- `silence.mp3` 循環持續播放，即使無 TTS 朗讀
- Audio Focus 從未釋放
- 消耗 CPU/電池 → 裝置降頻

### 6. SQLite 操作未隔離
**檔案：** `nativeDatabaseService.ts` (L27-48)

Turso/SQLite 查詢直接透過 IPC 到 Rust，無 timeout 處理。

### 7. allow_paths_in_scopes Android 空操作
**檔案：** `lib.rs` (L166-171), `nativeAppService.ts` (L626-632)

Android 上此命令為空操作，但前端仍同步 `invoke()`，浪費 IPC。

### 8. useBrightnessGesture capture-phase 攔截
**檔案：** `useBrightnessGesture.ts` (L117-185)

`capture: true` + `stopImmediatePropagation()` 可能在左邊緣滑動時誤攔截翻頁。

## 🟢 低風險

### 9. E-Ink `__system_property_get` 啟動延遲
**檔案：** `eink.rs` (L48-64)

使用 `libc::__system_property_get` 讀系統屬性，但結果透過 `OnceLock` 快取，僅一次性開銷。

### 10. Touch Interceptor 全域 Map 競爭
**檔案：** `useTouchInterceptor.ts` (L19-40)

元件卸載後可能持有陳舊 handler 參考。

## 根因排序

| 排名 | 問題 | 症狀 |
|:---:|------|------|
| **#1** | **NativeBridge 全部跑在主線程** | 字型掃描/檔案複製時凍結數秒 → ANR |
| **#2** | **WebView 記憶體洩漏 + 30s 超時** | 應用越來越慢，最終 ANR |
| **#3** | **亮度手勢誤攔截觸控** | 特定邊緣操作無回應 |
| **#4** | **按鍵攔截失效** | 返回鍵/音量鍵行為異常 |
