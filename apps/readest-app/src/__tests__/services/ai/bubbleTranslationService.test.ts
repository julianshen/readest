import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateTextMock = vi.fn();
vi.mock('ai', () => ({ generateText: (args: unknown) => generateTextMock(args) }));
const getAIProviderMock = vi.fn();
vi.mock('@/services/ai/providers', () => ({
  getAIProvider: (s: unknown) => getAIProviderMock(s),
}));

import {
  translateRegion,
  BubbleErrorCodes,
  parseRegionResult,
} from '@/services/ai/bubbleTranslationService';
import type { AISettings } from '@/services/ai/types';

const settings = { enabled: true, provider: 'openai', openaiApiKey: 'k' } as unknown as AISettings;
const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

describe('parseRegionResult', () => {
  it('splits TRANSCRIPTION/TRANSLATION blocks', () => {
    expect(parseRegionResult('TRANSCRIPTION: こんにちは\nTRANSLATION: Hello')).toEqual({
      transcription: 'こんにちは',
      translation: 'Hello',
    });
  });
  it('maps NO_TEXT to empty fields', () => {
    expect(parseRegionResult('TRANSCRIPTION: NO_TEXT\nTRANSLATION: NO_TEXT')).toEqual({
      transcription: '',
      translation: '',
    });
  });
});

describe('translateRegion', () => {
  beforeEach(() => {
    getAIProviderMock.mockReset().mockReturnValue({ getModel: () => ({}) });
    generateTextMock
      .mockReset()
      .mockResolvedValue({ text: 'TRANSCRIPTION: やあ\nTRANSLATION: Hi' });
  });

  it('pins the target language in the system prompt and sends an image part', async () => {
    const out = await translateRegion({
      imageBlob: blob,
      targetLang: 'English',
      aiSettings: settings,
    });
    expect(out).toEqual({ transcription: 'やあ', translation: 'Hi' });
    const call = generateTextMock.mock.calls[0]![0];
    expect(call.system).toMatch(/English/);
    const parts = call.messages[0].content;
    expect(parts.some((p: { type: string }) => p.type === 'image')).toBe(true);
    expect(call.temperature).toBeLessThanOrEqual(0.3);
  });

  it('throws NOT_CONFIGURED before any call when provider is unavailable', async () => {
    getAIProviderMock.mockImplementation(() => {
      throw new Error('no key');
    });
    await expect(
      translateRegion({ imageBlob: blob, targetLang: 'English', aiSettings: settings }),
    ).rejects.toThrow(BubbleErrorCodes.NOT_CONFIGURED);
  });

  it('maps provider vision errors to VISION_UNSUPPORTED', async () => {
    generateTextMock.mockRejectedValue(new Error('model does not support image input'));
    await expect(
      translateRegion({ imageBlob: blob, targetLang: 'English', aiSettings: settings }),
    ).rejects.toThrow(BubbleErrorCodes.VISION_UNSUPPORTED);
  });
});
