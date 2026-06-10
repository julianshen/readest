# PRD: E-Ink / Boox 閱讀器深度優化

## Problem Statement
Readest 在 Boox、Bigme、Hisense 等 E-Ink 電子紙閱讀器上的閱讀體驗有顯著改善空間：
- **殘影（Ghosting）**：翻頁後前頁殘影累積，需手動全刷
- **畫面閃爍**：E-Ink 螢幕更新模式未針對閱讀場景優化
- **動畫殘留**：Android 層動畫（Activity transition、WebView 更新）在 E-Ink 上造成不必要的閃爍
- **實體按鍵**：Boox 裝置的物理翻頁鍵未充分利用
- **觸控延遲**：E-Ink 的觸控反應特性未納入考量

## Goals
1. **消除殘影** — 翻頁時自動觸發 EPD full refresh，可自訂間隔
2. **優化螢幕更新** — 支援 waveform mode 切換（GC16/A2/Regal）
3. **停用 Android 動畫** — Activity transition、window animation 在 e-ink 模式下關閉
4. **實體按鍵支援** — 最佳化 Boox 音量鍵/翻頁鍵對應
5. **WebView 渲染優化** — 減少不必要的 repaint、批次更新
6. **省電** — 降低背景重繪頻率

## Non-Goals
- PDF reflow 引擎改寫（屬於上游功能）
- CABC 硬體控制（不同晶片方案差異過大）
- 不相容非 Android 平台（iOS/Windows 無 E-ink 硬體支援）

## User Stories
- 身為 **Boox 用戶**，翻頁後看不到殘影，閱讀體驗接近 Kindle
- 身為 **Bigme 用戶**，App 啟動不會閃白、切換頁面不會閃爍
- 身為 **Hisense A9 用戶**，實體按鍵可直接翻頁
- 身為 **E-Ink 閱讀器用戶**，電池續航不因 App 背景重繪而快速耗盡

## Success Metrics
- 翻頁後 500ms 內完成 EPD refresh（無殘影）
- App 啟動無白閃（white flash）
- 連續閱讀 30 頁無累積 ghosting
- 實體按鍵反應 < 200ms
- APK size 增加 < 200KB

## Timeline / Priority
- **P0** (核心)：EPD 刷新控制 + 翻頁全刷
- **P1** (重要)：Android 動畫停用 + 實體按鍵支援
- **P2** (加分)：WebView 渲染優化 + 省電改善
