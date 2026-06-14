import { describe, expect, it } from 'vitest';

import { getWebtoonRendererAttributes } from '@/utils/webtoon';

describe('getWebtoonRendererAttributes', () => {
  it('forces scrolled, zero gap, large lookahead when webtoon is on', () => {
    expect(getWebtoonRendererAttributes(true, false)).toEqual({
      flow: 'scrolled',
      'page-gap': '0',
      'scroll-lookahead': '200%',
    });
  });

  it('keeps scrolled flow but restores default gap/lookahead when off and already scrolled', () => {
    expect(getWebtoonRendererAttributes(false, true)).toEqual({
      flow: 'scrolled',
      'page-gap': '4',
      'scroll-lookahead': '50%',
    });
  });

  it('returns paginated flow with defaults when both off', () => {
    expect(getWebtoonRendererAttributes(false, false)).toEqual({
      flow: 'paginated',
      'page-gap': '4',
      'scroll-lookahead': '50%',
    });
  });
});
