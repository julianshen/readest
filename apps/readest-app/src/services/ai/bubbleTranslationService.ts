import { generateText, type LanguageModel } from 'ai';

import { getAIProvider } from '@/services/ai/providers';
import type { AISettings } from '@/services/ai/types';

export const BubbleErrorCodes = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  VISION_UNSUPPORTED: 'VISION_UNSUPPORTED',
  FAILED: 'FAILED',
} as const;

export interface RegionResult {
  transcription: string;
  translation: string;
}

export interface TranslateRegionArgs {
  imageBlob: Blob;
  targetLang: string; // human-readable language name, e.g. "English"
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings): LanguageModel => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error(BubbleErrorCodes.NOT_CONFIGURED);
  }
};

const systemPromptFor = (targetLang: string): string =>
  [
    'You read text from a manga/comic image region and translate it.',
    `Transcribe the original text exactly, then translate it into ${targetLang}.`,
    'Respond in EXACTLY this format, nothing else:',
    'TRANSCRIPTION: <original text on one or more lines, or NO_TEXT>',
    'TRANSLATION: <translation, or NO_TEXT>',
    'If the region contains no readable text, use NO_TEXT for both.',
  ].join('\n');

// Exported for unit testing.
export const parseRegionResult = (text: string): RegionResult => {
  const grab = (label: string): string => {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`);
    const raw = text.match(re)?.[1]?.trim() ?? '';
    return raw === 'NO_TEXT' ? '' : raw;
  };
  return { transcription: grab('TRANSCRIPTION'), translation: grab('TRANSLATION') };
};

const isVisionError = (message: string): boolean =>
  /image|vision|multimodal|not support|unsupported|content type/i.test(message);

export const translateRegion = async ({
  imageBlob,
  targetLang,
  aiSettings,
}: TranslateRegionArgs): Promise<RegionResult> => {
  const model = getModelOrThrow(aiSettings); // fail fast before any I/O
  const image = new Uint8Array(await imageBlob.arrayBuffer());
  try {
    const { text } = await generateText({
      model,
      temperature: 0.2,
      system: systemPromptFor(targetLang),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe and translate the text in this image.' },
            { type: 'image', image },
          ],
        },
      ],
    });
    return parseRegionResult(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === BubbleErrorCodes.NOT_CONFIGURED) throw error;
    if (isVisionError(message)) throw new Error(BubbleErrorCodes.VISION_UNSUPPORTED);
    throw new Error(BubbleErrorCodes.FAILED);
  }
};
