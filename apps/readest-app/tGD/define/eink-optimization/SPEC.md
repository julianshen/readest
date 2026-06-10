# SPEC: E-Ink / Boox 閱讀器深度優化

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        JS Layer (WebView)                            │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────────────┐ │
│  │ useEink   │  │ Reader       │  │ Settings Panel                 │ │
│  │ Mode     │  │ (page turn)  │  │ (E-Ink Mode, Refresh Interval) │ │
│  └────┬─────┘  └──────┬───────┘  └──────────┬─────────────────────┘ │
│       │               │                      │                        │
│  ┌────▼───────────────▼──────────────────────▼────────────────────┐  │
│  │              NativeBridgePlugin (Tauri @Command)                │  │
│  │  set_epd_mode()  /  do_epd_full_refresh()  /  get_epd_capabilities()│
│  └──────────────────────────┬───────────────────────────────────────┘  │
├─────────────────────────────┼──────────────────────────────────────────┤
│                     Android Native Layer                               │
│  ┌──────────────────────────▼──────────────────────────────────────┐  │
│  │                    EPDControllerPlugin.kt                        │  │
│  │  ┌─────────────────────────────────────────────────────────┐    │  │
│  │  │  ReflectionEpdBridge (reflection to Boox SDK)           │    │  │
│  │  │  • EpdController.setMode()                              │    │  │
│  │  │  • EpdController.postInvalidate(view, mode)             │    │  │
│  │  │  • Alternative: SystemProperties / ServiceManager       │    │  │
│  │  └─────────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  MainActivity.kt (Touch Throttle + Key Handler Enhancement)      │  │
│  │  • dispatchTouchEvent → E-Ink latency aware                      │  │
│  │  • dispatchKeyEvent → Boox physical buttons                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **翻頁全刷**: JS reader 翻頁 → invoke `do_epd_full_refresh()` → `NativeBridgePlugin` → `EPDControllerPlugin.fullRefresh()` → 反射呼叫 `EpdController.postInvalidate(GC)` → 若反射失敗則 `view.postInvalidateDelayed()`
2. **設定 EPD Mode**: Settings → invoke `set_epd_mode(mode)` → `NativeBridgePlugin` → `EPDControllerPlugin.setMode(mode)` → `EpdController.setMode()`
3. **實體按鍵**: KeyEvent → `MainActivity.dispatchKeyEvent()` → 識別 Boox key codes → forwarding to WebView
4. **動畫停用**: App startup → Android Window flags → `window.setWindowAnimations(0)`

## Implementation Plan

### P0: EPD 刷新控制器（EPDControllerPlugin.kt）

新檔案：`src-tauri/plugins/tauri-plugin-eink/android/src/main/java/EpdControllerPlugin.kt`

```kotlin
class EpdControllerPlugin(private val activity: Activity) {
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // Reflection-accessed Boox EPD controller
    private var epdControllerClass: Class<*>? = null
    private var isValid: Boolean = false

    init {
        initReflection()
    }

    private fun initReflection() {
        try {
            epdControllerClass = Class.forName("com.onyx.android.sdk.device.EpdController")
            isValid = true
        } catch (e: ClassNotFoundException) {
            isValid = false  // Non-Boox device
        }
    }

    fun getCapabilities(): EPDCapabilities { ... }

    fun setEpdMode(mode: EPDMode) { ... }

    fun postFullRefresh() {
        // Post invalidation with GC (high-quality) mode on the decor view
        activity.window.decorView?.let { view ->
            reflectPostInvalidate(view, "GC")
        }
    }

    fun postClearScreen() {
        // Clear screen / A2 refresh
        reflectPostInvalidate(view, "GU")
    }

    private fun reflectPostInvalidate(view: View, mode: String) { ... }
    private fun reflectSetMode(context: Context, mode: String) { ... }
}
```

### P0: NativeBridgePlugin 擴充

在 `NativeBridgePlugin.kt` 新增 3 個 `@Command`：

```kotlin
@Command
fun get_epd_capabilities(invoke: Invoke) { ... }

@Command
fun set_epd_mode(invoke: Invoke) {
    // JS → "AUTO", "TEXT", "A2", "GC16"
}

@Command
fun do_epd_refresh(invoke: Invoke) {
    // 《全刷新：使用 GC mode 清除殘影》
    // 可以在翻頁的 JS 邏輯中被呼叫
}
```

### P0: JS 整合 — 翻頁全刷

在 `NativeBridgePlugin` (Rust side) 或 JS reader layer 中加入翻頁 hook。

1. **Rust 層** (`src-tauri/plugins/tauri-plugin-native-bridge/src/lib.rs`)：將 JS invoke 轉發到 Android plugin
2. **JS 層**：在 reader 的 `onPageChanged` 回呼中：

