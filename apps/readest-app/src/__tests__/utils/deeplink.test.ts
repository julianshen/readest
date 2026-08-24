import { describe, it, expect } from 'vitest';
import { buildAnnotationUrl, parseBookDeepLink } from '../../utils/deeplink';

describe('buildAnnotationUrl', () => {
  const link = { bookHash: 'abc', noteId: 'n1', cfi: '/6/4!/4/2' };

  it('builds the custom-scheme app URL when linkType is "app"', () => {
    const url = buildAnnotationUrl(link, 'app');
    expect(url.startsWith('readest://book/abc/annotation/n1')).toBe(true);
  });

  it('builds the HTTPS web URL when linkType is "web"', () => {
    const url = buildAnnotationUrl(link, 'web');
    expect(url.startsWith('https://')).toBe(true);
    expect(url).toContain('/o/book/abc/annotation/n1');
  });

  it('preserves the cfi query for both link types', () => {
    const encoded = encodeURIComponent(link.cfi);
    expect(buildAnnotationUrl(link, 'app')).toContain(`cfi=${encoded}`);
    expect(buildAnnotationUrl(link, 'web')).toContain(`cfi=${encoded}`);
  });

  it('omits the cfi query when no cfi is provided', () => {
    const url = buildAnnotationUrl({ bookHash: 'abc', noteId: 'n1' }, 'app');
    expect(url).toBe('readest://book/abc/annotation/n1');
  });
});

describe('parseBookDeepLink', () => {
  it('parses a bare custom-scheme book link', () => {
    expect(parseBookDeepLink('readest://book/abc123')).toEqual({ bookHash: 'abc123' });
  });

  it('parses the HTTPS web-form book link', () => {
    expect(parseBookDeepLink('https://web.readest.com/o/book/abc123')).toEqual({
      bookHash: 'abc123',
    });
  });

  it('returns null for annotation links (owned by parseAnnotationDeepLink)', () => {
    expect(parseBookDeepLink('readest://book/abc123/annotation/n1')).toBeNull();
  });

  it('returns null for unrelated URLs', () => {
    expect(parseBookDeepLink('readest://auth-callback')).toBeNull();
    expect(parseBookDeepLink('https://web.readest.com/library')).toBeNull();
  });
});
