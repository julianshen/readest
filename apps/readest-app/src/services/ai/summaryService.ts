import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings, ChapterSummary } from './types';
import { getAIProvider } from './providers';
import { aiStore, chapterSummaryKey, hashContent } from './storage/aiStore';
import { extractTextFromDocument, MIN_SECTION_CHARS } from './utils/chunker';
import { buildChapterSummaryPrompt, buildRecapPrompt } from './prompts';
import { getChapterTitle } from './ragService';

// ≈6k tokens of input per call; above this a chapter is map-reduced.
const MAX_SINGLE_CALL_CHARS = 24_000;

export const SummaryErrorCodes = {
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  NOTHING_TO_RECAP: 'NOTHING_TO_RECAP',
  CHAPTER_UNREADABLE: 'CHAPTER_UNREADABLE',
} as const;

interface SummaryArgs {
  bookDoc: BookDoc;
  bookHash: string;
  bookTitle: string;
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings): LanguageModel => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error(SummaryErrorCodes.NOT_CONFIGURED);
  }
};

const sectionText = async (bookDoc: BookDoc, index: number): Promise<string | null> => {
  const section = bookDoc.sections?.[index];
  if (!section || section.linear === 'no') return null;
  try {
    const doc = await section.createDocument();
    const text = extractTextFromDocument(doc);
    return text.length >= MIN_SECTION_CHARS ? text : null;
  } catch {
    return null;
  }
};

const splitOnParagraphs = (text: string, maxLen: number): string[] => {
  if (text.length <= maxLen) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen / 2) cut = rest.lastIndexOf('. ', maxLen);
    if (cut < maxLen / 2) cut = maxLen;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim().length) pieces.push(rest);
  return pieces;
};

const summarizeText = async (
  model: LanguageModel,
  args: SummaryArgs,
  chapterTitle: string,
  text: string,
): Promise<string> => {
  const system = buildChapterSummaryPrompt(args.bookTitle, chapterTitle);

  if (text.length <= MAX_SINGLE_CALL_CHARS) {
    const { text: result } = await generateText({
      model,
      system,
      prompt: text,
      temperature: 0.3,
    });
    return result.trim();
  }

  // map: summarize each piece in parallel
  const pieces = splitOnParagraphs(text, MAX_SINGLE_CALL_CHARS);
  const pieceSummaries = await Promise.all(
    pieces.map(async (piece) => {
      const { text: pieceSummary } = await generateText({
        model,
        system,
        prompt: piece,
        temperature: 0.3,
      });
      return pieceSummary.trim();
    }),
  );

  // reduce: merge piece summaries into one
  const { text: merged } = await generateText({
    model,
    system,
    prompt: `These are sequential partial summaries of one chapter; merge them:\n\n${pieceSummaries.join('\n\n')}`,
    temperature: 0.3,
  });
  return merged.trim();
};

const summarizeChapterWithModel = async (
  model: LanguageModel,
  args: SummaryArgs & { sectionIndex: number },
): Promise<string> => {
  const text = await sectionText(args.bookDoc, args.sectionIndex);
  if (!text) throw new Error(SummaryErrorCodes.CHAPTER_UNREADABLE);
  const contentHash = hashContent(text);
  const cached = await aiStore.getChapterSummary(args.bookHash, args.sectionIndex);
  if (cached && cached.contentHash === contentHash) return cached.summary;

  const summary = await summarizeText(
    model,
    args,
    getChapterTitle(args.bookDoc.toc, args.sectionIndex),
    text,
  );
  const entry: ChapterSummary = {
    key: chapterSummaryKey(args.bookHash, args.sectionIndex),
    bookHash: args.bookHash,
    sectionIndex: args.sectionIndex,
    contentHash,
    summary,
    createdAt: Date.now(),
  };
  await aiStore.saveChapterSummary(entry);
  return summary;
};

export async function summarizeChapter(
  args: SummaryArgs & { sectionIndex: number },
): Promise<string> {
  const model = getModelOrThrow(args.aiSettings); // fail fast before any I/O
  return summarizeChapterWithModel(model, args);
}

export async function recapToPosition(
  args: SummaryArgs & { currentSectionIndex: number },
): Promise<string> {
  const model = getModelOrThrow(args.aiSettings);
  if (args.currentSectionIndex <= 0) {
    throw new Error(SummaryErrorCodes.NOTHING_TO_RECAP);
  }
  const parts: string[] = [];
  for (let i = 0; i < args.currentSectionIndex; i++) {
    try {
      const summary = await summarizeChapterWithModel(model, { ...args, sectionIndex: i });
      parts.push(`${getChapterTitle(args.bookDoc.toc, i)}:\n${summary}`);
    } catch (e) {
      if ((e as Error).message === SummaryErrorCodes.NOT_CONFIGURED) throw e;
      parts.push(`Chapter ${i + 1} could not be read.`);
    }
  }
  const { text } = await generateText({
    model,
    system: buildRecapPrompt(args.bookTitle),
    prompt: parts.join('\n\n'),
    temperature: 0.4,
  });
  return text.trim();
}