```typescript
// Reader component
const { invoke } = useTauriInvoke();
const [epdRefreshCount, setEpdRefreshCount] = useState(0);

// 每 N 頁觸發一次全刷（user-configurable）
useEffect(() => {
    if (epdRefreshCount >= refreshInterval) {
        invoke('do_epd_refresh');
        setEpdRefreshCount(0);
    }
}, [currentPage]); // currentPage 從 reader store 取得
```

**預設 refresh interval**: 5 頁（可透過 E-Ink 設定調整，1-20 頁）

### P0: Tauri Plugin: tauri-plugin-eink

為保持模組化，EPD 控制做成獨立 Tauri plugin：

```
src-tauri/plugins/tauri-plugin-eink/
├── android/
│   └── src/main/java/
│       └── EinkPlugin.kt          ← Tauri Plugin + EPD controller
├── ios/
│   └── (placeholder, no e-ink hardware)
├── src/
│   └── lib.rs                      ← Rust side (command proxies)
└── permissions/
    └── (auto-generated)
```

**Why separate plugin?**
- EPD 控制邏輯與 native-bridge plugin 關注點不同
- 便於未來加入更多 e-ink 功能
- 非 e-ink 裝置可完全忽略此 plugin

### P1: Android 動畫停用

在 `MainActivity.kt` 的 `onCreate` 中，若檢測到 e-ink（`__READEST_IS_EINK` 由 Rust 注入）：

```kotlin
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (/* is e-ink device detected */) {
        // Disable all window animations
        window.setWindowAnimations(0)
        // Override activity transitions
        overridePendingTransition(0, 0)
        // Disable hardware-layer updates for smoother partial refresh
        window.decorView.layerType = View.LAYER_TYPE_SOFTWARE
    }
}
```

**補充**: 也需要在 `onResume`/`onPause` 中停用 transition animations。

### P1: Boox 實體按鍵強化

在 `MainActivity.kt` 的 KeyEvent 處理中，加入 Boox 專用 key codes：

```kotlin
// Known Boox key codes (from community research):
// KEYCODE_PAGE_UP = 92, KEYCODE_PAGE_DOWN = 93
// Boox Tab series: KEYCODE_PROG_RED = 142, KEYCODE_PROG_GREEN = 143
// Boox Note series: multi-function button

private val booxKeyMap = mapOf(
    92 to "PageUp",
    93 to "PageDown",
    142 to "AppSwitch",    // Boox Tab: refresh button
    143 to "Refresh",       // Boox Tab: back button
)
```

**實作**: 在現有 `dispatchKeyEvent` 中，當 `interceptPageTurnerKeysEnabled` 為 true 時，也攔截這些 key codes。

### P2: WebView 渲染優化

```kotlin
// 在 MainActivity 的 onWebViewCreate 中
if (isEink) {
    webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
    webView.setBackgroundColor(Color.WHITE)
    // Disable hardware acceleration for WebView
    // Optimize: reduce repaint frequency
}
```

### P2: Settings UI 擴充

在 `ControlPanel.tsx` 的 E-Ink section 加入：

| 設定項 | 元件 | 說明 |
|--------|------|------|
| 螢幕更新模式 | Select | AUTO / TEXT / A2 / GC16 / REGAL |
| 翻頁全刷間隔 | Slider | 每 1-20 頁全刷一次（0=關閉） |
| 實體按鍵翻頁 | Switch | Boox 按鍵翻頁開關 |

## EPD Mode 定義

| Mode | 代碼 | 用途 | 效果 |
|------|------|------|------|
| AUTO | `AUTO` | 一般閱讀 | 系統自動選擇 |
| TEXT | `TEXT` | 純文字 | 最清晰，但閃爍較多 |
| A2 | `AUTO_A2` | 快速翻頁 | 殘影較多但最流暢 |
| GC16 | `GC` | 高品質靜態畫面 | 無殘影，更新較慢 |
| REGAL | `GU` | 低速更新 | 減少閃爍 |

## Testing Strategy

### 單元測試
- EPD 反射橋接：測試 class loading + method resolution
- Key mapping：測試 key code → action 轉換
- 翻頁計數器：測試 refresh interval 邏輯

### 整合測試
- `pnpm test` — 確保前端 e-ink 設定 UI 無回歸
- JS invoke → Kotlin plugin 的資料流

### 手動測試（需要實體裝置）
- Boox Page / Tab 系列：EPD refresh、按鍵、觸控
- Bigme / Hisense：相容性測試

## Dependencies
- **無硬依賴** — 所有 Boox SDK 呼叫皆透過 reflection，非 Boox 裝置上自動降級
- `settings.gradle` 需加入 Boox Maven repo (optional：僅用於開發測試)
  ```
  maven { url "http://repo.boox.com/repository/maven-public/" }
  ```

## Open Questions
1. Boox Tab 系列的 refresh button（KEYCODE_PROG_RED）是否應設為全域 shortcut 而非 page up/down？
2. 全刷間隔是否要以 page turn 計數還是時間為基礎？
3. Hisense A9 等非 Boox 裝置的 EPD API 是否相容？
