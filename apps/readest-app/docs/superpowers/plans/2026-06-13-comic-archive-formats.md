# CBR / CB7 Comic Archive Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import and read CBR (RAR) and CB7 (7z) comic archives by converting them to CBZ at import time, so the stored book is a plain CBZ and the reader/foliate/sync/cache paths are entirely unchanged.

**Architecture:** A `.cbr`/`.cb7` File is detected by magic bytes and converted to a STORE-mode CBZ **before** hashing and storage — slotting in right after the existing TXT→EPUB pre-conversion hook in `bookService.importBook`. Conversion has two backends behind one TS entry point `convertArchiveToCbz(file, srcPath?)`: a Rust Tauri command (`comic_parser::convert_to_cbz`, crates `unrar` + `sevenz-rust2`) on desktop/mobile, and a `libarchive.js` wasm extractor + `@zip.js/zip.js` repack on web. The converted File is named `*.cbz` with the comicbook MIME so it satisfies `isCBZ()` and reuses the entire existing comic render path.

**Tech Stack:** TypeScript/React (apps/readest-app), Rust/Tauri v2 (src-tauri), `unrar` + `sevenz-rust2` + `zip` (Rust), `libarchive.js` (wasm) + `@zip.js/zip.js` (web), vitest + jsdom, `cargo test`.

---

## Key existing code (read these before each task)

- **Detection / loading:** `src/libs/document.ts` — `isZip()` (141-180, no RAR/7z magic), `EXTS`/`MIMETYPES` (94-118), `isCBZ()` (309-313, true when name ends `.cbz` OR MIME `application/vnd.comicbook+zip`), `open()` format chain (330-401), `makeZipLoader` returns `{ entries, loadText, loadBlob, getSize, getComment, sha1 }` (306) → `makeComicBook(loader, file)` (354-356).
- **Import pipeline:** `src/services/bookService.ts::importBook` (228+). File acquired at 271-277 (`file` may be a path string → `fileobj = await fs.openFile(file, 'None')`, else `fileobj = file`). **TXT→EPUB pre-conversion hook at 278-281** (the precedent). Hash at 339-343 (`partialMD5(fileobj)`); native fast-path guard at 304 (`!/\.txt$/i.test(filename)`); bytes stored at 434-457 via `getLocalBookFilename(book)` (format-driven). Hash helper: `src/utils/md5.ts::partialMD5` (11).
- **Rust command pattern:** `src-tauri/src/lib.rs` — `mod` decls (24-37), `generate_handler![...]` (267-293). Representative command: `src-tauri/src/mobi_parser.rs::parse_mobi_metadata` (59-82, `#[tauri::command] pub async fn (file_path: String) -> Result<T, String>` + `spawn_blocking`). `Cargo.toml [dependencies]` (25-110) already has `zip = { version = "2", default-features = false, features = ["deflate"] }`; no `unrar`/`sevenz-rust2`. Rust tests: `#[cfg(test)] mod tests` in `epub_parser.rs`/`mobi_parser.rs`; run `pnpm test:rust` (= `cargo test -p Readest --lib`).
- **TS↔Rust bridge:** core-command precedent `src/utils/tauriMobiBridge.ts` / `tauriEpubBridge.ts` (platform-guarded `invoke('parse_mobi_metadata', { filePath })`, try/catch → undefined fallback). Platform: `src/services/environment.ts::isTauriAppPlatform` (11).
- **Web wasm vendoring:** `src/utils/simplecc.ts` (lazy `init()` flag + `await init('/vendor/simplecc/...wasm')`); `package.json` scripts `prepare-public-vendor`/`copy-simplecc`/`setup-vendors` (49-62). STORE-mode zip precedent: `src/__tests__/fixtures/cbz.ts` (`new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'))`, `writer.add(name, reader, { level: 0 })`) and `src/services/backupService.ts:292`.
- **Registration:** `src/services/constants.ts::SUPPORTED_BOOK_EXTS` (44-55, feeds `useFileSelector.ts:166-167` + drag-drop in `library/page.tsx`); `src-tauri/tauri.conf.json` fileAssociations (78-128, cbz at 114-120); `src-tauri/gen/android/app/src/main/AndroidManifest.xml` (mime filter 50-52, pathPattern 74); `src/services/opds/feedChecker.ts` `INFERENCE_RULES` (59-73, cbz at 66).

**License note (unrar):** the `unrar` crate binds the official UnRAR library; its license permits decompression/extraction (what we do) but forbids recreating the RAR *compressor*. This is acceptable for read-only extraction but is **not** OSI-approved — flag it to the maintainer before merge in case the project wants a different RAR backend (`node-unrar-js` wasm is an alternative used on web anyway).

