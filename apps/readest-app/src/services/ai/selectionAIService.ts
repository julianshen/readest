import { streamText } from 'ai';
import type { LanguageModel } from 'ai';
import type { BookDoc } from '@/libs/document';
import type { AISettings } from './types';
import { getAIProvider } from './providers';
import { extractTextFromDocument } from './utils/chunker';
import { buildSelectionContext } from './utils/selectionContext';
import { buildExplainPrompt, buildDefinePrompt, buildSimplifyPrompt } from './prompts';
import { bookLanguageName, resolveAnswerLanguageName } from './answerLanguage';

export type SelectionAction = 'explain' | 'simplify' | 'define';

export const SelectionErrorCodes = {
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
} as const;

// ≈750 tokens of preceding context; enough to resolve local references without
// bloating the request.
const MAX_CONTEXT_CHARS = 3000;

export interface SelectionArgs {
  bookDoc: BookDoc;
  sectionIndex: number;
  selectedText: string;
  uiLanguage: string;
  aiSettings: AISettings;
}

const getModelOrThrow = (aiSettings: AISettings): LanguageModel => {
  try {
    return getAIProvider(aiSettings).getModel();
  } catch {
    throw new Error(SelectionErrorCodes.NOT_CONFIGURED);
  }
};

const sectionText = async (bookDoc: BookDoc, index: number): Promise<string> => {
  const section = bookDoc.sections?.[index];
  if (!section) return '';
  try {
    const doc = await section.createDocument();
    return extractTextFromDocument(doc);
  } catch {
    return '';
  }
};

const systemPromptFor = (action: SelectionAction, args: SelectionArgs): string => {
  const answerLang = resolveAnswerLanguageName(
    args.aiSettings.answerLanguage,
    args.bookDoc,
    args.uiLanguage,
  );
  switch (action) {
    case 'explain':
      return buildExplainPrompt(answerLang);
    case 'define':
      return buildDefinePrompt(answerLang);
    case 'simplify':
      return buildSimplifyPrompt(bookLanguageName(args.bookDoc));
  }
};

export async function* runSelectionAction(
  action: SelectionAction,
  args: SelectionArgs,
): AsyncIterable<string> {
  const model = getModelOrThrow(args.aiSettings); // fail fast before any I/O
  const text = await sectionText(args.bookDoc, args.sectionIndex);
  const context = buildSelectionContext(text, args.selectedText, MAX_CONTEXT_CHARS);
  const result = streamText({
    model,
    system: systemPromptFor(action, args),
    prompt: context,
    temperature: action === 'simplify' ? 0.3 : 0.4,
  });
  for await (const chunk of result.textStream) {
    yield chunk;
  }
}
