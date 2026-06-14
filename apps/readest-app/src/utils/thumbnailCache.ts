// Per-bookKey LRU of page-thumbnail dataURLs (insertion-order Map; re-insert on
// access to mark recency). Caps memory for large comics: a 1000-page CBZ keeps
// at most `capacity` small JPEG dataURLs resident, not 1000 decoded images.
export class ThumbnailLRU {
  private readonly map = new Map<number, string>();
  constructor(private readonly capacity: number) {}

  get(index: number): string | undefined {
    const value = this.map.get(index);
    if (value === undefined) return undefined;
    // Refresh recency.
    this.map.delete(index);
    this.map.set(index, value);
    return value;
  }

  set(index: number, dataUrl: string): void {
    if (this.map.has(index)) this.map.delete(index);
    this.map.set(index, dataUrl);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

const THUMBNAIL_CAPACITY = 200;
const caches = new Map<string, ThumbnailLRU>();

// One LRU per bookKey; created on demand. Call clearThumbnailCache on unmount.
export const getThumbnailCache = (bookKey: string): ThumbnailLRU => {
  let cache = caches.get(bookKey);
  if (!cache) {
    cache = new ThumbnailLRU(THUMBNAIL_CAPACITY);
    caches.set(bookKey, cache);
  }
  return cache;
};

export const clearThumbnailCache = (bookKey: string): void => {
  caches.delete(bookKey);
};
