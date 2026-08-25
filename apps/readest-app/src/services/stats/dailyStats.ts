import { safeLoadJSON, safeSaveJSON } from '@/services/persistence';
import type { FileSystem } from '@/types/system';

export type DailyStatsMap = Record<string, number>; // 'YYYY-MM-DD' -> active seconds

const DAY_MS = 86_400_000;
const MIN_DAY_SECONDS = 60; // minimum reading for a day to count toward streak
const RETENTION_DAYS = 60;

/** Local calendar date key for a timestamp. */
export function todayKey(ts: number): string {
  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function dayKeyOffset(now: number, offsetDays: number): string {
  // Noon-based arithmetic stays on the same local date across DST shifts.
  return todayKey(now - offsetDays * DAY_MS);
}

export interface StreakInfo {
  days: number;
  minutesToday: number;
  /** Minutes per day, oldest first; week[6] === today. */
  week: number[];
}

export function computeStreak(map: DailyStatsMap, now: number): StreakInfo {
  const today = todayKey(now);
  const minutesToday = Math.floor((map[today] ?? 0) / 60);

  let days = 0;
  let cursor = (map[today] ?? 0) >= MIN_DAY_SECONDS ? 0 : 1;
  while ((map[dayKeyOffset(now, cursor)] ?? 0) >= MIN_DAY_SECONDS) {
    days += 1;
    cursor += 1;
  }

  const week: number[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    week.push(Math.floor((map[dayKeyOffset(now, i)] ?? 0) / 60));
  }
  return { days, minutesToday, week };
}

export function normalizeMap(map: DailyStatsMap, now: number): DailyStatsMap {
  const cutoff = now - RETENTION_DAYS * DAY_MS;
  const out: DailyStatsMap = {};
  for (const [key, seconds] of Object.entries(map)) {
    const ts = new Date(`${key}T12:00:00`).getTime();
    if (!Number.isNaN(ts) && ts >= cutoff && seconds > 0) out[key] = seconds;
  }
  return out;
}

const STATS_FILENAME = 'daily-reading-stats.json';
const FLUSH_THRESHOLD_SEC = 30;

export interface DailyStatsRecorder {
  recordTick(nowTs: number, seconds: number): void;
  getMap(): DailyStatsMap;
  flush(): Promise<void>;
  load(): Promise<void>;
}

/**
 * Device-local daily reading-time accumulator. Persists to the Data base dir
 * (not Settings) so it never rides along with cloud settings sync.
 */
export function createDailyStatsRecorder(fs: FileSystem): DailyStatsRecorder {
  let map: DailyStatsMap = {};
  let pending = 0;

  return {
    getMap: () => map,
    async load() {
      map = normalizeMap(
        await safeLoadJSON<DailyStatsMap>(fs, STATS_FILENAME, 'Data', {}),
        Date.now(),
      );
    },
    recordTick(nowTs, seconds) {
      const key = todayKey(nowTs);
      map[key] = (map[key] ?? 0) + seconds;
      pending += seconds;
      if (pending >= FLUSH_THRESHOLD_SEC) pending = 0; // caller flushes async
    },
    async flush() {
      await safeSaveJSON(fs, STATS_FILENAME, 'Data', normalizeMap(map, Date.now()));
    },
  };
}