---

### Task 0: Branch + Rust dependencies

**Files:**
- Modify: `apps/readest-app/src-tauri/Cargo.toml`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/julianshen/projects/readest
git checkout main && git pull --ff-only origin main
git checkout -b feat/comic-archive-formats
```

- [ ] **Step 2: Add the extraction crates**

In `apps/readest-app/src-tauri/Cargo.toml`, under `[dependencies]` (after the existing `zip = ...` line), add:

```toml
unrar = "0.5"
sevenz-rust2 = { version = "0.13", default-features = false, features = ["compress", "aes256"] }
```

(`sevenz-rust2` `aes256` lets us *detect* encrypted 7z to reject them cleanly; `compress` is needed for the writer side of the crate but we only read. Pin to whatever the latest 0.x resolves — run `cargo update -p sevenz-rust2 -p unrar` if the minor differs.)

- [ ] **Step 3: Verify the crates resolve and build**

Run (from `apps/readest-app/src-tauri`): `cargo check -p Readest --lib`
Expected: compiles (downloads the crates). If a desktop GTK system-lib error appears in a CI-less dev box, that's environmental — the crates themselves resolving is the check; rely on CI `rust_lint` for the full build.

- [ ] **Step 4: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src-tauri/Cargo.toml apps/readest-app/src-tauri/Cargo.lock
git commit -m "build(comic): add unrar + sevenz-rust2 for archive extraction"
```

---

### Task 1: Archive magic-byte detection (TS, pure)

A pure detector used by the importer to decide whether to convert. Lives in a new util so it's testable without the DOM.

**Files:**
- Create: `apps/readest-app/src/utils/comicArchive.ts`
- Create: `apps/readest-app/src/__tests__/utils/comic-archive-detect.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/readest-app/src/__tests__/utils/comic-archive-detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { detectArchiveFormat } from '@/utils/comicArchive';

const fileWith = (bytes: number[], name = 'x') =>
  new File([new Uint8Array(bytes)], name);

describe('detectArchiveFormat', () => {
  it('detects RAR4 magic (Rar!\\x1A\\x07\\x00)', async () => {
    expect(await detectArchiveFormat(fileWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe(
      'CBR',
    );
  });

  it('detects RAR5 magic (Rar!\\x1A\\x07\\x01\\x00)', async () => {
    expect(
      await detectArchiveFormat(fileWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])),
    ).toBe('CBR');
  });

  it('detects 7z magic (7z\\xBC\\xAF\\x27\\x1C)', async () => {
    expect(await detectArchiveFormat(fileWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('CB7');
  });

  it('returns null for a ZIP (CBZ) file', async () => {
    expect(await detectArchiveFormat(fileWith([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });

  it('returns null for a too-short file', async () => {
    expect(await detectArchiveFormat(fileWith([0x52, 0x61]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test run src/__tests__/utils/comic-archive-detect.test.ts`
Expected: FAIL — `detectArchiveFormat` is not exported.

- [ ] **Step 3: Implement the detector**

Create `apps/readest-app/src/utils/comicArchive.ts`:

```ts
export type ComicArchiveFormat = 'CBR' | 'CB7';

const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]; // "Rar!\x1A\x07" (RAR4 + RAR5 share this prefix)
const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]; // "7z\xBC\xAF\x27\x1C"

const startsWith = (bytes: Uint8Array, magic: number[]): boolean =>
  bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

// Magic-byte sniff for archive formats that must be converted to CBZ before
// import. Returns null for ZIP-based CBZ (already handled) and everything else.
export const detectArchiveFormat = async (file: File): Promise<ComicArchiveFormat | null> => {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (startsWith(header, RAR_MAGIC)) return 'CBR';
  if (startsWith(header, SEVENZ_MAGIC)) return 'CB7';
  return null;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test run src/__tests__/utils/comic-archive-detect.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/utils/comicArchive.ts \
        apps/readest-app/src/__tests__/utils/comic-archive-detect.test.ts
git commit -m "feat(comic): magic-byte detection for CBR/CB7 archives"
```

---

### Task 2: Rust `convert_to_cbz` command (desktop/mobile)

Extracts RAR (unrar) and 7z (sevenz-rust2) into a STORE-mode CBZ in the temp dir, preserving entry order and image bytes; ComicInfo.xml rides along as a normal member. Rejects encrypted archives.

