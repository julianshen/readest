import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings, ChapterSummary } from './types';
import { getAIProvider } from './providers';
import { aiStore, chapterSummaryKey, hashContent } from './storage/aiStore';
import { extractTextFromDocument } from './utils/chunker';
import { buildChapterSummaryPrompt, buildRecapPrompt } from './prompts';

// ≈6k tokens of input per call; above this a chapter is map-reduced.
const MAX_SINGLE_CALL_CHARS = 24_000;
// Mirrors indexBook: sections shorter than this carry no summarizable prose.
const MIN_SECTION_CHARS = 100;

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
    throw new Error('AI_NOT_CONFIGURED');
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

/**
 * Mirrors ragService.ts `getChapterTitle` (module-private there; replicated here verbatim).
 * Source: src/services/ai/ragService.ts – getChapterTitle()
 */
const chapterTitleOf = (bookDoc: BookDoc, sectionIndex: number): string => {
  const toc = bookDoc.toc;
  if (!toc || toc.length === 0) return `Section ${sectionIndex + 1}`;
  for (let i = toc.length - 1; i >= 0; i--) {
    if (toc[i]!.id <= sectionIndex) return toc[i]!.label;
  }
  return toc[0]?.label || `Section ${sectionIndex + 1}`;
};

const summarizeText = async (
  args: SummaryArgs,
  chapterTitle: string,
  text: string,
): Promise<string> => {
  const model = getModelOrThrow(args.aiSettings);
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

  // map: summarize each piece
  const pieces = splitOnParagraphs(text, MAX_SINGLE_CALL_CHARS);
  const pieceSummaries: string[] = [];
  for (const piece of pieces) {
    const { text: pieceSummary } = await generateText({
      model,
      system,
      prompt: piece,
      temperature: 0.3,
    });
    pieceSummaries.push(pieceSummary.trim());
  }

  // reduce: merge piece summaries into one
  const { text: merged } = await generateText({
    model,
    system,
    prompt: `These are sequential partial summaries of one chapter; merge them:\n\n${pieceSummaries.join('\n\n')}`,
    temperature: 0.3,
  });
  return merged.trim();
};

export async function summarizeChapter(
  args: SummaryArgs & { sectionIndex: number },
): Promise<string> {
  getModelOrThrow(args.aiSettings); // fail fast before any I/O
  const text = await sectionText(args.bookDoc, args.sectionIndex);
  if (!text) throw new Error('CHAPTER_UNREADABLE');
  const contentHash = hashContent(text);
  const cached = await aiStore.getChapterSummary(args.bookHash, args.sectionIndex);
  if (cached && cached.contentHash === contentHash) return cached.summary;

  const summary = await summarizeText(args, chapterTitleOf(args.bookDoc, args.sectionIndex), text);
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
}

export async function recapToPosition(
  args: SummaryArgs & { currentSectionIndex: number },
): Promise<string> {
  const model = getModelOrThrow(args.aiSettings);
  const parts: string[] = [];
  for (let i = 0; i < args.currentSectionIndex; i++) {
    try {
      const summary = await summarizeChapter({ ...args, sectionIndex: i });
      parts.push(`${chapterTitleOf(args.bookDoc, i)}:\n${summary}`);
    } catch (e) {
      if ((e as Error).message === 'AI_NOT_CONFIGURED') throw e;
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
