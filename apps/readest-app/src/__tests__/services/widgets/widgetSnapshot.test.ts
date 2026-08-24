import { describe, expect, test } from 'vitest';
import { buildWidgetSnapshot } from '@/services/widgets/widgetSnapshot';
import type { Book } from '@/types/book';

const NOW = new Date(2026, 7, 24, 12, 0, 0).getTime();

function makeBook(p: Partial<Book> & { hash: string }): Book {
  return {
    title: p.hash,
    author: '',
    format: 'EPUB',
    createdAt: NOW,
    updatedAt: NOW,
    ...p,
  } as Book;
}

const streakInput = { days: 0, minutesToday: 0, week: [] };

describe('buildWidgetSnapshot', () => {
  test('continueReading picks most recently updated in-progress book', () => {
    const reading = makeBook({
      hash: 'a',
      title: 'Kafka',
      updatedAt: NOW - 1000,
      progress: [62, 100],
      readingStatus: 'reading',
    });
    const older = makeBook({
      hash: 'b',
      progress: [10, 100],
      readingStatus: 'reading',
      updatedAt: NOW - 9000,
    });
    const done = makeBook({
      hash: 'c',
      progress: [100, 100],
      readingStatus: 'finished',
      updatedAt: NOW,
    });
    const snap = buildWidgetSnapshot([done, older, reading], streakInput, null, 'default', NOW);
    expect(snap.continueReading?.hash).toBe('a');
    expect(snap.continueReading?.progressPct).toBe(62);
  });

  test('excludes finished/deleted books and books without progress', () => {
    const deleted = makeBook({ hash: 'd', progress: [5, 100], deletedAt: NOW });
    const fresh = makeBook({ hash: 'e' }); // never opened
    const snap = buildWidgetSnapshot([deleted, fresh], streakInput, null, 'default', NOW);
    expect(snap.continueReading).toBeNull();
  });

  test('nextInSeries surfaces next volume for recent finished comic', () => {
    const vol41 = makeBook({
      hash: 'v41',
      title: 'Vol. 41',
      readingStatus: 'finished',
      updatedAt: NOW - 500,
      metadata: { series: 'Berserk', seriesIndex: 41 } as Book['metadata'],
    });
    const vol42 = makeBook({
      hash: 'v42',
      title: 'Vol. 42',
      metadata: { series: 'Berserk', seriesIndex: 42 } as Book['metadata'],
    });
    const snap = buildWidgetSnapshot(
      [vol41, vol42],
      { days: 1, minutesToday: 5, week: [] },
      null,
      'default',
      NOW,
    );
    expect(snap.nextInSeries).toMatchObject({
      nextHash: 'v42',
      finishedLabel: 'Vol. 41 finished',
      coverFile: 'v42.png',
    });
  });

  test('nextInSeries suppressed when a different book was started after finishing', () => {
    const vol41 = makeBook({
      hash: 'v41',
      title: 'Vol. 41',
      readingStatus: 'finished',
      updatedAt: NOW - 5000,
      metadata: { series: 'Berserk', seriesIndex: 41 } as Book['metadata'],
    });
    const vol42 = makeBook({
      hash: 'v42',
      metadata: { series: 'Berserk', seriesIndex: 42 } as Book['metadata'],
    });
    const other = makeBook({
      hash: 'x',
      progress: [3, 100],
      readingStatus: 'reading',
      updatedAt: NOW - 100, // started AFTER the volume was finished
    });
    const snap = buildWidgetSnapshot([vol41, vol42, other], streakInput, null, 'default', NOW);
    expect(snap.nextInSeries).toBeNull();
    expect(snap.continueReading?.hash).toBe('x');
  });

  test('snapshot carries version, style and publishedAt', () => {
    const snap = buildWidgetSnapshot([], streakInput, null, 'eink', NOW);
    expect(snap).toMatchObject({
      version: 1,
      style: 'eink',
      publishedAt: NOW,
      continueReading: null,
      nextInSeries: null,
    });
  });
});
