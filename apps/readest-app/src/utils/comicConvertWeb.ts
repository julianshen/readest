import { Archive } from 'libarchive.js';

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
  // Deterministic STORE packing: pin a fixed modification date and drop the
  // extended-timestamp extra field so re-importing identical input produces
  // byte-identical output (stable partialMD5 → library dedup works).
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), {
    extendedTimestamp: false,
  });
  for (const e of keep) {
    await writer.add(e.name, new Uint8ArrayReader(e.bytes), {
      level: 0,
      lastModDate: new Date(0),
    });
  }
  return writer.close();
};

let initialized = false;

const ensureInit = (): void => {
  if (initialized) return;
  Archive.init({ workerUrl: '/vendor/libarchive/worker-bundle.js' });
  initialized = true;
};

interface ArchiveFileEntry {
  file: { name: string; extract: () => Promise<File> };
}

// Extracts a CBR/CB7 (or any libarchive-supported) archive in the browser via
// the libarchive.js wasm worker, then repacks the image pages + ComicInfo.xml
// into a STORE-mode CBZ Blob.
export const convertArchiveToCbzWeb = async (file: File): Promise<Blob> => {
  ensureInit();
  const archive = await Archive.open(file);
  try {
    if (await archive.hasEncryptedData()) {
      throw new Error('encrypted archives are not supported');
    }
    const filesArray = (await archive.getFilesArray()) as ArchiveFileEntry[];
    const entries: ArchiveEntry[] = [];
    for (const { file: compressed } of filesArray) {
      const { name } = compressed;
      if (!KEEP_RE.test(name) && !/comicinfo\.xml$/i.test(name)) continue;
      const extracted = await compressed.extract();
      entries.push({ name, bytes: new Uint8Array(await extracted.arrayBuffer()) });
    }
    return repackToCbz(entries);
  } finally {
    await archive.close();
  }
};
