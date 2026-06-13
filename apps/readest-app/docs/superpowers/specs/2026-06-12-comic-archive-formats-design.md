# CBR / CB7 Comic Archive Support — Design

**Date:** 2026-06-12
**Status:** Awaiting review
**Scope:** apps/readest-app (+ src-tauri)

## Goal

Import and read CBR (RAR) and CB7 (7z) comic archives. Today only ZIP-based
CBZ is supported (`@zip.js/zip.js`; `makeComicBook` consumes a
`{ entries, loadBlob, getSize, getComment }` loader — comic-book.js:76).

## Decisions made

| Question | Decision |
|---|---|
| Strategy | **Convert to CBZ at import time** (desktop/mobile via a Rust command; web via a wasm extractor). The imported, stored book IS a CBZ — zero changes to the reader, caching, sync, or foliate. |
| Rust crates | `unrar` (RAR4/5 extraction) and `sevenz-rust2` (7z). One `convert_archive_to_cbz(src_path, dst_path) -> Result` Tauri command following the existing `#[tauri::command]` pattern (lib.rs:263-284 handler list). Images are STORED (not re-compressed) into the output zip — comic images are already compressed. |
| Web platform | `libarchive.js` (wasm) vendored under `public/vendor/libarchive/` following the simplecc pattern (lazy `init()` + dynamic import). Extract in a worker, repack with `@zip.js/zip.js` (already a dependency). |
| Format identity | After conversion the book's format is `CBZ`; the original CBR/CB7 file is not retained. Metadata (ComicInfo.xml) transfers verbatim since it's just a zip member. |
| Encrypted/solid archives | Password-protected archives are rejected with a clear import error. Solid RAR/7z are fine (full extraction, not streaming). |

## Architecture

1. **Detection** (`src/libs/document.ts`): add magic-byte checks beside
   `isZip()` (document.ts:126-144) — RAR (`Rar!\x1A\x07`), 7z
   (`7z\xBC\xAF\x27\x1C`) — plus extension/mime entries:
   `EXTS` (document.ts:93-104), `MIMETYPES` (document.ts:106-117) for a
   transient `CBR`/`CB7` detection result used only by the importer.
2. **Import pipeline** (`bookService` import path): when a CBR/CB7 is
   detected, run the conversion BEFORE hashing/storing, then continue the
   normal CBZ import with the converted file (hash computed on the produced
   CBZ so re-imports of the same source dedupe consistently via identical
   STORE-mode packing: fixed file order = archive order, fixed timestamps).
3. **Tauri command** (`src-tauri/src/comic_convert.rs`): extracts to memory
   or a temp dir, writes a STORE-mode zip; registered in
   `generate_handler![]`. Exposed in TS via a `convertArchiveToCbz` bridge
   function (utils/bridge.ts pattern).
4. **Web fallback**: same flow with libarchive-wasm + zip.js, behind the
   `isTauriAppPlatform()` branch (environment.ts:62-70).
5. **Registration points** (all must list cbr/cb7):
   `SUPPORTED_BOOK_EXTS` (constants.ts:44-54), file pickers
   (`useFileSelector`, `useDragDropImport` accept lists),
   `tauri.conf.json` fileAssociations (tauri.conf.json:78-128),
   Android intent filters (AndroidManifest.xml:33-77 — note gen/ files are
   partially tracked; follow the android-build-flow conventions),
   OPDS `feedChecker.ts` mime/href matchers (feedChecker.ts:66 area).

## Error handling

- Corrupt/truncated archive → import error toast naming the file; nothing
  stored.
- Password-protected → explicit "encrypted archives are not supported" error.
- Archive with zero image entries → same "no readable pages" error CBZ uses.
- Conversion is atomic: write to temp, move into place on success.

## Testing

- Rust unit tests: RAR and 7z fixtures (tiny 2-page archives) → valid CBZ
  with identical image bytes and preserved ComicInfo.xml; encrypted fixture →
  error.
- TS unit: magic-byte detection for rar/7z buffers; importer routes to the
  converter; rejection paths surface the right error codes.
- Manual: import a real-world CBR on desktop + Android; open from file
  manager (intent filter) on Android.

## Out of scope

- Streaming/partial extraction (full convert-once is the design).
- CBT (tar) — rare; can ride the same pipeline later if requested.
- Keeping the original archive alongside the converted CBZ.
