import type { BookDoc } from '@/libs/document';
import { getPrimaryLanguage } from '@/utils/book';
import { getLanguageName } from '@/utils/lang';

export type AnswerLanguageMode = 'book' | 'app';

// The book's primary language as a human-readable English name (e.g. "Japanese").
export const bookLanguageName = (bookDoc: BookDoc): string =>
  getLanguageName(getPrimaryLanguage(bookDoc.metadata.language));

// Resolve the answer language name from the user's setting. `book` (and the
// undefined default) use the book's language; `app` uses the UI locale.
export const resolveAnswerLanguageName = (
  mode: AnswerLanguageMode | undefined,
  bookDoc: BookDoc,
  uiLangCode: string,
): string => (mode === 'app' ? getLanguageName(uiLangCode) : bookLanguageName(bookDoc));
