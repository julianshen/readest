# Readest — Project Context Map

> Generated for `/tgd-map` (refreshed 2026-06-13). Synthesized from the
> **CodeGraph** index (`tGD/map/.codegraph/codegraph.db`) plus source inspection.
> Regenerate the index with `codegraph sync` after significant changes.
>
> **Fork:** https://github.com/julianshen/readest · **Upstream:** https://github.com/readest/readest

## 1. Snapshot (from CodeGraph)

| Metric | Value |
|---|---|
| Files indexed | 3,829 |
| Nodes | 61,796 |
| Edges | 158,029 |
| DB size | ~141 MB (`node:sqlite`, WAL) |

**Languages:** TypeScript 1,585 · TSX 320 · JavaScript 176 (frontend) · Rust 560 · C++ 504 · Kotlin 143 · Swift 84 · Objective‑C 5 (Tauri native + bundled deps) · YAML 139 · Python 116 · Lua 32 (koplugin).

**Node kinds (top):** imports 15,023 · methods 14,613 · functions 13,273 · classes 1,957 · structs 1,921 (Rust) · type aliases 1,649 · interfaces 1,281 · **React components 55** · **routes 27**.

## 2. What it is

**Readest** is a cross-platform ebook/comic reader — a modern rewrite around the Foliate engine — built as a **Next.js 16 (App Router) + Tauri v2** hybrid. One TypeScript/React codebase ships to:
- **Web** — Next.js static export (`output: 'export'` → `out/`) on Cloudflare Workers.
- **Desktop** — macOS/Windows/Linux via Tauri (Rust backend).
- **Mobile** — iOS/Android via Tauri.

Monorepo (pnpm workspaces); the app lives at `apps/readest-app/`.

## 3. Tech stack

| Category | Technology |
|---|---|
| Framework | Next.js 16 (App Router) + TypeScript (ES2022, strict) |
| UI | React 19 + daisyUI + Tailwind CSS |
| State | Zustand (20 stores) |
| Native shell | Tauri v2 (Rust) |
| Reading engine | foliate-js (Web Components) — **git submodule** at `packages/foliate-js/` |
| Database | Turso / SQLite (`@tursodatabase/database` native + WASM; `tauri-plugin-turso`) |
| AI | Vercel AI SDK, OpenAI-compatible/Ollama providers; Reedy retrieval indexer |
| Package manager | pnpm workspaces (v11) |
| Lint / format | Biome + tsgo |
| Test | Vitest + jsdom (unit), Playwright (e2e web), WebdriverIO (Tauri), busted (Lua koplugin) |
| IAP | Stripe (web) + Google Play Billing + Apple StoreKit |
| CI | GitHub Actions (`.github/workflows/pull-request.yml`) |

## 4. Project map (layers)

```
apps/readest-app/src/
├── app/         Next.js App Router — pages + 22 API routes (src/app/api/**/route.ts)
├── components/  React UI (reader, settings, library, assistant, sidebar, primitives)
├── store/       20 Zustand stores (reader, bookData, settings, sidebar, library, parallelView, aiChat…)
├── services/    17 domains: ai, reedy, translators, tts, opds, sync, metadata, database…
├── hooks/       40 hooks (usePagination, useAISummary, useBooksManager…)
├── libs/        Document loaders (DocumentLoader), payment, storage, sync
├── utils/       Pure helpers (book.ts, rtl.ts, style.ts, config.ts…)
├── types/       Domain types (book.ts, database.ts, settings.ts)
├── context/     React providers (Auth, Env, Sync)
└── workers/     Web Workers
src-tauri/        Rust backend + platform code src/{macos,windows,android,ios}/, custom plugins
packages/
├── foliate-js    Rendering engine — GIT SUBMODULE (see §7)
└── tauri · tauri-plugins · simplecc-wasm · qcms · js-mdict   vendored submodules
```

Path aliases: `@/* → src/*`, `@/components/ui/* → src/components/primitives/*`.

## 5. Code entry points (main execution paths)

