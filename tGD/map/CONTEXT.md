# Project Context

## Overview

Readest is an open-source cross-platform ebook reader built with Next.js 16 + Tauri v2. It's a modern rewrite of Foliate, supporting macOS, Windows, Linux, Android, iOS, and Web.

**Fork URL:** https://github.com/julianshen/readest
**Upstream:** https://github.com/readest/readest

## Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend Framework | Next.js 16 (App Router) + TypeScript |
| UI Library | React 19 + daisyUI 5 + Tailwind CSS 4 |
| State Management | Zustand (20 stores) |
| Desktop Shell | Tauri v2 (Rust backend) |
| Reading Engine | FoliateJS (Web Components, in-repo at `packages/foliate-js/`) |
| Database | Turso (SQLite edge DB) via custom `tauri-plugin-turso` |
| Package Manager | pnpm (monorepo) |
| Monorepo Tool | pnpm workspaces |
| Linting | Biome + tsgo (type-check) |
| Testing | Vitest (unit) + Playwright (E2E) + WebdriverIO (Tauri) |
| IAP | Stripe (web) + Google Play Billing + Apple StoreKit |
| CI/CD | GitHub Actions |

## Project Structure

```
readest/
├── apps/
│   ├── readest-app/               # Main application (Next.js + Tauri)
│   │   ├── src/app/               # Next.js App Router pages & API routes
│   │   ├── src/components/        # React components (reader, settings, etc.)
│   │   ├── src/services/          # Business logic (TTS, translation, OPDS, sync, AI, metadata)
│   │   ├── src/store/             # Zustand state stores
│   │   ├── src/hooks/             # Custom React hooks
│   │   ├── src/libs/              # Document loaders, payment, storage, sync
│   │   ├── src/utils/             # Pure utility functions
│   │   ├── src/types/             # TypeScript type definitions
│   │   ├── src/context/           # React Context providers (Auth, Env, Sync)
│   │   ├── src/workers/           # Web Workers
│   │   └── src-tauri/             # Rust backend
│   │       ├── src/               # Main modules (lib.rs, main.rs)
│   │       │   ├── macos/         # macOS-specific (menu, auth, dictionary, traffic lights)
│   │       │   ├── windows/       # Windows-specific (window state, hotkeys)
│   │       │   └── android/       # Android-specific (E-Ink detection)
│   │       └── plugins/           # Custom Tauri plugins
│   │           ├── tauri-plugin-native-bridge/  # Native bridge (26 commands)
│   │           ├── tauri-plugin-native-tts/     # TTS (12 commands)
│   │           ├── tauri-plugin-turso/          # SQLite/Turso database
│   │           └── tauri-plugin-webview-upgrade/ # WebView upgrade
│   └── readest.koplugin/          # KOReader sync plugin
├── packages/
│   ├── foliate-js/                # Web Components reading engine (core)
│   ├── js-mdict/                  # MDict dictionary engine
│   ├── qcms/                      # Color management
│   ├── simplecc-wasm/             # Simplified-Traditional Chinese conversion (WASM)
│   ├── tauri/                     # Tauri frontend bindings
│   └── tauri-plugins/             # Tauri plugin JS bindings
├── data/                          # Icons, screenshots, sponsors
└── patches/                       # Patch files for dependencies
```

## Architecture

### Layer Diagram

```
User Input → React Components → Zustand Store → Service/Hook
    → invoke() → Rust Command → OS / Filesystem / Network
```

### Frontend Architecture

```
Reader Page (/reader/[ids])
├── ReaderContent
│   ├── SideBar (un/pinned)
│   ├── BooksGrid (react-virtuoso virtual scroll)
│   │   └── FoliateViewer (per book)
│   │       ├── <foliate-view> (Web Component via foliate-js)
│   │       │   └── <foliate-paginator> (or <foliate-fxl>)
│   │       │       ├── iframe[0..7] (concurrent, CSS columns pagination)
│   │       │       └── SVG Overlayer (annotations)
│   │       ├── ImageViewer (lightbox)
│   │       ├── TableViewer
│   │       ├── BrightnessOverlay
│   │       └── ParagraphControl
│   ├── Notebook
│   ├── SettingsDialog
│   └── Various dialogs
└── Library Page (/)
    ├── LibraryHeader (search, import, view toggle)
    ├── Bookshelf (virtual scroll, grid/linear)
    ├── OPDS catalog
    └── Transfer queue
```

### Rust Backend Architecture

```
main.rs → readestlib::run()
  └── lib.rs
      ├── 16+ Tauri plugins initialized
      ├── 14 #[tauri::command] functions
      ├── Setup: webview window, platform init, scope management
      ├── Run: event handling (file open, reopen)
      │
      ├── dir_scanner.rs     — Recursive directory scanning
      ├── transfer_file.rs   — HTTP download/upload (multi-threaded segmented)
      ├── clip_url.rs        — Web page capture via hidden WebView
      ├── clip_url.rs        — URL clipboard handling
      ├── window_state.rs    — Window position/size persistence (desktop)
      ├── discord_rpc.rs     — Discord Rich Presence
      │
      └── Platform-specific:
          ├── macos/  — Apple Sign-In, Safari auth, system dict, traffic lights, menu
          ├── windows/ — Window state, hotkeys
          └── android/ — E-Ink detection
```