**Files:**
- Create: `apps/readest-app/src-tauri/src/comic_parser.rs`
- Modify: `apps/readest-app/src-tauri/src/lib.rs:24-37` (add `mod comic_parser;`) and `:267-293` (register in `generate_handler!`)

- [ ] **Step 1: Write the Rust module with failing tests**

Create `apps/readest-app/src-tauri/src/comic_parser.rs`:

```rust
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const IMAGE_EXTS: [&str; 7] = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

fn is_keepable(name: &str) -> bool {
    let lower = name.to_lowercase();
    if lower.ends_with("comicinfo.xml") {
        return true;
    }
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Packs (name, bytes) members into a STORE-mode (uncompressed) zip. Comic
/// images are already compressed; STORE keeps the output deterministic and
/// fast. Members are written in the given order (caller sorts by name).
fn pack_cbz(mut members: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    members.sort_by(|a, b| a.0.cmp(&b.0));
    if !members.iter().any(|(n, _)| {
        IMAGE_EXTS.iter().any(|e| n.to_lowercase().ends_with(&format!(".{e}")))
    }) {
        return Err("no readable pages".into());
    }
    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in members {
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

fn extract_rar(src: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    use unrar::Archive;
    let mut out = Vec::new();
    let mut archive = Archive::new(src)
        .open_for_processing()
        .map_err(|e| format!("rar open failed: {e}"))?;
    while let Some(header) = archive.read_header().map_err(|e| format!("rar header: {e}"))? {
        let entry = header.entry();
        if entry.is_encrypted() {
            return Err("encrypted archives are not supported".into());
        }
        let name = entry.filename.to_string_lossy().replace('\\', "/");
        if entry.is_file() && is_keepable(&name) {
            let (data, next) = header.read().map_err(|e| format!("rar read: {e}"))?;
            out.push((name, data));
            archive = next;
        } else {
            archive = header.skip().map_err(|e| format!("rar skip: {e}"))?;
        }
    }
    Ok(out)
}

fn extract_7z(src: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    use sevenz_rust2::{ArchiveReader, Password};
    let mut out = Vec::new();
    let mut reader = ArchiveReader::open(src, Password::empty())
        .map_err(|e| format!("7z open failed: {e}"))?;
    reader
        .for_each_entries(|entry, rd| {
            let name = entry.name().replace('\\', "/");
            if !entry.is_directory() && is_keepable(&name) {
                let mut buf = Vec::new();
                rd.read_to_end(&mut buf)?;
                out.push((name, buf));
            }
            Ok(true)
        })
        .map_err(|e| {
            let msg = e.to_string();
            if msg.to_lowercase().contains("password") || msg.to_lowercase().contains("encrypt") {
                "encrypted archives are not supported".to_string()
            } else {
                format!("7z read: {msg}")
            }
        })?;
    Ok(out)
}

fn convert_sync(src_path: &str) -> Result<String, String> {
    let src = Path::new(src_path);
    if !src.is_file() {
        return Err(format!("file not found: {src_path}"));
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let members = match ext.as_str() {
        "cbr" | "rar" => extract_rar(src)?,
        "cb7" | "7z" => extract_7z(src)?,
        other => return Err(format!("unsupported archive extension: {other}")),
    };
    let cbz = pack_cbz(members)?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("comic");
    let dst = std::env::temp_dir().join(format!("readest-{stem}-{}.cbz", std::process::id()));
    let mut f = File::create(&dst).map_err(|e| e.to_string())?;
    f.write_all(&cbz).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// Converts a CBR/CB7 archive at `src_path` to a STORE-mode CBZ in the temp
/// dir and returns the produced `.cbz` path. The caller reads it back and is
/// responsible for deleting it.
#[tauri::command]
pub async fn convert_to_cbz(src_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || convert_sync(&src_path))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_orders_and_stores_images() {
        let png = vec![0x89, 0x50, 0x4e, 0x47];
        let members = vec![
            ("02.png".to_string(), png.clone()),
            ("01.png".to_string(), png.clone()),
            ("ComicInfo.xml".to_string(), b"<ComicInfo/>".to_vec()),
        ];
        let cbz = pack_cbz(members).unwrap();
        let mut zip = zip::ZipReader::new(Cursor::new(cbz)).unwrap();
        // first entry must be 01.png (sorted), all STORED
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert_eq!(names, vec!["01.png", "02.png", "ComicInfo.xml"]);
    }

    #[test]
    fn pack_rejects_imageless_archive() {
        let members = vec![("readme.txt".to_string(), b"hi".to_vec())];
        assert_eq!(pack_cbz(members).unwrap_err(), "no readable pages");
    }

    #[test]
    fn is_keepable_filters() {
        assert!(is_keepable("pages/01.JPG"));
        assert!(is_keepable("ComicInfo.xml"));
        assert!(!is_keepable("thumbs.db"));
    }
}
```