- **Reader rendering:** `src/app/reader/components/FoliateViewer.tsx::openBook()` builds a `<foliate-view>` from **foliate-js** and drives layout/pagination/spreads — the heart of reading.
- **Document loading:** `src/libs/document` — `new DocumentLoader(file).open()` detects format (EPUB/PDF/CBZ/MOBI/AZW3/FB2/TXT/MD) → `BookDoc`. Comics flow through `packages/foliate-js/comic-book.js`.
- **Pagination & tap zones:** `src/hooks/usePagination.ts` maps physical taps → logical commands, mirroring on `viewSettings.rtl`.
- **Direction derivation:** `src/utils/book.ts::deriveDocDirection` / `shouldRecreateViewerOnWritingModeChange`; fixed-layout dir flows via `bookDoc.dir`.
- **Settings persistence:** `src/helpers/settings.ts::saveViewSettings` (per-book vs global) → `bookDataStore`/`settingsStore`.
- **Native bridge:** `src-tauri/src/` (Rust) exposes Tauri commands/plugins to the webview.
- **AI / Reedy:** `src/services/ai/*`, `src/services/reedy/*`, `src/services/database/*` (Turso/SQLite) — AI Summary chat-flow, translation, retrieval indexing.
- **Command palette:** `src/services/commandRegistry.ts` (fzf-backed settings/actions search).

## 6. Key patterns & conventions

- **Per-book state** keyed by `bookKey` in `bookDataStore` (`BookData { book, bookDoc, isFixedLayout, … }`).
- **Fixed-layout vs reflowable:** `FIXED_LAYOUT_FORMATS = {PDF, CBZ}`, `IMAGE_BOOK_FORMATS = {CBZ}` (`types/book.ts`). AI Summary is gated on image-only formats; tap zones/spreads on fixed-layout `book.dir`.
- **i18n:** key-as-content (English sparse), 33 locales in `public/locales/`. `pnpm i18n:extract` → translate `__STRING_NOT_TRANSLATED__` → gate `pnpm check:translations`.
- **Design system:** primitives in `src/components/settings/primitives/`; rules in `DESIGN.md`; every widget must also render correctly under `[data-eink='true']`.
- **Verification gate** (`.claude/rules/`): `pnpm test` + `pnpm lint`; Rust `fmt:check`/`clippy:check` when `src-tauri/` changes; Lua `test:lua` when koplugin changes.

## 7. Submodule discipline (IMPORTANT)

`packages/foliate-js` is a **git submodule**. As of the manga-reading-mode work it is pinned to the fork **`julianshen/foliate-js#feat/manga-reading-mode`** (`.gitmodules` URL points there). Renderer changes commit *inside* the submodule; the superproject gitlink is bumped separately. If work lands on upstream `readest/readest`, the foliate-js commits must be merged into `readest/foliate-js` and `.gitmodules` repointed.

## 8. CI checks & known gotchas (`.github/workflows/pull-request.yml`)

- `build_web_app`: `pnpm build-web && pnpm check:all` — `check:lookbehind-regex` now scopes to the **shipped** `out/_next/static/chunks` (build intermediates in `.next/` carry tree-shaken grammar regexes that never ship).
- `test_web_app`: `pnpm test:pr:web` — needs `@tursodatabase/database` native binding (linux binaries now locked as `os`-guarded `optionalDependencies`) and Lua deps (occasionally flaky on `lua.sqlite.org` 503s).
- `build_tauri_app`, `rust_lint`, CodeQL, CodeRabbit.

## 9. Querying this map

```bash
codegraph status                 # index stats
codegraph query "<symbol>"       # find symbols
codegraph callers "<symbol>"     # who calls it
codegraph impact "<symbol>"      # blast radius before a change
codegraph affected <files...>    # tests touched by a change
codegraph sync                   # refresh after edits
```

## See Also

- **CodeGraph DB:** `tGD/map/.codegraph/codegraph.db` (symlinked at repo root `.codegraph/`).
- **Understand-Anything:** `tGD/map/.understand-anything/` (symlinked at `.understand-anything/`) — run `/understand` to build `knowledge-graph.json`, then `/understand-dashboard` for the interactive localhost dashboard, or `/understand-onboard` for a guided tour.
- **Project rules:** `apps/readest-app/CLAUDE.md`, `apps/readest-app/.claude/rules/`, `apps/readest-app/DESIGN.md`.
- **Android notes:** `tGD/map/ANDROID-BUGS.md`.
