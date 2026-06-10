# Project Context: Readest E-Ink Optimization

## Overview
Readest 是一個跨平台電子書閱讀器（Next.js 16 + Tauri v2）。本次優化目標是針對 Boox 等 E-Ink 電子紙閱讀器做深度適配。

## Tech Stack
- **前端**: Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, daisyUI, Zustand, Biome
- **後端**: Tauri v2 (Rust), Tauri Plugins
- **行動端**: Android (Tauri gen), Kotlin plugins
- **建置**: pnpm monorepo, Gradle (Android), cargo (Rust)
- **測試**: Vitest, Playwright (browser tests)
- **套件管理**: pnpm

## Project Structure (E-Ink 相關)
| 路徑 | 用途 |
|------|------|
| `src-tauri/src/android/eink.rs` | Rust 層 E-Ink 裝置檢測 (127行) |
| `src-tauri/src/android/mod.rs` | Android 模組入口 |
| `src-tauri/src/lib.rs` | 啟動時注入 `__READEST_IS_EINK` 旗標 |
| `src/hooks/useEinkMode.ts` | 切換 data-eink attr + no-transitions class |
| `src/hooks/useTheme.ts` | E-Ink 主題邏輯 (isBwEink) |
| `src/services/nativeAppService.ts` | isEink 屬性橋接 |
| `src/services/constants.ts` | DEFAULT_EINK_VIEW_SETTINGS |
| `src/services/settingsService.ts` | E-Ink 設定擴散 |
| `src/store/themeStore.ts` | E-Ink 預設主題 'contrast' |
| `src/utils/style.ts` | E-Ink style generation (selection, underlines) |
| `src/styles/globals.css` (lines 503-670) | 26條 `[data-eink='true']` CSS rules |
| `src/components/settings/ControlPanel.tsx` | E-Ink Mode / Color E-Ink Mode 開關 |
| `src/components/settings/color/HighlightColorsEditor.tsx` | E-Ink 下停用透明度滑桿 |
| `src/types/book.ts` | viewSettings.isEink, isColorEink |
| `src/types/system.ts` | EnvConfig.isEink |
| `tailwind.config.ts` | `eink:` / `not-eink:` variants |

## 現有 E-Ink 支援 (已實作)
### 裝置檢測 (Rust)
- **18 家製造商**: onyx (BOOX), boox, amazon, kobo, remarkable, pocketbook, boyue, likebook, dasung, bigme, hisense, hanvon, tolino, bookeen, supernote, mobiscribe, xiaomi, meebook
- **16 型號 pattern**: kindle, hisense (a5pro/a7cc/a7e/a9), inkpalm, eink/e-ink, paper, note air/series, nova, poke, leaf, page, tab ultra, max lumi
- 透過 `libc::__system_property_get` 讀取 Android system properties
- 結果 `OnceLock` 快取

### UI/CSS 支援
- 26 條 CSS rules 涵蓋：陰影消除、顏色強制、邊框、按鈕反轉、modal、menu、popup、alert、checkbox
- Tailwind `eink:` / `not-eink:` variants
- `no-transitions` class 全域停用 CSS transitions
- E-Ink 選取樣式（反轉前景/背景）
- E-Ink 連結底線
- 滾動條透明度 1.0（非 0.5）

### 設定
- Settings → Misc → E-Ink Mode (開關)
- Settings → Misc → Color E-Ink Mode (開關，需先開 E-Ink Mode)
- E-Ink 模式自動設 `animated: false`、`volumeKeysToFlip: true`

### 啟動流程
1. Rust `is_eink_device()` 檢測
2. 若是 → 白底 window + `window.__READEST_IS_EINK = true`
3. Theme store 預設 theme = 'contrast'
4. DEFAULT_EINK_VIEW_SETTINGS 擴散

### 測試覆蓋
- `eink-dropdown-toggle.test.ts` — #4435 regression test
- `style-get-styles.test.ts` — eink selection styles
- `constants.test.ts` — DEFAULT_EINK_VIEW_SETTINGS

## 關鍵發現：未實作 / 可優化
### 🔴 高優先（Boox 體驗核心）
1. **無 EPD (E-Paper Display) 刷新控制** — 沒有 Boox SDK / 反射呼叫來控制螢幕更新模式（full/partial refresh、waveform modes）
2. **無翻頁全刷** — 沒有在翻頁時觸發 EPD full refresh（導致 ghosting 殘影累積）
3. **無 Android 動畫停用** — CSS transitions 已停用，但 Android 層的 window animations / activity transitions 未處理
4. **無 WebView 渲染優化** — WebView 的 hardware layer updates 未針對 e-ink 調整

### 🟡 中優先
5. **無 Boox 實體按鍵支援** — Boox 裝置有音量鍵/翻頁鍵，但無專用處理
6. **無 E-Ink 指標/觸控優化** — 觸控延遲、長按行為未針對 e-ink 特性調整
7. **無頁面切換特效優化** — 已經 `animated: false`，但確認無殘留動畫

### 🟢 低優先
8. **無 E-Ink 省電模式** — 減少背景重繪、降低 WebView refresh rate
9. **無 PDF reflow 優化** — PDF 在 e-ink 上的閱讀體驗
10. **無 CABC 控制** — Content Adaptive Backlight Control

## Android Plugin Architecture
- `NativeBridgePlugin.kt` — 原生橋接插件，使用 `CoroutineScope` + `@Command` 與 JS 層溝通
- `ClipUrlController.kt` — URL 剪藏控制器
- `MainActivity.kt` — 主要 Activity，處理 touch/key events
- `MediaPlaybackService.kt` — 媒體播放服務
- `WebViewUpgradeInitializer.kt` — WebView 升級

## Development Commands
```bash
pnpm dev-web              # Web-only dev
pnpm tauri dev            # Desktop dev
pnpm build                # Build Next.js for Tauri
pnpm test                 # Unit tests
pnpm lint                 # Biome + tsgo
# APK Build
cd src-tauri/gen/android && \
  JAVA_HOME=~/.jdks/jdk-17.0.14+7 ./gradlew :app:assembleArm64Debug \
  -PabiList=arm64-v8a -ParchList=arm64 -PtargetList=aarch64
```

## Key Constraints
- **Boox SDK 不可直接依賴** — 使用 reflection 避免 compile-time dependency
- **EPD API 需相容多家裝置** — 不只是 Boox，也要考慮 Bigme、Hisense 等
- **不得破壞 WebView 渲染** — EPD 控制需在正確時機觸發
- **WebView 為核心** — 所有 UI 都是 WebView 內渲染，Android 層僅做原生橋接