### Communication Patterns

| Method | Direction | Purpose |
|--------|-----------|---------|
| `invoke()` / `#[tauri::command]` | Bidirectional | Standard IPC |
| `Channel<T>` | Rust → JS | Progress reporting (download/upload) |
| `app.emit()` / `window.emit()` | Rust → JS | Event push (single-instance, auth) |
| `window.postMessage()` | iframe → React | Touch/keyboard/wheel events from reader |
| `initialization_script()` | Rust → JS | Global vars injection at WebView creation |

## Entry Points

| Entry | Path | Description |
|-------|------|-------------|
| Web dev server | `pnpm dev-web` | Next.js dev server (no Rust) |
| Desktop app | `pnpm tauri dev` | Tauri development mode |
| Rust backend | `apps/readest-app/src-tauri/src/main.rs` | App entry `fn main() { readestlib::run() }` |
| Frontend pages | `src/app/` | Next.js App Router pages |
| API routes | `src/app/api/` | Next.js API handlers (AI, IAP, Stripe, OPDS, TTS, share) |
| Library page | `src/app/library/page.tsx` | Main library UI |
| Reader page | `src/app/reader/components/Reader.tsx` | Reader UI |

## Development Commands

```bash
# Web-only dev (fast, no Rust compilation)
pnpm dev-web

# Desktop dev with Tauri
pnpm tauri dev

# Building
pnpm build              # Build Next.js for Tauri
pnpm build-web          # Build Next.js for web deployment (Cloudflare Workers)

# Testing
pnpm test               # Unit tests (vitest + jsdom)
pnpm test:browser       # E2E (Playwright)
pnpm test:tauri         # Tauri integration tests

# Linting & Formatting
pnpm lint               # Biome + tsgo type check
pnpm format             # Biome formatter
pnpm clippy:check       # Rust lint
pnpm fmt:check          # Rust formatting

# Git worktrees (always use this!)
pnpm worktree:new <branch-name>
pnpm worktree:new <pr-number>

# Rust
cd apps/readest-app/src-tauri && cargo build --release
```

## Key Design Patterns

1. **Abstract Factory**: Native plugins use `#[cfg(desktop)]` / `#[cfg(mobile)]` for platform-specific impls
2. **Command Pattern**: All `#[tauri::command]` functions as IPC commands
3. **Facade**: `NativeBridge` / `NativeTts` provide unified interface across platforms
4. **Observer**: Tauri event system (`app.emit()` / `app.listen()`)
5. **Strategy**: `clip_url` desktop (WebviewWindow + TCP) vs mobile (native WebView)
6. **Channel**: `Channel<T>` for progress, `oneshot` for clip URL result
7. **State (Tauri)**: `app.manage()` + `State<>` for managed state

## Sync Architecture

| Sync Method | Direction | Data | Conflict Resolution |
|-------------|-----------|------|-------------------|
| Cloud Sync | Bidirectional | books, configs, notes | LWW (updatedAt) |
| WebDAV | Bidirectional | config, book file, cover | LWW + per-note merge |
| KOSync | Bidirectional | progress, notes | LWW + 4 strategies (silent/send/receive/prompt) |
| Readwise | Local → API | highlights only | N/A (append-only) |
| Hardcover | Bidirectional | notes, progress | LWW |

## Z-Index Layering (Reader)

| Level | Element |
|-------|---------|
| 99 | Window Border (Linux) |
| 50 | Dialogs / Toast / Popups |
| 45 | Sidebar / Notebook (Unpinned) |
| 40 | TTS Bar |
| 30 | TTS Control |
| 20 | Menu / Sidebar / Notebook (Pinned) |
| 10 | Headerbar / Footbar / Ribbon |
| 0 | Base Content (reading area) |

## Known Issues (Android)

See `tGD/map/ANDROID-BUGS.md` for detailed Android analysis — 12 identified issues including:
- NativeBridge runs all commands on main thread (blocking I/O)
- ClipUrlController WebView never destroyed (memory leak + 30s timeout)
- TTS event channel unbounded + main thread processing
- KeyDownInterceptor not implemented in Activity (silent key handling failure)
- MediaPlaybackService loops silence.mp3 indefinitely
- BrightnessGesture capture-phase may hijack touch events

## Git Worktree Setup

```bash
# Create feature/PR worktree (handles submodules + deps)
pnpm worktree:new feat/my-feature
pnpm worktree:new 3837          # Checkout PR 3837
```

Worktree wrappers auto-handle submodule init, dependency install, `.env` copying, vendor assets, and Tauri gen symlinks.
