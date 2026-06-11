import { generateText } from 'ai';
import { stubTranslation as _ } from '@/utils/misc';
import { useSettingsStore } from '@/store/settingsStore';
import { normalizeToShortLang } from '@/utils/lang';
import { OpenAIProvider } from '@/services/ai/providers/OpenAIProvider';
import { ErrorCodes, TranslationProvider } from '../types';
import type { AISettings } from '@/services/ai/types';

const getAISettings = (): AISettings | undefined =>
  useSettingsStore.getState().settings?.aiSettings;

// LLMs love fencing JSON even when told not to; strip a single outer fence.
const stripCodeFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

const statusCodeOf = (e: unknown): number | undefined =>
  typeof e === 'object' && e !== null && 'statusCode' in e
    ? (e as { statusCode?: number }).statusCode
    : undefined;

const mapApiError = (e: unknown): Error | null => {
  const status = statusCodeOf(e);
  if (status === 401 || status === 403) return new Error(ErrorCodes.UNAUTHORIZED);
  if (status === 429) return new Error(ErrorCodes.DAILY_QUOTA_EXCEEDED);
  return null;
};

const buildSystemPrompt = (sourceLang: string, targetLang: string): string => {
  const source = normalizeToShortLang(sourceLang).toLowerCase();
  const target = normalizeToShortLang(targetLang).toLowerCase();
  const from = source && source !== 'auto' ? ` from the language with code "${source}"` : '';
  return (
    `You are a translation engine. The user message is a JSON array of strings. ` +
    `Translate each element${from} into the language with code "${target}". ` +
    `Preserve meaning, tone, inline punctuation, numbers, and any markup. ` +
    `Respond with ONLY a JSON array of strings of exactly the same length and order. ` +
    `No commentary, no code fences.`
  );
};

const parseAligned = (raw: string, expectedLength: number): string[] => {
  const parsed: unknown = JSON.parse(stripCodeFences(raw));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    !parsed.every((item): item is string => typeof item === 'string')
  ) {
    throw new Error('Misaligned translation output');
  }
  return parsed;
};

export const openaiProvider: TranslationProvider = {
  name: 'openai',
  label: _('OpenAI (ChatGPT)'),
  // Uses the user's own OpenAI key, not the Readest cloud token.
  authRequired: false,
  isAvailable: () => !!getAISettings()?.openaiApiKey,
  translate: async (texts: string[], sourceLang: string, targetLang: string): Promise<string[]> => {
    if (!texts.length) return [];
    const aiSettings = getAISettings();
    if (!aiSettings?.openaiApiKey) {
      throw new Error(ErrorCodes.UNAUTHORIZED);
    }

    // Empty/whitespace lines pass through; only real text goes to the model.
    const nonEmptyIndices = texts
      .map((line, i) => (line?.trim().length ? i : -1))
      .filter((i) => i >= 0);
    if (!nonEmptyIndices.length) return [...texts];
    const nonEmpty = nonEmptyIndices.map((i) => texts[i]!);

    const model = new OpenAIProvider(aiSettings).getModel();
    const system = buildSystemPrompt(sourceLang, targetLang);

    // Book text could contain instruction-like content (prompt injection).
    // JSON.stringify keeps it from breaking the JSON envelope, and
    // parseAligned's length/type guard turns any derailed response into an
    // error rather than corrupted output; worst case is a bad translation.
    const requestOnce = async (): Promise<string[]> => {
      const { text } = await generateText({
        model,
        system,
        prompt: JSON.stringify(nonEmpty),
        temperature: 0,
      });
      return parseAligned(text, nonEmpty.length);
    };

    let translated: string[];
    try {
      translated = await requestOnce();
    } catch (firstError) {
      const apiError = mapApiError(firstError);
      if (apiError) throw apiError; // auth/quota: retrying won't help
      try {
        translated = await requestOnce(); // one retry for malformed output
      } catch (secondError) {
        throw mapApiError(secondError) ?? secondError;
      }
    }

    const results = [...texts];
    nonEmptyIndices.forEach((originalIndex, j) => {
      results[originalIndex] = translated[j]!;
    });
    return results;
  },
};
