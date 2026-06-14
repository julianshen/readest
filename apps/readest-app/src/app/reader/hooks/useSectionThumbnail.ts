import { useEffect, useState } from 'react';

import { getThumbnailCache } from '@/utils/thumbnailCache';

const THUMB_WIDTH = 160;

interface ComicSection {
  id: string;
  loadImage?: () => Promise<Blob>;
}

// Lazily produces a JPEG dataURL thumbnail for a comic page, cached per bookKey.
// `enabled` is driven by the cell's IntersectionObserver so off-screen cells do
// no decoding work. Returns null until ready (or on decode failure).
export const useSectionThumbnail = (
  bookKey: string,
  section: ComicSection,
  index: number,
  enabled: boolean,
): string | null => {
  const cache = getThumbnailCache(bookKey);
  const [identity, setIdentity] = useState({ bookKey, index });
  const [dataUrl, setDataUrl] = useState<string | null>(() => cache.get(index) ?? null);

  // Cells are keyed by page filename, which can repeat across books; reset
  // synchronously when this instance is reused for a different book/page so a
  // stale thumbnail never flashes.
  if (identity.bookKey !== bookKey || identity.index !== index) {
    setIdentity({ bookKey, index });
    setDataUrl(cache.get(index) ?? null);
  }

  useEffect(() => {
    // Off-screen: drop the local dataURL so memory is bounded by the LRU cache
    // (cap), not by how many pages have been scrolled past. The cache still
    // holds it (up to capacity), so coming back into view restores it without a
    // re-decode.
    if (!enabled) {
      setDataUrl(null);
      return;
    }
    const cached = cache.get(index);
    if (cached) {
      setDataUrl(cached);
      return;
    }
    if (!section.loadImage) return;
    let cancelled = false;
    (async () => {
      try {
        const blob = await section.loadImage!();
        const bitmap = await createImageBitmap(blob);
        const scale = THUMB_WIDTH / bitmap.width;
        const canvas = document.createElement('canvas');
        canvas.width = THUMB_WIDTH;
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          // No 2D context (e.g. canvas-count pressure): bail rather than cache a
          // blank dataURL; the cell keeps its numbered placeholder.
          bitmap.close();
          return;
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const url = canvas.toDataURL('image/jpeg', 0.7);
        cache.set(index, url);
        if (!cancelled) setDataUrl(url);
      } catch {
        // decode failure → leave null; the cell shows a numbered placeholder
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, index, bookKey, section, cache]);

  return dataUrl;
};