(Note: verify the exact `unrar` 0.5 and `sevenz-rust2` 0.13 API names while implementing — `open_for_processing`/`read_header`/`header.read()` for unrar, `ArchiveReader::open`/`for_each_entries` for sevenz-rust2. If a method name differs in the resolved version, adapt and keep the same control flow; the pure `pack_cbz`/`is_keepable` tests pin the contract regardless.)

- [ ] **Step 2: Run the Rust tests to verify they fail/pass for the pure helpers**

Run (from `apps/readest-app`): `pnpm test:rust 2>&1 | tail -20`
Expected: the new `comic_parser::tests` compile and pass (`pack_orders_and_stores_images`, `pack_rejects_imageless_archive`, `is_keepable_filters`). If the module isn't registered yet it won't compile — do Step 3 first, then run.

- [ ] **Step 3: Register the module + command**

In `apps/readest-app/src-tauri/src/lib.rs`, add near the other `mod` decls (24-37):

```rust
mod comic_parser;
```

In the `generate_handler![...]` list (267-293), add after `mobi_parser::extract_mobi_cover_full,`:

```rust
        comic_parser::convert_to_cbz,
```

- [ ] **Step 4: Run Rust tests green**

Run: `pnpm test:rust 2>&1 | tail -20`
Expected: all `comic_parser` tests pass; no regressions.

- [ ] **Step 5: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src-tauri/src/comic_parser.rs apps/readest-app/src-tauri/src/lib.rs
git commit -m "feat(comic): Rust convert_to_cbz command (unrar + sevenz-rust2 -> STORE cbz)"
```

---

### Task 3: TS bridge + Tauri orchestration

One TS entry point that, on Tauri, writes the source to a path (if needed), invokes the Rust command, and reads the produced CBZ back as a `File`.

**Files:**
- Create: `apps/readest-app/src/utils/comicConvert.ts`
- Create: `apps/readest-app/src/__tests__/utils/comic-convert-route.test.ts`

- [ ] **Step 1: Write the failing test (platform routing + File naming)**

Create `apps/readest-app/src/__tests__/utils/comic-convert-route.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => true,
  isWebAppPlatform: () => false,
}));
// Stub the web extractor so this test only exercises the Tauri branch.
vi.mock('@/utils/comicConvertWeb', () => ({ convertArchiveToCbzWeb: vi.fn() }));

import { convertArchiveToCbz } from '@/utils/comicConvert';

afterEach(() => {
  invokeMock.mockReset();
});

