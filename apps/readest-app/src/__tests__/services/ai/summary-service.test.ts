import { describe, it, expect, vi, beforeEach } from 'vitest';

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: vi.fn((settings: { openaiApiKey?: string }) => {
    if (!settings.openaiApiKey) throw new Error('API key required');
    return { getModel: () => ({ modelId: 'test-model' }) };
  }),
}));

const cache = new Map<string, import('@/services/ai/types').ChapterSummary>();
vi.mock('@/services/ai/storage/aiStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ai/storage/aiStore')>();
  return {
    ...actual,
    aiStore: {
      getChapterSummary: vi.fn(async (b: string, i: number) => cache.get(`${b}:${i}`) ?? null),
      saveChapterSummary: vi.fn(async (s: import('@/services/ai/types').ChapterSummary) => {
        cache.set(s.key, s);
      }),
    },
  };
});

import { summarizeChapter, recapToPosition } from '@/services/ai/summaryService';

const sectionDoc = (text: string) => {
  const doc = document.implementation.createHTMLDocument('s');
  doc.body.textContent = text;
  return doc;
};
const makeBookDoc = (texts: string[]) =>
  ({
    metadata: { title: 'Test Book' },
    toc: [],
    sections: texts.map((t, i) => ({
      linear: 'yes',
      size: t.length,
      createDocument: async () => sectionDoc(t),
      id: String(i),
    })),
  }) as never;

const SETTINGS = { openaiApiKey: 'k' } as never;
const longText = (label: string) => `${label} ` + 'sentence of plot. '.repeat(40);

beforeEach(() => {
  generateTextMock.mockReset();
  cache.clear();
  generateTextMock.mockImplementation(
    async ({ system, prompt }: { system?: string; prompt: string }) => {
      if (!system || !prompt) throw new Error('generateText called without system or prompt');
      return { text: `SUM(${prompt.length})` };
    },
  );
});

describe('summarizeChapter', () => {
  it('summarizes a small chapter with a single call and caches it', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    const out = await summarizeChapter({
      bookDoc,
      bookHash: 'h1',
      bookTitle: 'Test Book',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    expect(out).toMatch(/^SUM\(/);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]![0] as { system: string; prompt: string };
    expect(call.system).toContain('Test Book');
    expect(call.prompt).toContain('sentence of plot');

    generateTextMock.mockClear();
    const again = await summarizeChapter({
      bookDoc,
      bookHash: 'h1',
      bookTitle: 'Test Book',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    expect(again).toBe(out);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('invalidates the cache when content changes', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    await summarizeChapter({
      bookDoc,
      bookHash: 'h2',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    const stale = cache.get('h2:0')!;
    cache.set('h2:0', { ...stale, contentHash: 'stale' });
    generateTextMock.mockClear();
    await summarizeChapter({
      bookDoc,
      bookHash: 'h2',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('map-reduces chapters above the single-call limit', async () => {
    const huge = 'paragraph of plot.\n\n'.repeat(2000);
    const bookDoc = makeBookDoc([huge]);
    await summarizeChapter({
      bookDoc,
      bookHash: 'h3',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('throws AI_NOT_CONFIGURED without a provider key', async () => {
    const bookDoc = makeBookDoc([longText('one')]);
    await expect(
      summarizeChapter({
        bookDoc,
        bookHash: 'h4',
        bookTitle: 'T',
        uiLanguage: 'en-US',
        aiSettings: {} as never,
        sectionIndex: 0,
      }),
    ).rejects.toThrow('AI_NOT_CONFIGURED');
  });

  it('map-reduces CJK text without sentence-period separators', async () => {
    const huge = '雙城記第一章開頭'.repeat(5000); // 40k chars, no '. ' or '\n\n'
    const bookDoc = makeBookDoc([huge]);
    await summarizeChapter({
      bookDoc,
      bookHash: 'h9',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      sectionIndex: 0,
    });
    expect(generateTextMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe('recapToPosition', () => {
  it('summarizes only sections before the current one, then synthesizes', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b'), longText('c'), longText('d')]);
    const recap = await recapToPosition({
      bookDoc,
      bookHash: 'h5',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      currentSectionIndex: 2,
    });
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    expect(recap).toMatch(/^SUM\(/);
    expect(cache.has('h5:0') && cache.has('h5:1')).toBe(true);
    expect(cache.has('h5:2')).toBe(false);
  });

  it('reuses cached chapter summaries on a later recap', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b'), longText('c'), longText('d')]);
    await recapToPosition({
      bookDoc,
      bookHash: 'h6',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      currentSectionIndex: 2,
    });
    generateTextMock.mockClear();
    await recapToPosition({
      bookDoc,
      bookHash: 'h6',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      currentSectionIndex: 3,
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it('skips unreadable sections with a note instead of failing', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b')]);
    (bookDoc as { sections: { createDocument: () => Promise<Document> }[] })
      .sections[0]!.createDocument = async () => {
      throw new Error('corrupt');
    };
    const recap = await recapToPosition({
      bookDoc,
      bookHash: 'h7',
      bookTitle: 'T',
      uiLanguage: 'en-US',
      aiSettings: SETTINGS,
      currentSectionIndex: 2,
    });
    expect(recap).toBeTruthy();
    const synthesisPrompt = generateTextMock.mock.calls.at(-1)![0].prompt as string;
    expect(synthesisPrompt).toMatch(/Chapter 1 could not be read/);
  });

  it('propagates AI_NOT_CONFIGURED instead of degrading to notes', async () => {
    const bookDoc = makeBookDoc([longText('a'), longText('b')]);
    await expect(
      recapToPosition({
        bookDoc,
        bookHash: 'h8',
        bookTitle: 'T',
        uiLanguage: 'en-US',
        aiSettings: {} as never,
        currentSectionIndex: 2,
      }),
    ).rejects.toThrow('AI_NOT_CONFIGURED');
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('throws NOTHING_TO_RECAP at the very beginning', async () => {
    const bookDoc = makeBookDoc([longText('a')]);
    await expect(
      recapToPosition({
        bookDoc,
        bookHash: 'h10',
        bookTitle: 'T',
        uiLanguage: 'en-US',
        aiSettings: SETTINGS,
        currentSectionIndex: 0,
      }),
    ).rejects.toThrow('NOTHING_TO_RECAP');
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
