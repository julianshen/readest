// Webtoon mode is a per-book preset for fixed-layout comics: seamless vertical
// scroll for manhwa/webtoons. Scroll mode is already fit-width, so webtoon only
// needs to force the scrolled flow, remove the inter-page gap, widen the
// lookahead so strips decode before they enter view, and raise the loaded-page
// cap to match (so eviction doesn't trim pages the wider lookahead is preloading
// — otherwise fast flings outrun decode and show blank strips). When off, the
// renderer returns to the user's scrolled/paginated layout with the defaults.
// Attribute names match FixedLayout's observedAttributes.
export interface WebtoonRendererAttributes {
  flow: 'scrolled' | 'paginated';
  'page-gap': string;
  'scroll-lookahead': string;
  'scroll-max-loaded': string;
}

export const getWebtoonRendererAttributes = (
  webtoon: boolean,
  scrolled: boolean,
): WebtoonRendererAttributes => ({
  flow: webtoon || scrolled ? 'scrolled' : 'paginated',
  'page-gap': webtoon ? '0' : '4',
  'scroll-lookahead': webtoon ? '300%' : '50%',
  'scroll-max-loaded': webtoon ? '10' : '8',
});
