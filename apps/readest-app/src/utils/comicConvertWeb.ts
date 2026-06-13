import { Archive } from 'libarchive.js';

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const KEEP_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

export interface ArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

const isKeepableName = (name: string): boolean =>
  KEEP_RE.test(name) || /comicinfo\.xml$/i.test(name);
const byName = (a: string, b: string): number => a.localeCompare(b);

// Deterministic STORE packing: pin a fixed modification date and drop the
// extended-timestamp extra field so re-importing identical input produces
// byte-identical output (stable partialMD5 → library dedup works). Shared by
// repackToCbz and the streaming convertArchiveToCbzWeb so output stays
// byte-identical regardless of which path produced it.
const CBZ_WRITER_OPTS = { extendedTimestamp: false } as const;
const ADD_OPTS = { level: 0, lastModDate: new Date(0) } as const;

// Repacks extracted entries into a STORE-mode CBZ Blob: images + ComicInfo.xml
// only, sorted by name (page order), uncompressed (already-compressed images).
export const repackToCbz = async (entries: ArchiveEntry[]): Promise<Blob> => {
  const keep = entries.filter((e) => isKeepableName(e.name)).sort((a, b) => byName(a.name, b.name));
  if (!keep.some((e) => IMAGE_RE.test(e.name))) {
    throw new Error('no readable pages');
  }
  const { ZipWriter, BlobWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), CBZ_WRITER_OPTS);
  for (const e of keep) {
    await writer.add(e.name, new Uint8ArrayReader(e.bytes), ADD_OPTS);
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
    // Filter + sort by METADATA name first, then stream each kept entry's bytes
    // straight into the zip so only one file's bytes are resident at a time
    // (O(largest entry) instead of O(total uncompressed) — avoids OOM on large
    // archives, especially on mobile). Same comparator + determinism options as
    // repackToCbz keep the streamed output byte-identical.
    const keep = filesArray
      .filter(({ file: f }) => isKeepableName(f.name))
      .sort((a, b) => byName(a.file.name, b.file.name));
    if (!keep.some(({ file: f }) => IMAGE_RE.test(f.name))) {
      throw new Error('no readable pages');
    }
    const { ZipWriter, BlobWriter, Uint8ArrayReader } = await import('@zip.js/zip.js');
    const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), CBZ_WRITER_OPTS);
    for (const { file: compressed } of keep) {
      const extracted = await compressed.extract();
      const bytes = new Uint8Array(await extracted.arrayBuffer());
      await writer.add(compressed.name, new Uint8ArrayReader(bytes), ADD_OPTS);
    }
    return writer.close();
  } finally {
    await archive.close();
  }
};
