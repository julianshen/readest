import { describe, expect, test } from 'vitest';
import { createDailyStatsRecorder, computeStreak, normalizeMap, todayKey } from '@/services/stats/dailyStats';

// Fixed "today": 2026-08-24 local noon.
const NOW = new Date(2026, 7, 24, 12, 0, 0).getTime();

describe('todayKey', () => {
  test('formats local calendar date as YYYY-MM-DD', () => {
    expect(todayKey(NOW)).toBe('2026-08-24');
  });
});

describe('computeStreak', () => {
  test('counts consecutive days ending today', () => {
    const map = { '2026-08-22': 300, '2026-08-23': 120, '2026-08-24': 60 };
    expect(computeStreak(map, NOW)).toMatchObject({ days: 3, minutesToday: 1 });
  });
  test('streak survives when today has no time yet (ends yesterday)', () => {
    const gapped = { '2026-08-21': 300, '2026-08-23': 120 };
    const contiguous = { '2026-08-22': 300, '2026-08-23': 120 };
    expect(computeStreak(gapped, NOW)).toMatchObject({ days: 1 }); // Aug 23 counts, gap at Aug 22 stops the walk-back
    expect(computeStreak(contiguous, NOW)).toMatchObject({ days: 2 });
  });
  test('days under 60s do not count', () => {
    const map = { '2026-08-23': 59, '2026-08-24': 61 };
    expect(computeStreak(map, NOW)).toMatchObject({ days: 1, minutesToday: 1 });
  });
  test('week array is oldest-first with index 6 = today', () => {
    const map = { '2026-08-18': 600, '2026-08-24': 300 };
    const s = computeStreak(map, NOW);
    expect(s.week[6]).toBe(5); // today: 300s = 5 min
    expect(s.week[0]).toBe(10); // six days back: 600s = 10 min
    expect(s.week.slice(1, 6)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('normalizeMap', () => {
  test('drops entries older than 60 days', () => {
    const map = { '2026-06-01': 999, '2026-08-24': 100 };
    const out = normalizeMap(map, NOW);
    expect(out).toEqual({ '2026-08-24': 100 });
  });
});
