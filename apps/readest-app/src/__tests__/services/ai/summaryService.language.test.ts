import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChapterSummary } from '@/services/ai/types';

const { generateTextMock, cache } = vi.hoisted(() => {
  const generateTextMock = vi.fn();
  const cache = new Map<string, ChapterSummary>();
  return { generateTextMock, cache };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: generateTextMock };
});
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: () => ({ getModel: () => ({}) }),
}));
vi.mock('@/services/ai/storage/aiStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ai/storage/aiStore')>();
  return {
    ...actual,
    aiStore: {
      getChapterSummary: vi.fn(async (b: string, i: number) => cache.get(`${b}:${i}`) ?? null),
      saveChapterSummary: vi.fn(async (s: ChapterSummary) => {
        cache.set(s.key, s);
      }),
    },
  };
});

import { summarizeChapter } from '@/services/ai/summaryService';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from '@/services/ai/types';

const makeDoc = () =>
  ({
    metadata: { language: 'ja' },
    toc: [],
    sections: [
      {
        linear: 'yes',
        createDocument: async () => {
          const d = document.implementation.createHTMLDocument('');
          d.body.textContent = 'これはテスト本文です。'.repeat(20);
          return d;
        },
      },
    ],
  }) as unknown as BookDoc;

const baseArgs = (answerLanguage: 'book' | 'app') => ({
  bookDoc: makeDoc(),
  bookHash: 'h1',
  bookTitle: 'T',
  uiLanguage: 'en-US',
  aiSettings: { enabled: true, provider: 'ollama', answerLanguage } as unknown as AISettings,
  sectionIndex: 0,
});

describe('summaryService answer language', () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    cache.clear();
    generateTextMock.mockResolvedValue({ text: 'summary' });
  });

  it("uses the book language when answerLanguage is 'book'", async () => {
    await summarizeChapter(baseArgs('book'));
    expect(generateTextMock.mock.calls[0]![0].system).toContain('Japanese');
  });

  it("uses the UI language when answerLanguage is 'app'", async () => {
    await summarizeChapter(baseArgs('app'));
    expect(generateTextMock.mock.calls[0]![0].system).toContain('English');
  });
});
