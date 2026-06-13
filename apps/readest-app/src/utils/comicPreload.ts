// Comic (CBZ) preload tuning for foliate's fixed-layout renderer: preload more
// spreads ahead/behind with higher concurrency and a larger LRU cache so page
// turns feel instant, bounded by a byte cap (halved on Android, where WebView
// memory is tighter). Attribute names match FixedLayout's observedAttributes.
const MB = 1024 * 1024;

export const getComicPreloadAttributes = (isAndroid: boolean): Record<string, string> => ({
  'preload-ahead': '3',
  'preload-behind': '1',
  'cache-spreads': '8',
  'preload-concurrency': '2',
  'cache-bytes': String((isAndroid ? 64 : 128) * MB),
});