describe('convertArchiveToCbz (Tauri path)', () => {
  it('invokes convert_to_cbz with the source path and returns a .cbz File', async () => {
    invokeMock.mockResolvedValueOnce('/tmp/readest-x.cbz');
    const readPath = vi.fn(async (p: string) => new File([new Uint8Array([1, 2])], p));
    const input = new File([new Uint8Array([0x52, 0x61, 0x72, 0x21])], 'book.cbr');
    const out = await convertArchiveToCbz(input, {
      srcPath: '/books/book.cbr',
      readPathAsFile: readPath,
    });
    expect(invokeMock).toHaveBeenCalledWith('convert_to_cbz', { srcPath: '/books/book.cbr' });
    expect(out.name.endsWith('.cbz')).toBe(true);
    expect(out.type).toBe('application/vnd.comicbook+zip');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test run src/__tests__/utils/comic-convert-route.test.ts`
Expected: FAIL — `convertArchiveToCbz` not exported.

- [ ] **Step 3: Implement the orchestrator**

Create `apps/readest-app/src/utils/comicConvert.ts`:

```ts
import { invoke } from '@tauri-apps/api/core';
import { isTauriAppPlatform } from '@/services/environment';
import { convertArchiveToCbzWeb } from '@/utils/comicConvertWeb';

const CBZ_MIME = 'application/vnd.comicbook+zip';

const toCbzName = (name: string) => name.replace(/\.(cbr|cb7|rar|7z)$/i, '') + '.cbz';

export interface ConvertOptions {
  // Tauri: absolute path to the source archive on disk (when the import came
  // from the filesystem). When absent on Tauri, the caller must provide
  // `writeTempAndPath` to materialize the File to a path first.
  srcPath?: string;
  // Reads a produced CBZ path back into a File (injected so this is testable
  // and decoupled from the fs service).
  readPathAsFile?: (path: string) => Promise<File>;
  // Materializes the input File to a temp path and returns it (used when
  // srcPath is unavailable, e.g. drag-drop on desktop).
  writeTempAndPath?: (file: File) => Promise<string>;
  // Deletes the produced temp CBZ after it's read back (best-effort).
  deletePath?: (path: string) => Promise<void>;
}

// Converts a CBR/CB7 File to a CBZ File. On Tauri, routes through the Rust
// `convert_to_cbz` command; on web, through the libarchive.js wasm extractor.
export const convertArchiveToCbz = async (
  file: File,
  opts: ConvertOptions = {},
): Promise<File> => {
  if (isTauriAppPlatform()) {
    const srcPath = opts.srcPath ?? (await opts.writeTempAndPath!(file));
    const dstPath = await invoke<string>('convert_to_cbz', { srcPath });
    const cbz = await opts.readPathAsFile!(dstPath);
    await opts.deletePath?.(dstPath).catch(() => {});
    // Re-wrap to guarantee the .cbz name + comicbook MIME (so isCBZ() passes).
    return new File([await cbz.arrayBuffer()], toCbzName(file.name), { type: CBZ_MIME });
  }
  const blob = await convertArchiveToCbzWeb(file);
  return new File([await blob.arrayBuffer()], toCbzName(file.name), { type: CBZ_MIME });
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test run src/__tests__/utils/comic-convert-route.test.ts`
Expected: PASS. (The `comicConvertWeb` module is stubbed; it's implemented in Task 4. Create a temporary stub so the import resolves: see Step 5.)

- [ ] **Step 5: Add a placeholder web module so imports resolve, then commit**

Create `apps/readest-app/src/utils/comicConvertWeb.ts` (real impl in Task 4):

```ts
// Implemented in Task 4 (libarchive.js wasm extractor). Stub keeps the Tauri
// path importable until then.
export const convertArchiveToCbzWeb = async (_file: File): Promise<Blob> => {
  throw new Error('web archive conversion not yet implemented');
};
```

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/utils/comicConvert.ts \
        apps/readest-app/src/utils/comicConvertWeb.ts \
        apps/readest-app/src/__tests__/utils/comic-convert-route.test.ts
git commit -m "feat(comic): convertArchiveToCbz orchestrator (Tauri path)"
```

---

### Task 4: Web wasm extractor (libarchive.js)

Vendor `libarchive.js`, extract image entries from a CBR/CB7 in the browser, repack STORE-mode with zip.js.

**Files:**
- Modify: `apps/readest-app/package.json` (add `libarchive.js` dep + vendor scripts)
- Modify: `apps/readest-app/src/utils/comicConvertWeb.ts` (replace the stub)
- Create: `apps/readest-app/src/__tests__/utils/comic-convert-web.test.ts`

- [ ] **Step 1: Add the dependency + vendor scripts**

```bash
cd /home/julianshen/projects/readest/apps/readest-app
pnpm add libarchive.js
```

In `apps/readest-app/package.json` scripts, extend the vendor setup (mirror the simplecc pattern at 49-62):
- In `prepare-public-vendor`, append ` ./public/vendor/libarchive`.
- Add `"copy-libarchive": "cpx \"./node_modules/libarchive.js/dist/*\" ./public/vendor/libarchive"`.
- In `setup-vendors`, append ` && pnpm copy-libarchive`.

Run `pnpm setup-vendors` and confirm `public/vendor/libarchive/worker-bundle.js` + `libarchive.wasm` exist.

- [ ] **Step 2: Write the failing test (repack contract)**

`libarchive.js` runs in a Worker (no jsdom Worker+wasm), so the test targets the **pure repack** half via an injected extractor. Create `apps/readest-app/src/__tests__/utils/comic-convert-web.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { repackToCbz } from '@/utils/comicConvertWeb';

describe('repackToCbz', () => {
  it('packs image entries into a STORE-mode CBZ, sorted, dropping non-images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blob = await repackToCbz([
      { name: '02.png', bytes: png },
      { name: '01.png', bytes: png },
      { name: 'ComicInfo.xml', bytes: new TextEncoder().encode('<ComicInfo/>') },
      { name: 'thumbs.db', bytes: new Uint8Array([0]) },
    ]);
    const { ZipReader, BlobReader, Uint8ArrayWriter } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    expect(entries.map((e) => e.filename)).toEqual(['01.png', '02.png', 'ComicInfo.xml']);
    await reader.close();
  });

  it('rejects an archive with no image pages', async () => {
    await expect(
      repackToCbz([{ name: 'readme.txt', bytes: new Uint8Array([1]) }]),
    ).rejects.toThrow('no readable pages');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm test run src/__tests__/utils/comic-convert-web.test.ts`
Expected: FAIL — `repackToCbz` not exported.

- [ ] **Step 4: Implement the web extractor + repack**

Replace `apps/readest-app/src/utils/comicConvertWeb.ts`:

```ts
const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const KEEP_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

// Repacks extracted entries into a STORE-mode CBZ Blob: images + ComicInfo.xml
// only, sorted by name (page order), uncompressed (already-compressed images).
export const repackToCbz = async (entries: ArchiveEntry[]): Promise<Blob> => {
  const keep = entries
    .filter((e) => KEEP_RE.test(e.name) || /comicinfo\.xml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!keep.some((e) => IMAGE_RE.test(e.name))) {
    throw new Error('no readable pages');
  }
  const { ZipWriter, BlobWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (const e of keep) {
    await writer.add(e.name, new Uint8ArrayReader(e.bytes), { level: 0 });
  }
  return writer.close();
};

let archiveInit: Promise<typeof import('libarchive.js')> | null = null;
const getArchive = async () => {
  if (!archiveInit) {
    archiveInit = import('libarchive.js').then((mod) => {
      // libarchive.js loads its wasm worker from this URL (vendored in Task 4).
      mod.Archive.init({ workerUrl: '/vendor/libarchive/worker-bundle.js' });
      return mod;
    });
  }
  return archiveInit;
};

// Browser path: extract a CBR/CB7 File with libarchive.js, then repack to CBZ.
export const convertArchiveToCbzWeb = async (file: File): Promise<Blob> => {
  const { Archive } = await getArchive();
  const archive = await Archive.open(file);
  if (await archive.hasEncryptedData()) {
    throw new Error('encrypted archives are not supported');
  }
  const filesArray = await archive.getFilesArray(); // [{ file: CompressedFile, path }]
  const entries: ArchiveEntry[] = [];
  for (const { file: cf, path } of filesArray) {
    const name = (path + cf.name).replace(/^\//, '');
    if (!KEEP_RE.test(name) && !/comicinfo\.xml$/i.test(name)) continue;
    const extracted = await cf.extract(); // File/Blob
    entries.push({ name, bytes: new Uint8Array(await extracted.arrayBuffer()) });
  }
  return repackToCbz(entries);
};
```

(Verify the exact `libarchive.js` API against the installed version — `Archive.init`/`Archive.open`/`getFilesArray`/`extract`/`hasEncryptedData`. If method names differ, adapt the extractor; `repackToCbz` is the version-independent, tested contract.)

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm test run src/__tests__/utils/comic-convert-web.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/package.json apps/readest-app/pnpm-lock.yaml \
        apps/readest-app/src/utils/comicConvertWeb.ts \
        apps/readest-app/src/__tests__/utils/comic-convert-web.test.ts
git commit -m "feat(comic): libarchive.js web extractor + STORE-mode cbz repack"
```

---

### Task 5: Wire conversion into the import pipeline

Slot the conversion in right after the TXT→EPUB hook, so hashing and storage operate on the CBZ.

**Files:**
- Modify: `apps/readest-app/src/services/bookService.ts:278-281` (after the TXT block) and `:304` (native guard)
- Create: `apps/readest-app/src/__tests__/services/import-archive-conversion.test.ts`

- [ ] **Step 1: Write the failing test (importer routes CBR through conversion)**

Create `apps/readest-app/src/__tests__/services/import-archive-conversion.test.ts`. Mock `@/utils/comicConvert` and assert that importing a `.cbr` invokes `convertArchiveToCbz` and that a `.cbz`/`.epub` does not. (Follow the existing `bookService` test setup — check `src/__tests__/services/` for the established mock harness for `fs`, `DocumentLoader`, and `partialMD5`; reuse it. The assertion: with a `.cbr` `File`/path input, `convertArchiveToCbz` is called once and `DocumentLoader.open` receives the converted CBZ.)

```ts
import { describe, expect, it, vi } from 'vitest';

const convertMock = vi.fn(
  async (f: File) => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'book.cbz', {
    type: 'application/vnd.comicbook+zip',
  }),
);
vi.mock('@/utils/comicConvert', () => ({ convertArchiveToCbz: convertMock }));
// ... reuse the project's bookService test harness mocks (fs, DocumentLoader, stores) ...

describe('importBook archive conversion', () => {
  it('converts a .cbr before hashing/opening', async () => {
    // import a .cbr fixture File through importBook
    // expect(convertMock).toHaveBeenCalledTimes(1)
    // expect the DocumentLoader received a .cbz
  });
  it('does not convert a .cbz', async () => {
    // import a .cbz; expect(convertMock).not.toHaveBeenCalled()
  });
});
```

(If `bookService.importBook` has no existing unit-test harness, gate this behavior through a small extracted pure helper instead — see Step 3 — and unit-test that helper directly, leaving the `importBook` wiring to the manual smoke in Task 7.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test run src/__tests__/services/import-archive-conversion.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the import hook**

In `apps/readest-app/src/services/bookService.ts`, immediately **after** the TXT block (278-281) and before the `if (!fileobj || fileobj.size === 0)` check, add:

```ts
      if (/\.(cbr|cb7)$/i.test(filename)) {
        const { convertArchiveToCbz } = await import('@/utils/comicConvert');
        fileobj = await convertArchiveToCbz(fileobj, {
          srcPath: typeof file === 'string' ? file : undefined,
          readPathAsFile: (p) => fs.openFile(p, 'None'),
          writeTempAndPath: async (f) => {
            const tmp = `${await fs.getTempDir()}/${f.name}`;
            await fs.writeFile(tmp, 'None', f);
            return tmp;
          },
          deletePath: (p) => fs.removeFile(p, 'None'),
        });
        filename = fileobj.name; // now ends with .cbz
      }
```

Update the native fast-path guard at `:304` so CBR/CB7 never take an EPUB/MOBI native path — change `!/\.txt$/i.test(filename)` to `!/\.(txt|cbr|cb7)$/i.test(filename)` (the rename above already makes `filename` end `.cbz`, but guard defensively).

(Verify the actual `fs` service method names — `openFile`, `writeFile`, `removeFile`, and a temp-dir accessor. If `fs` has no `getTempDir`, use the existing cache-dir accessor used elsewhere in `bookService`/`appService`; grep `getCacheDir`/`tempDir`/`appCacheDir`. Adapt the four injected callbacks to the real `fs` API.)

- [ ] **Step 4: Wrap conversion errors into the standard import error**

Confirm `importBook`'s existing try/catch (or caller `processFile` in `library/page.tsx:694`) surfaces a thrown error as the standard "failed to import {file}" toast. The converter throws `'encrypted archives are not supported'` / `'no readable pages'` / extraction errors — ensure these propagate (don't swallow). Add a test case asserting a converter rejection aborts the import without storing.

- [ ] **Step 5: Run tests + lint**

Run: `pnpm test run src/__tests__/services/import-archive-conversion.test.ts && pnpm lint`
Expected: PASS, lint exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/services/bookService.ts \
        apps/readest-app/src/__tests__/services/import-archive-conversion.test.ts
git commit -m "feat(comic): convert CBR/CB7 to CBZ in the import pipeline"
```

---

### Task 6: Registration points (extensions, file associations, OPDS)

Make the app accept `.cbr`/`.cb7` in pickers, drag-drop, OS file associations, and OPDS.

**Files:**
- Modify: `apps/readest-app/src/services/constants.ts:44-55`
- Modify: `apps/readest-app/src-tauri/tauri.conf.json:78-128`
- Modify: `apps/readest-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Modify: `apps/readest-app/src/services/opds/feedChecker.ts:59-73`

- [ ] **Step 1: Extend `SUPPORTED_BOOK_EXTS`**

In `constants.ts`, add `'cbr', 'cb7'` to the `SUPPORTED_BOOK_EXTS` array. This auto-propagates to `useFileSelector` and the drag-drop filter via `BOOK_ACCEPT_FORMATS`.

- [ ] **Step 2: Add Tauri file associations**

In `tauri.conf.json`, after the existing `cbz` entry (114-120), add:

```json
{ "name": "cbr", "ext": ["cbr"], "description": "CBR comic archive",
  "mimeType": "application/x-cbr", "role": "Viewer" },
{ "name": "cb7", "ext": ["cb7"], "description": "CB7 comic archive",
  "mimeType": "application/x-cb7", "role": "Viewer" }
```

- [ ] **Step 3: Add Android intent filters**

In `AndroidManifest.xml`: after the comicbook MIME `<data>` entries (~52) add `<data android:mimeType="application/x-cbr" />` and `<data android:mimeType="application/x-cb7" />`; after the `.*\\.cbz` pathPattern (~74) add `<data android:pathPattern=".*\\.cbr" />` and `<data android:pathPattern=".*\\.cb7" />`.

Note: `gen/android` is partially generated. Per the android-build-flow memory, confirm whether these edits survive `pnpm tauri android build` — if the manifest is regenerated from a template/config, mirror the change there (the file-associations in `tauri.conf.json` are the source of truth Tauri uses to regenerate intent filters; Step 2 may make Step 3 redundant on a fresh gen — verify on a build).

- [ ] **Step 4: Add OPDS inference rules**

In `feedChecker.ts` `INFERENCE_RULES` (59), after the cbz rule (66), add:

```ts
  { mime: 'application/x-cbr', href: /\.cbr(?:[?#]|$)/i, title: /\bcbr\b/i },
  { mime: 'application/x-cb7', href: /\.cb7(?:[?#]|$)/i, title: /\bcb7\b/i },
```

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`
Expected: exit 0.

```bash
cd /home/julianshen/projects/readest
git add apps/readest-app/src/services/constants.ts \
        apps/readest-app/src-tauri/tauri.conf.json \
        apps/readest-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml \
        apps/readest-app/src/services/opds/feedChecker.ts
git commit -m "feat(comic): register cbr/cb7 in extensions, file associations, OPDS"
```

---

### Task 7: Full verification, manual smoke, release

- [ ] **Step 1: Full web verification**

Run (from `apps/readest-app`): `pnpm test && pnpm lint && pnpm build-web && pnpm check:all`
Expected: all pass, exit 0.

- [ ] **Step 2: Rust verification**

Run: `pnpm test:rust` (and on a machine with the toolchain, `pnpm clippy:check` + `pnpm fmt:check`).
Expected: `comic_parser` tests pass; clippy/fmt clean. (Rely on CI `rust_lint` + `build_tauri_app` for the authoritative build if local desktop libs are missing.)

- [ ] **Step 3: Manual smoke (cannot be automated — present at finish)**

- [ ] Import a real `.cbr` on desktop → opens as a CBZ; pages render; ComicInfo.xml metadata (series/title) preserved.
- [ ] Import a real `.cb7` (7z) → same.
- [ ] Import the same `.cbr` twice → deduped (identical hash; STORE-mode deterministic packing).
- [ ] Import a password-protected `.cbr`/`.cb7` → clear "encrypted archives are not supported" import error; nothing stored.
- [ ] Import a corrupt/truncated archive → import error naming the file; nothing stored.
- [ ] Web build: import a `.cbr` in the browser → libarchive.js path produces a readable CBZ.
- [ ] Android: open a `.cbr` from the file manager (intent filter) → imports and opens.

- [ ] **Step 4: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — re-run the full verification, then push and open a PR. Note in the PR description: (a) the unrar license caveat for maintainer sign-off; (b) `libarchive.js` adds a vendored wasm worker under `public/vendor/libarchive/`; (c) `tauri.conf.json` file associations may make the manual AndroidManifest edits redundant on a fresh android gen — confirm on a build.

---

## Self-review (done at plan time)

- **Spec coverage:** Detection (Task 1 + 6), convert-to-CBZ Rust command (Task 2), web wasm fallback (Task 4), import-time conversion before hashing/storage (Task 5), STORE-mode deterministic packing for dedup (Task 2 `pack_cbz` sorts + STORE; Task 4 `repackToCbz` sorts + `level:0`), encrypted/corrupt/zero-image error paths (Task 2 + 4 + 5), all registration points (Task 6: SUPPORTED_BOOK_EXTS, file pickers via propagation, tauri.conf, AndroidManifest, OPDS). Out-of-scope items (streaming, CBT, keeping original) untouched.
- **Type consistency:** `detectArchiveFormat → 'CBR'|'CB7'|null` (Task 1) used only by the importer; `convertArchiveToCbz(file, opts) → File` (Task 3) consumed in Task 5 with the same signature; `convertArchiveToCbzWeb(file) → Blob` (Task 4) consumed by Task 3; `repackToCbz(ArchiveEntry[]) → Blob` (Task 4) and Rust `pack_cbz(Vec<(String,Vec<u8>)>) → Vec<u8>` mirror each other (sort + STORE + image-required). The produced File is always `.cbz` + comicbook MIME so `isCBZ()` (document.ts:309) passes.
- **Decisions to confirm during implementation (flagged inline):** exact `unrar` 0.5 / `sevenz-rust2` 0.13 / `libarchive.js` APIs; the `fs` service temp-dir + read/write/remove method names in Task 5; whether `tauri.conf.json` associations regenerate the Android manifest (Task 6). The pure, tested contracts (`pack_cbz`, `repackToCbz`, `detectArchiveFormat`) are version-independent.
- **License risk:** `unrar` is not OSI-approved — surfaced for maintainer sign-off in Task 0 and the PR.
