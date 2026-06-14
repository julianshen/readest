// Webtoon mode is a per-book preset for fixed-layout comics: seamless vertical
// scroll for manhwa/webtoons. Scroll mode is already fit-width, so webtoon only
// needs to force the scrolled flow, remove the inter-page gap, and widen the
// lookahead so strips decode before they enter view. When off, the renderer
// returns to the user's scrolled/paginated layout with the default gap.
// Attribute names match FixedLayout's observedAttributes.
export interface WebtoonRendererAttributes {
  flow: 'scrolled' | 'paginated';
  'page-gap': string;
  'scroll-lookahead': string;
}

export const getWebtoonRendererAttributes = (
  webtoon: boolean,
  scrolled: boolean,
): WebtoonRendererAttributes => ({
  flow: webtoon || scrolled ? 'scrolled' : 'paginated',
  'page-gap': webtoon ? '0' : '4',
  'scroll-lookahead': webtoon ? '200%' : '50%',
});
