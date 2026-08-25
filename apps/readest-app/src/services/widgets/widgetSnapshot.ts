import { findNextInSeries } from '@/app/library/utils/libraryUtils';
import type { Book } from '@/types/book';

export type WidgetStyle = 'default' | 'eink';

export interface WidgetSnapshot {
  version: 1;
  publishedAt: number;
  style: WidgetStyle;
  continueReading: {
    hash: string;
    title: string;
    progressPct: number;
    chapterLabel: string;
    coverFile: string | null;
  } | null;
  streak: { days: number; minutesToday: number; week: number[] };
  nextInSeries: {
    series: string;
    finishedLabel: string;
    nextHash: string;
    nextLabel: string;
    coverFile: string | null;
  } | null;
}

export interface StreakInput {
  days: number;
  minutesToday: number;
  week: number[];
}

function pct(book: Book): number {
  if (!book.progress || book.progress[1] <= 0) return 0;
  return Math.min(99, Math.round((book.progress[0] / book.progress[1]) * 100));
}

/**
 * Pure snapshot builder for the home-screen widgets. Given the visible
 * library, streak info and the current style, produces everything the
 * native widget providers render — no I/O, fully unit-testable.
 */
export function buildWidgetSnapshot(
  library: Book[],
  streakInput: StreakInput,
  chapterLabel: string | null,
  style: WidgetStyle,
  now: number,
): WidgetSnapshot {
  const candidates = library.filter(
    (b) =>
      !b.deletedAt &&
      b.readingStatus === 'reading' &&
      b.progress &&
      b.progress[0] > 0 &&
      b.progress[0] < b.progress[1],
  );
  const current = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  // Most recently finished book that still has a successor in the library.
  const finished = library
    .filter((b) => !b.deletedAt && b.readingStatus === 'finished')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  let next: { book: Book; from: Book } | null = null;
  for (const book of finished) {
    const nxt = findNextInSeries(library, book);
    if (nxt) {
      next = { book: nxt, from: book };
      break;
    }
  }
  // Only advertise continuation while it's still relevant: nothing else
  // started reading since the volume was finished.
  const stale = !!(next && current && current.updatedAt > next.from.updatedAt);

  return {
    version: 1,
    publishedAt: now,
    style,
    continueReading: current
      ? {
          hash: current.hash,
          title: current.title,
          progressPct: pct(current),
          chapterLabel: chapterLabel ?? '',
          coverFile: `${current.hash}.png`,
        }
      : null,
    streak: streakInput,
    nextInSeries:
      next && !stale
        ? {
            series: next.from.metadata?.series?.trim() ?? '',
            finishedLabel: `${next.from.title} finished`,
            nextHash: next.book.hash,
            nextLabel: next.book.title,
            coverFile: `${next.book.hash}.png`,
          }
        : null,
  };
}
