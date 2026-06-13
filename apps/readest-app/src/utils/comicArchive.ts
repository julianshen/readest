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
