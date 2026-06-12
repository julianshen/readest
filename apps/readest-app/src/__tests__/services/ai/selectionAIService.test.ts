import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamTextMock = vi.fn();
vi.mock('ai', () => ({ streamText: (args: unknown) => streamTextMock(args) }));
const getAIProviderMock = vi.fn();
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: (s: unknown) => getAIProviderMock(s),
}));

import { runSelectionAction, SelectionErrorCodes } from '@/services/ai/selectionAIService';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from '@/services/ai/types';

const makeDoc = () =>
  ({
    metadata: { language: 'ja' },
    sections: [
      {
        createDocument: async () => {
          const d = document.implementation.createHTMLDocument('');
          d.body.textContent = 'PRE 選択された語 POST';
          return d;
        },
      },
    ],
  }) as unknown as BookDoc;

const args = (answerLanguage: 'book' | 'app') => ({
  bookDoc: makeDoc(),
  sectionIndex: 0,
  selectedText: '選択された語',
  uiLanguage: 'en-US',
  aiSettings: { enabled: true, provider: 'ollama', answerLanguage } as unknown as AISettings,
});

const drain = async (it: AsyncIterable<string>) => {
  let out = '';
  for await (const c of it) out += c;
  return out;
};

async function* fakeStream() {
  yield 'hello';
}

describe('selectionAIService', () => {
  beforeEach(() => {
    getAIProviderMock.mockReset().mockReturnValue({ getModel: () => ({}) });
    streamTextMock.mockReset().mockReturnValue({ textStream: fakeStream() });
  });

  it('explain uses the answer language and the spoiler-safe context', async () => {
    const text = await drain(runSelectionAction('explain', args('app')));
    expect(text).toBe('hello');
    const call = streamTextMock.mock.calls[0]![0];
    expect(call.system).toMatch(/in English/i); // app -> UI language
    expect(call.prompt).toBe('PRE «選択された語»'); // no POST
  });

  it("explain follows the book language when answerLanguage is 'book'", async () => {
    await drain(runSelectionAction('explain', args('book')));
    expect(streamTextMock.mock.calls[0]![0].system).toMatch(/in Japanese/i);
  });

  it('simplify always uses the book language regardless of setting', async () => {
    await drain(runSelectionAction('simplify', args('app')));
    expect(streamTextMock.mock.calls[0]![0].system).toMatch(/simpler.*Japanese/i);
  });

  it('throws NOT_CONFIGURED before any extraction when provider is unavailable', async () => {
    getAIProviderMock.mockImplementation(() => {
      throw new Error('no key');
    });
    await expect(drain(runSelectionAction('explain', args('book')))).rejects.toThrow(
      SelectionErrorCodes.NOT_CONFIGURED,
    );
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});
