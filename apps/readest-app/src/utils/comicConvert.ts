import { invoke } from '@tauri-apps/api/core';
import { isTauriAppPlatform } from '@/services/environment';
import { convertArchiveToCbzWeb } from '@/utils/comicConvertWeb';

const CBZ_MIME = 'application/vnd.comicbook+zip';

const toCbzName = (name: string) => name.replace(/\.(cb7|7z)$/i, '') + '.cbz';

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

// Converts a CB7 (7z) File to a CBZ File. On Tauri, routes through the Rust
// `convert_to_cbz` command; on web, through the libarchive.js wasm extractor.
export const convertArchiveToCbz = async (file: File, opts: ConvertOptions = {}): Promise<File> => {
  if (isTauriAppPlatform()) {
    const srcPath = opts.srcPath ?? (await opts.writeTempAndPath!(file));
    const dstPath = await invoke<string>('convert_to_cbz', { srcPath });
    const cbz = await opts.readPathAsFile!(dstPath);
    if (opts.deletePath) await opts.deletePath(dstPath).catch(() => {});
    // Re-wrap to guarantee the .cbz name + comicbook MIME (so isCBZ() passes).
    return new File([await cbz.arrayBuffer()], toCbzName(file.name), { type: CBZ_MIME });
  }
  const blob = await convertArchiveToCbzWeb(file);
  return new File([await blob.arrayBuffer()], toCbzName(file.name), { type: CBZ_MIME });
};
