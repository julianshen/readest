import { describe, expect, it } from 'vitest';

import { getWebtoonRendererAttributes } from '@/utils/webtoon';

describe('getWebtoonRendererAttributes', () => {
  it('forces scrolled, zero gap, wide lookahead and a larger loaded cap when webtoon is on', () => {
    expect(getWebtoonRendererAttributes(true, false)).toEqual({
      flow: 'scrolled',
      'page-gap': '0',
      'scroll-lookahead': '300%',
      'scroll-max-loaded': '10',
    });
  });

  it('keeps scrolled flow but restores default gap/lookahead/cap when off and already scrolled', () => {
    expect(getWebtoonRendererAttributes(false, true)).toEqual({
      flow: 'scrolled',
      'page-gap': '4',
      'scroll-lookahead': '50%',
      'scroll-max-loaded': '8',
    });
  });

  it('returns paginated flow with defaults when both off', () => {
    expect(getWebtoonRendererAttributes(false, false)).toEqual({
      flow: 'paginated',
      'page-gap': '4',
      'scroll-lookahead': '50%',
      'scroll-max-loaded': '8',
    });
  });
});
