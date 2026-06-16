import { Book } from '@/types/book';
import { isSameLang } from '@/utils/lang';
import { getLocale } from '@/utils/misc';

const DAILY_USAGE_KEY = 'translationDailyUsage';

export const saveDailyUsage = (usage: number, date?: string) => {
  if (typeof window !== 'undefined') {
    const isoDate = date || new Date().toISOString().split('T')[0]!;
    const dailyUsage = { [isoDate]: usage };
    localStorage.setItem(DAILY_USAGE_KEY, JSON.stringify(dailyUsage));
  }
};

export const getDailyUsage = (date?: string): number | null => {
  if (typeof window !== 'undefined') {
    const isoDate = date || new Date().toISOString().split('T')[0]!;
    const usage = localStorage.getItem(DAILY_USAGE_KEY);
    if (usage) {
      const dailyUsage = JSON.parse(usage);
      if (dailyUsage[isoDate]) {
        return dailyUsage[isoDate];
      }
    }
  }
  return null;
};

// Why inline translation can't run for this book + target. `same-language` is
// the soft case the UI surfaces as a hint (the target equals the book's own
// language, so every paragraph would translate to itself); the rest are hard
// "not supported here" reasons.
export type TranslationUnavailableReason = 'no-book' | 'pdf' | 'no-language' | 'same-language';

export const getTranslationUnavailableReason = (
  book?: Book | null,
  targetLanguage?: string | null,
): TranslationUnavailableReason | null => {
  if (!book) return 'no-book';
  if (book.format === 'PDF') return 'pdf';

  const primaryLanguage = book.primaryLanguage || '';
  if (!primaryLanguage || primaryLanguage.toLowerCase() === 'und') return 'no-language';

  // Target falls back to the app locale when no explicit target is set —
  // mirror useTextTranslation's `translateTargetLang || getLocale()`.
  const effectiveTarget = targetLanguage || getLocale();
  if (isSameLang(primaryLanguage, effectiveTarget)) return 'same-language';

  return null;
};

export const isTranslationAvailable = (book?: Book | null, targetLanguage?: string | null) =>
  getTranslationUnavailableReason(book, targetLanguage) === null;
