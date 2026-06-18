import type { DetectedRegion, TranslatedRegion } from './types';

export type BatchTranslate = (
  input: string[],
  options: { source: string; target: string },
) => Promise<string[]>;

export const pageCacheKey = (bookKey: string, sectionIndex: number, target: string): string =>
  `${bookKey}::${sectionIndex}::${target}`;

// Translate a page's detected regions in one batch. Blank originals are kept
// as-is; on failure each region falls back to showing its original text so the
// overlay still renders something useful.
export const translateRegions = async (
  regions: DetectedRegion[],
  translate: BatchTranslate,
  langs: { source: string; target: string },
): Promise<TranslatedRegion[]> => {
  const indices = regions.map((r, i) => (r.original.trim() ? i : -1)).filter((i) => i >= 0);
  let translations: string[] = [];
  try {
    if (indices.length) {
      translations = await translate(
        indices.map((i) => regions[i]!.original),
        langs,
      );
    }
  } catch {
    translations = indices.map((i) => regions[i]!.original); // fallback to source
  }
  const byIndex = new Map(indices.map((i, k) => [i, translations[k] ?? regions[i]!.original]));
  return regions.map((r, i) => ({ ...r, translation: byIndex.get(i) ?? '' }));
};
