# Home-Screen Reading Widgets Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three home-screen widgets (Continue Reading, Reading Streak, Next in Series) on Android and iOS, rendered from an app-published snapshot store.

**Architecture:** A frontend service builds a JSON snapshot from library/progress/streak data and publishes it through the existing `tauri-plugin-native-bridge` plugin to platform-native stores (SharedPreferences on Android, App Group on iOS). Native AppWidgetProviders / WidgetKit TimelineProviders render exclusively from that store, so widgets work when the app process is dead.

**Tech Stack:** TypeScript/React (Next.js), Tauri v2 custom plugin (Rust → Kotlin/Swift), Android AppWidget + RemoteViews, iOS WidgetKit + SwiftUI, vitest + JUnit4.

**Spec:** `docs/superpowers/specs/2026-08-24-home-screen-widgets-design.md`

---

## Implementer context

- Worktree: `/Users/julianshen/prj/readest-widget-spec`, branch `feat/home-screen-widgets-spec`. Do all work here.
- Monorepo commands run through pnpm. TS unit tests: `cd apps/readest-app && pnpm test`. Format/lint gate: `pnpm -C apps/readest-app format:check && pnpm -C apps/readest-app lint`.
- Pushing uses husky pre-push hooks; if they fail on environment-only issues (Node version), push with `--no-verify` and let CI verify.
- **Spec deviation adopted during planning:** instead of a separate "e-ink style widgets" toggle, the widget style derives from the existing `viewSettings.isEink` flag. One source of truth, zero extra UI. Update §4 of the spec accordingly in Task 0.
- Key verified facts you'll build on:
  - Plugin command pattern: Rust `#[command]` → `app.native_bridge().method()` → `self.0.run_mobile_plugin("cmd_name", payload)`; Kotlin `@Command fun cmdName(invoke: Invoke)`; register in `src/lib.rs` `generate_handler![]`.
  - Plugin Kotlin package is `com.readest.native_bridge`; the APP id is `com.jlnshen.reader`. Widget receiver classes live in the plugin module but are declared in the APP's manifest with fully-qualified names.
  - `Book` type: `apps/readest-app/src/types/book.ts` (`hash`, `title`, `coverImageUrl`, `progress?: [current, total]`, `readingStatus`, `updatedAt`, `metadata?.series`, `metadata?.seriesIndex`).
  - Library access: `useLibraryStore` (`getVisibleLibrary()`, `getBookByHash()`).
  - Series logic: `findNextInSeries(library, book)` at `src/app/library/utils/libraryUtils.ts:356`.
  - Persistence helper: `safeLoadJSON/safeSaveJSON(fs, filename, baseDir, data?)` in `src/services/persistence.ts`; `BaseDir` includes `'Data'`.
  - Deep links enter via `useAppUrlIngress` → `app-incoming-url` event → consumers (`useOpenAnnotationLink`). Only `readest://book/{hash}/annotation/{id}` is parsed today.
  - Reader hooks live in `src/app/reader/hooks/`; `useProgressAutoSave` shows the progress-reactive hook pattern.
  - Tests: vitest under `src/__tests__/services/…`; Kotlin JUnit4 under plugin's `android/src/test/java/`.

## File structure (what gets created where)

```
apps/readest-app/src/
  services/stats/dailyStats.ts                  # daily seconds map + streak calc
  services/widgets/widgetSnapshot.ts            # pure snapshot builder
  services/widgets/widgetService.ts             # publish pipeline (debounce/triggers)
  hooks/useReadingTimeTracker.ts                # active-seconds accumulator
  utils/deeplink.ts                             # MODIFY: book deep-link parsing
  hooks/useOpenAnnotationLink.ts                # MODIFY: handle bare book links
  __tests__/services/stats/dailyStats.test.ts
  __tests__/services/widgets/widgetSnapshot.test.ts
  __tests__/utils/deeplink.test.ts              # MODIFY: add book-link cases

apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/
  src/commands.rs                               # MODIFY: update_reading_widgets cmd
  src/mobile.rs                                 # MODIFY: NativeBridge method
  src/lib.rs                                    # MODIFY: handler registration
  android/src/main/java/ReadingWidgetStore.kt   # NEW: persistence + covers
  android/src/main/java/ReadingWidgetProviders.kt # NEW: 3 AppWidgetProviders
  android/src/main/res/layout/widget_continue_reading.xml
  android/src/main/res/layout/widget_streak.xml
  android/src/main/res/layout/widget_next_in_series.xml
  android/src/main/res/drawable/w_*             # NEW: icons/bars/backgrounds
  android/src/main/res/xml/widget_*_info.xml    # NEW: 3 AppWidgetProviderInfo
  android/src/test/java/ReadingWidgetStoreTest.kt # NEW

apps/readest-app/src-tauri/gen/android/app/src/main/AndroidManifest.xml  # MODIFY: receivers

apps/readest-app/src-tauri/gen/apple/
  project.yml                                   # MODIFY: ReadestWidgets target
  ReadestWidgets/{IntentHandler not needed}     # NEW target dir:
    ReadestWidgetsBundle.swift
    ContinueReadingWidget.swift
    StreakWidget.swift
    NextInSeriesWidget.swift
    WidgetSnapshotStore.swift                   # reads App Group store
    Info.plist, ReadestWidgets.entitlements
  Readest_iOS/Readest_iOS.entitlements          # MODIFY: (already has group)
```

---

## Chunk 1: Daily stats recorder + snapshot builder (TypeScript)

### Task 0: Spec sync

- [ ] **Step 1: Amend spec §4** to state the widget e-ink style derives from `viewSettings.isEink` (no separate toggle), and amend **§6** persistence wording to "device-local JSON file in the Data base dir via safeSaveJSON" (NOT the cloud-synced settings store). Commit:
```bash
git add docs/superpowers/specs/
git commit -m "docs: widget e-ink style follows app e-ink mode"
```

### Task 1: Daily stats core (types, streak math)

**Files:**
- Create: `apps/readest-app/src/services/stats/dailyStats.ts`
- Test: `apps/readest-app/src/__tests__/services/stats/dailyStats.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/services/stats/dailyStats.test.ts
import { describe, expect, test } from 'vitest';
import {
  todayKey, computeStreak, normalizeMap,
} from '@/services/stats/dailyStats';

const DAY = 86_400_000;
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
    expect(computeStreak(gapped, NOW)).toMatchObject({ days: 1 });     // Aug 23 counts, gap at Aug 22 stops the walk-back
    expect(computeStreak(contiguous, NOW)).toMatchObject({ days: 2 });
  });
  test('days under 60s do not count', () => {
    const map = { '2026-08-23': 59, '2026-08-24': 61 };
    expect(computeStreak(map, NOW)).toMatchObject({ days: 1, minutesToday: 1 });
  });
  test('week array is oldest-first with index 6 = today', () => {
    const map = { '2026-08-18': 600, '2026-08-24': 300 };
    const s = computeStreak(map, NOW);
    expect(s.week[6]).toBe(5);   // today: 300s = 5 min
    expect(s.week[0]).toBe(10);  // six days back: 600s = 10 min
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
```

- [ ] **Step 2: Run to verify failure**
Run: `cd apps/readest-app && pnpm test -- src/__tests__/services/stats/dailyStats.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement dailyStats.ts**

```typescript
// services/stats/dailyStats.ts
export type DailyStatsMap = Record<string, number>; // 'YYYY-MM-DD' -> active seconds

const DAY_MS = 86_400_000;
const MIN_DAY_SECONDS = 60;      // minimum reading for a day to count toward streak
const RETENTION_DAYS = 60;

/** Local calendar date key for a timestamp. */
export function todayKey(ts: number): string {
  const d = new Date(ts);
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function dayKeyOffset(now: number, offsetDays: number): string {
  // Noon-based to stay on the same local date across DST shifts.
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
  // Walk backwards from today (or yesterday if today doesn't count yet).
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
```

- [ ] **Step 4: Run tests — expect PASS** (same command as Step 2).
- [ ] **Step 5: Commit**
```bash
git add apps/readest-app/src/services/stats apps/readest-app/src/__tests__/services/stats
git commit -m "feat(stats): daily reading-time map with streak computation"
```

### Task 2: Stats persistence + recorder API

**Files:**
- Modify: `apps/readest-app/src/services/stats/dailyStats.ts`
- Modify: `apps/readest-app/src/__tests__/services/stats/dailyStats.test.ts`

- [ ] **Step 1: Add failing tests** for the recorder (append):

```typescript
import { createDailyStatsRecorder } from '@/services/stats/dailyStats';
import type { FileSystem } from '@/types/system';

function makeFs(store: Record<string, string>) {
  return {
    writeFile: async (p: string, _b: unknown, data: string) => { store[p] = data; },
    readFile: async (p: string) => {
      if (!(p in store)) throw new Error('missing');
      return store[p];
    },
  } as unknown as FileSystem;
}

describe('createDailyStatsRecorder', () => {
  test('accumulates ticks, flushes at 30s, and persists normalized map', async () => {
    const store: Record<string, string> = {};
    const fs = makeFs(store);
    const rec = createDailyStatsRecorder(fs);
    rec.recordTick(NOW, 29);
    expect(Object.keys(store)).toHaveLength(0); // below flush threshold
    rec.recordTick(NOW, 2);                     // crosses 30s → flush
    await rec.flush();
    const saved = JSON.parse(store['daily-reading-stats.json']);
    expect(saved['2026-08-24']).toBe(31);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`createDailyStatsRecorder` not exported).
- [ ] **Step 3: Implement** (append to `dailyStats.ts`):

```typescript
import { safeLoadJSON, safeSaveJSON } from '@/services/persistence';
import type { FileSystem } from '@/types/system';

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
```

Note: the recorder instance is created once by `widgetService` (Chunk 2) and shared with the reader hook via module-level singleton export there — keep this module framework-free.

- [ ] **Step 4: Run — PASS. Commit:**
```bash
git commit -am "feat(stats): persist daily stats recorder"   # modifies tracked files only
```

---

## Chunk 2: Snapshot builder + deep links

### Task 3: Widget snapshot builder (pure)

**Files:**
- Create: `apps/readest-app/src/services/widgets/widgetSnapshot.ts`
- Test: `apps/readest-app/src/__tests__/services/widgets/widgetSnapshot.test.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { describe, expect, test } from 'vitest';
import { buildWidgetSnapshot } from '@/services/widgets/widgetSnapshot';
import type { Book } from '@/types/book';

const NOW = new Date(2026, 7, 24, 12, 0, 0).getTime();

function makeBook(p: Partial<Book> & { hash: string }): Book {
  return {
    title: p.hash, author: '', format: 'EPUB', createdAt: NOW, updatedAt: NOW,
    ...p,
  } as Book;
}

describe('buildWidgetSnapshot', () => {
  const reading = makeBook({
    hash: 'a', title: 'Kafka', updatedAt: NOW - 1000,
    progress: [62, 100], readingStatus: 'reading',
  });

  test('continueReading picks most recently updated in-progress book', () => {
    const older = makeBook({ hash: 'b', progress: [10, 100], readingStatus: 'reading', updatedAt: NOW - 9000 });
    const done = makeBook({ hash: 'c', progress: [100, 100], readingStatus: 'finished', updatedAt: NOW });
    const snap = buildWidgetSnapshot([done, older, reading], { streak: { days: 12, minutesToday: 43, week: [] } }, null, 'default', NOW);
    expect(snap.continueReading?.hash).toBe('a');
    expect(snap.continueReading?.progressPct).toBe(62);
  });

  test('excludes finished/deleted books and books without progress', () => {
    const deleted = makeBook({ hash: 'd', progress: [5, 100], deletedAt: NOW });
    const fresh = makeBook({ hash: 'e' }); // never opened
    const snap = buildWidgetSnapshot([deleted, fresh], { streak: { days: 0, minutesToday: 0, week: [] } }, null, 'default', NOW);
    expect(snap.continueReading).toBeNull();
  });

  test('nextInSeries surfaces next volume for recent finished comic', () => {
    const vol41 = makeBook({
      hash: 'v41', title: 'Vol. 41', readingStatus: 'finished',
      updatedAt: NOW - 500, metadata: { series: 'Berserk', seriesIndex: 41 } as Book['metadata'],
    });
    const vol42 = makeBook({
      hash: 'v42', title: 'Vol. 42',
      metadata: { series: 'Berserk', seriesIndex: 42 } as Book['metadata'],
    });
    const snap = buildWidgetSnapshot([vol41, vol42], { streak: { days: 1, minutesToday: 5, week: [] } }, null, 'default', NOW);
    expect(snap.nextInSeries).toMatchObject({ nextHash: 'v42', finishedLabel: 'Vol. 41 finished' });
  });

  test('snapshot carries version, style and publishedAt', () => {
    const snap = buildWidgetSnapshot([], { streak: { days: 0, minutesToday: 0, week: [] } }, null, 'eink', NOW);
    expect(snap).toMatchObject({ version: 1, style: 'eink', publishedAt: NOW, continueReading: null, nextInSeries: null });
  });
});
```

- [ ] **Step 2: Run — FAIL. Step 3: implement:**

```typescript
// services/widgets/widgetSnapshot.ts
import { findNextInSeries } from '@/app/library/utils/libraryUtils';
import type { Book } from '@/types/book';

export type WidgetStyle = 'default' | 'eink';

export interface WidgetSnapshot {
  version: 1;
  publishedAt: number;
  style: WidgetStyle;
  continueReading: {
    hash: string; title: string; progressPct: number;
    chapterLabel: string; coverFile: string | null;
  } | null;
  streak: { days: number; minutesToday: number; week: number[] };
  nextInSeries: {
    series: string; finishedLabel: string;
    nextHash: string; nextLabel: string; coverFile: string | null;
  } | null;
}

export interface StreakInput { days: number; minutesToday: number; week: number[] }

function pct(book: Book): number {
  if (!book.progress || book.progress[1] <= 0) return 0;
  return Math.min(99, Math.round((book.progress[0] / book.progress[1]) * 100));
}

export function buildWidgetSnapshot(
  library: Book[],
  streakInput: StreakInput,
  chapterLabel: string | null,
  style: WidgetStyle,
  now: number,
): WidgetSnapshot {
  const candidates = library.filter(
    (b) => !b.deletedAt && b.readingStatus === 'reading'
      && b.progress && b.progress[0] > 0 && b.progress[0] < b.progress[1],
  );
  const current = candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  // Most recently finished book that still has a successor in the library.
  const finished = library
    .filter((b) => !b.deletedAt && b.readingStatus === 'finished')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  let next: { book: Book; from: Book } | null = null;
  for (const book of finished) {
    const nxt = findNextInSeries(library, book);
    if (nxt) { next = { book: nxt, from: book }; break; }
  }
  // Only advertise continuation while it's still relevant: nothing else
  // started reading since the volume was finished.
  const stale = next && current && current.updatedAt > next.from.updatedAt;

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
    nextInSeries: next && !stale
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
```

- [ ] **Step 4: Run — PASS. Step 5: Commit (stage the new files explicitly)**
```bash
git add apps/readest-app/src/services/widgets apps/readest-app/src/__tests__/services/widgets
git commit -m "feat(widgets): pure widget snapshot builder"
```

### Task 4: Book deep links

**Files:**
- Modify: `apps/readest-app/src/utils/deeplink.ts`
- Modify: `apps/readest-app/src/hooks/useOpenAnnotationLink.ts`
- Test: `apps/readest-app/src/__tests__/utils/deeplink.test.ts` (extend)

- [ ] **Step 1: Add failing parser tests** (append to existing deeplink test file):

```typescript
describe('parseBookDeepLink', () => {
  test('parses bare book link', () =>
    expect(parseBookDeepLink('readest://book/abc123')).toEqual({ bookHash: 'abc123' }));
  test('parses web-form book link', () =>
    expect(parseBookDeepLink('https://web.readest.com/o/book/abc123')).toEqual({ bookHash: 'abc123' }));
  test('returns null for annotation links (handled elsewhere)', () =>
    expect(parseBookDeepLink('readest://book/abc123/annotation/n1')).toBeNull());
  test('returns null for unrelated urls', () =>
    expect(parseBookDeepLink('readest://auth-callback')).toBeNull());
});
```

- [ ] **Step 2: Run — FAIL. Step 3: implement** in `deeplink.ts`:

```typescript
export type BookDeepLink = { bookHash: string };

/**
 * Bare book links (widget taps): readest://book/{hash} — without an
 * annotation segment, which parseAnnotationDeepLink owns.
 */
// NOTE: for custom schemes the WHATWG URL parser puts the first path segment
// into `host`: new URL('readest://book/abc123').host === 'book'. Reconstruct
// segments the same way parseAnnotationDeepLink does.
export const parseBookDeepLink = (url: string): BookDeepLink | null => {
  try {
    const parsed = new URL(url);
    const isApp = parsed.protocol === 'readest:';
    const isWeb =
      parsed.protocol.startsWith('http') &&
      parsed.hostname === 'web.readest.com' &&
      parsed.pathname.startsWith('/o/book/');
    if (!isApp && !isWeb) return null;
    const segments = isApp
      ? [parsed.host, ...parsed.pathname.split('/').filter(Boolean)]   // ['book', hash]
      : parsed.pathname.split('/').filter(Boolean);                    // ['o', 'book', hash]
    if (segments.includes('annotation')) return null;                  // annotation links are owned by parseAnnotationDeepLink
    const hash = isApp ? segments[1] : segments[2];
    if (!hash) return null;
    return { bookHash: decodeURIComponent(hash) };
  } catch {
    return null;
  }
};
```

- [ ] **Step 4: Wire into `useOpenAnnotationLink.ts`:** at the top of its URL-handling callback, branch before annotation parsing:

```typescript
import { parseAnnotationDeepLink, parseBookDeepLink } from '@/utils/deeplink';

// inside the handler that currently calls parseAnnotationDeepLink(url):
const bookLink = parseBookDeepLink(url);
if (bookLink) {
  // Mirror how useOpenAnnotationLink already opens books: getBookByHash + navigateToReader.
  // (openBook from useBooksManager is a reader-context hook and is NOT available here.)
  navigateToReader(router, [bookLink.bookHash]);
  return;
}
```
The branch must run before `parseAnnotationDeepLink` returns null.

- [ ] **Step 5: Run tests + lint — PASS. Step 6: Commit**
```bash
git commit -am "feat(deeplinks): support bare readest://book/{hash} links"
```

---

## Chunk 3: Publisher service + reader time tracking

### Task 5: widgetService (publish pipeline)

**Files:**
- Create: `apps/readest-app/src/services/widgets/widgetService.ts`

No dedicated unit test (thin orchestration over tested units); behavior is covered by device verification in Chunk 6.

- [ ] **Step 1: Implement**

```typescript
// services/widgets/widgetService.ts
import type { FileSystem } from '@/types/system';
import { invoke, isTauriAppPlatform } from '@/utils/environment'; // match repo's existing invoke import style
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';       // adjust to actual settings store selector used by ControlPanel
import {
  createDailyStatsRecorder, computeStreak, type DailyStatsRecorder,
} from '@/services/stats/dailyStats';
import { buildWidgetSnapshot, type WidgetSnapshot } from './widgetSnapshot';

let fsRef: FileSystem | null = null;
let recorder: DailyStatsRecorder | null = null;
let lastPublish = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Progress events throttle: at most one publish/minute from page turns. */
const PROGRESS_THROTTLE_MS = 60_000;
const DEBOUNCE_MS = 5_000;

async function publishNow(chapterLabel: string | null = null) {
  if (!recorder || !isTauriAppPlatform()) return;
  const library = useLibraryStore.getState().getVisibleLibrary();
  const isEink = !!useSettingsStore.getState().settings.viewSettings?.isEink;
  const now = Date.now();
  const snapshot: WidgetSnapshot = buildWidgetSnapshot(
    library,
    computeStreak(recorder.getMap(), now),
    chapterLabel,
    isEink ? 'eink' : 'default',
    now,
  );
  await invoke('update_reading_widgets', { payload: { snapshot: JSON.stringify(snapshot), covers } });
  lastPublish = now;
}
```
**Arg shape matters:** repo convention passes `{ payload: request }` because the command parameter is named `payload` (see `nativeAuth.ts` / `bridge.ts`). `covers` is built in Task 10 — declare it now, send `{}` until then:

```typescript
const covers: Record<string, string> = {}; // populated in Task 10

/** Debounced + throttled entry point. force bypasses the throttle only for non-progress triggers. */
export function requestWidgetPublish(opts: { force?: boolean; chapterLabel?: string | null } = {}) {
  if (!recorder) return;
  const since = Date.now() - lastPublish;
  if (!opts.force && since < PROGRESS_THROTTLE_MS) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void publishNow(opts.chapterLabel ?? null); }, DEBOUNCE_MS);
}

/** Call once from LibraryPage init (where envConfig/fs first exists). */
export async function initWidgetService(fs: FileSystem) {
  if (!isTauriAppPlatform()) return;   // skip on web
  fsRef = fs;
  recorder = createDailyStatsRecorder(fs);
  await recorder.load();
  // Re-publish on library mutations (add/delete/finish).
  useLibraryStore.subscribe(() => requestWidgetPublish({ force: true }));
  // Day rollover: check every publish-worthy event + on visibility regain.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void recorder?.flush();
    else requestWidgetPublish({ force: true });
  });
  requestWidgetPublish({ force: true });
}

export function getDailyStatsRecorder(): DailyStatsRecorder | null {
  return recorder ?? (fsRef ? (recorder = createDailyStatsRecorder(fsRef)) : null);
}
```

Notes for implementer: match the repo's real import paths for `invoke`/stores (grep how other services call `invoke` and which settings store exposes `viewSettings`; `ControlPanel.tsx` reads it via a settings store — mirror that). Keep the module singleton semantics exactly.

- [ ] **Step 2: Init call.** In `src/app/library/page.tsx` where `envConfig`/fs is first available (same place other services init), call `void initWidgetService(fs)`. Grep for an existing "init services" effect to co-locate.
- [ ] **Step 3: Lint passes. Commit (stage new file explicitly — `-a` would miss it):**
```bash
git add apps/readest-app/src/services/widgets/widgetService.ts
git add -u   # library/page.tsx init call
git commit -m "feat(widgets): snapshot publish pipeline via native bridge"
```

### Task 6: Reader active-time tracker

**Files:**
- Create: `apps/readest-app/src/hooks/useReadingTimeTracker.ts`
- Modify: `apps/readest-app/src/app/reader/FoliateViewer.tsx` (mount hook alongside `useProgressAutoSave`)

- [ ] **Step 1: Implement hook** (pattern mirrors `useProgressAutoSave`):

```typescript
// hooks/useReadingTimeTracker.ts
import { useEffect } from 'react';
import { getDailyStatsRecorder, requestWidgetPublish } from '@/services/widgets/widgetService';

const TICK_SEC = 5;
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Accumulates ACTIVE reading seconds (reader mounted, tab visible, user not
 * idle beyond IDLE_TIMEOUT_MS) into the daily stats recorder. Flushes on
 * unmount (book close) so ≤5s of data is ever lost.
 */
export const useReadingTimeTracker = (bookKey: string) => {
  useEffect(() => {
    const recorder = getDailyStatsRecorder();
    if (!recorder) return;

    let idle = false;
    let accumulated = 0;
    const bumpIdle = () => { idle = false; };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bumpIdle, { passive: true }));
    const idleTimer = setInterval(() => { idle = true; }, IDLE_TIMEOUT_MS);

    const tick = setInterval(() => {
      if (idle || document.visibilityState !== 'visible') return;
      recorder.recordTick(Date.now(), TICK_SEC);
      accumulated += TICK_SEC;
      if (accumulated % 30 === 0) void recorder.flush();
    }, TICK_SEC * 1000);

    // Publish streak changes at most once per minute of reading.
    const publishTick = setInterval(() => requestWidgetPublish(), 60_000);

    return () => {
      clearInterval(tick); clearInterval(idleTimer); clearInterval(publishTick);
      events.forEach((e) => window.removeEventListener(e, bumpIdle));
      void recorder.flush();
    };
  }, [bookKey]);
};
```

- [ ] **Step 2: Mount** in the same component that mounts `useProgressAutoSave` (**that's `FoliateViewer.tsx`, not reader/page.tsx**) — `useReadingTimeTracker(bookKey)` alongside it.
- [ ] **Step 3:** `pnpm -C apps/readest-app lint` — PASS. **Commit (explicit add):**
```bash
git add src/hooks/useReadingTimeTracker.ts && git add -u
git commit -am "feat(reader): track active daily reading time for widgets"
```

---

## Chunk 4: Rust command + Android providers

### Task 7: Rust plumbing (payload includes covers from the start)

**Files:**
- Modify: `apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/src/models.rs` (payload structs live here, NOT commands.rs — that file has no serde imports)
- Modify: `apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/src/commands.rs`
- Modify: `apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/src/mobile.rs`
- Modify: `apps/readest-app/src-tauri/plugins/tauri-plugin-native-bridge/src/lib.rs`

- [ ] **Step 1: models.rs** — append following the existing payload-struct convention (`use serde::{Deserialize, Serialize}` already present):

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetUpdateRequest {
    pub snapshot: String,
    /// {bookHash: base64 PNG} — covers referenced by the snapshot.
    #[serde(default)]
    pub covers: std::collections::HashMap<String, String>,
}
```

- [ ] **Step 2: commands.rs command body** — append following the `auth_with_custom_tab` example:

```rust
#[command]
pub(crate) async fn update_reading_widgets<R: Runtime>(
    app: AppHandle<R>,
    payload: WidgetUpdateRequest,
) -> Result<()> {
    app.native_bridge().update_reading_widgets(payload)
}
```

- [ ] **Step 3: mobile.rs** — add method to the `NativeBridge` impl (next to `auth_with_safari`):

```rust
pub fn update_reading_widgets(&self, payload: super::models::WidgetUpdateRequest) -> crate::Result<()> {
    self.0.run_mobile_plugin("update_reading_widgets", payload).map_err(Into::into)
}
```

- [ ] **Step 4: lib.rs** — add `commands::update_reading_widgets` into `generate_handler![…]`.
- [ ] **Step 5: Verify compile:** `cd apps/readest-app/src-tauri && cargo check` — PASS.
- [ ] **Step 6: Commit**
```bash
git commit -am "feat(native-bridge): update_reading_widgets command plumbing"
```

### Task 8: Kotlin store

**Files:**
- Create: `plugins/tauri-plugin-native-bridge/android/src/main/java/ReadingWidgetStore.kt`
- Test: `android/src/test/java/ReadingWidgetStoreTest.kt`

- [ ] **Step 1: Failing Kotlin test** (JUnit4, pattern of `OAuthPendingRequestTest`):

```kotlin
@Test
class ReadingWidgetStoreTest {
    @Test
    fun parseSnapshot_preservesFields() {
        val snap = ReadingWidgetStore.parseSnapshot("""{"version":1,"style":"eink","continueReading":{"hash":"h"}}""")
        assertEquals("eink", snap?.style)
        assertEquals("h", snap?.continueReading?.optString("hash"))
    }
    @Test
    fun corruptJson_treatedAsAbsent() {
        assertNull(ReadingWidgetStore.parseSnapshot("{not json"))
    }
}
```
Scope Kotlin tests to pure JSON parsing helpers (no Android Context) — the plugin module has no Robolectric dependency and none should be added.

- [ ] **Step 2: Implement store:**

```kotlin
package com.readest.native_bridge

import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import org.json.JSONObject
import java.io.File

data class ReadingWidgetSnapshot(val json: JSONObject) {
    val style: String get() = json.optString("style", "default")
    val continueReading: JSONObject? get() = json.optJSONObject("continueReading")
    val streak: JSONObject? get() = json.optJSONObject("streak")
    val nextInSeries: JSONObject? get() = json.optJSONObject("nextInSeries")
}

/**
 * Dumb persistence for widget snapshots: JSON in SharedPreferences, covers as
 * PNGs in cacheDir/widget-covers/. Providers read-only.
 */
class ReadingWidgetStore private constructor(private val prefs: SharedPreferences, private val coverDir: File) {

    var snapshot: ReadingWidgetSnapshot? = null
        private set

    fun reload() {
        snapshot = parseSnapshot(prefs.getString(KEY_SNAPSHOT, null))
    }

    /** Returns the cover bitmap for a hash, or null if missing/corrupt (provider falls back to letter-cover). */
    fun loadCover(hash: String): Bitmap? =
        BitmapFactory.decodeFile(File(coverDir, "$hash.png").absolutePath)

    companion object {
        private const val PREFS_NAME = "reading_widgets"
        private const val KEY_SNAPSHOT = "snapshot"

        /** Pure JSON parsing — Context-free so unit tests can exercise it directly. */
        fun parseSnapshot(raw: String?): ReadingWidgetSnapshot? =
            raw?.let { runCatching { ReadingWidgetSnapshot(JSONObject(it)) }.getOrNull() }

        fun from(context: Context): ReadingWidgetStore =
            ReadingWidgetStore(
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
                File(context.cacheDir, "widget-covers").apply { mkdirs() },
            )

        /** Called from NativeBridgePlugin command: writes JSON + decodes base64 covers. */
        fun write(context: Context, snapshotJson: String, covers: Map<String, ByteArray>) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val dir = File(context.cacheDir, "widget-covers").apply { mkdirs() }
            covers.forEach { (hash, bytes) ->
                File(dir, "$hash.png").writeBytes(bytes)
            }
            prefs.edit().putString(KEY_SNAPSHOT, snapshotJson).commit()
        }
    }
}
```

- [ ] **Step 3: Run Kotlin tests:** there is no gradlew in the plugin module and no CI lane runs Kotlin unit tests today — run them best-effort via Android Studio / a locally generated wrapper, and treat the CI **compile** (nightly android leg) as the real gate. PASS.
- [ ] **Step 4: Commit (new file — explicit add)**
```bash
git add plugins/tauri-plugin-native-bridge/android/src/main/java/ReadingWidgetStore.kt \
        plugins/tauri-plugin-native-bridge/android/src/test/java/ReadingWidgetStoreTest.kt
git commit -m "feat(native-bridge): android reading widget store"
```

### Task 9: Kotlin command + providers + layouts

**Files:**
- Modify: `plugins/tauri-plugin-native-bridge/android/src/main/java/NativeBridgePlugin.kt`
- Create: `plugins/tauri-plugin-native-bridge/android/src/main/java/ReadingWidgetProviders.kt`
- Create: `plugins/tauri-plugin-native-bridge/android/src/main/res/layout/widget_{continue_reading,streak,next_in_series}.xml`
- Create: `plugins/tauri-plugin-native-bridge/android/src/main/res/xml/widget_{continue_reading,streak,next_in_series}_info.xml`
- Create: drawable resources `w_progress_bar.xml`, `w_card_bg.xml`, `w_card_bg_eink.xml`, `w_next_pill.xml`
- Modify: `gen/android/app/src/main/AndroidManifest.xml` (receivers)

- [ ] **Step 1: Command in NativeBridgePlugin.kt** (follow `auth_with_custom_tab` shape):

```kotlin
@Command
fun update_reading_widgets(invoke: Invoke) {
    val args = invoke.parseArgs(WidgetUpdateArgs::class.java)
    // Covers arrive as {hash: base64}; decode and persist atomically, then fan out.
    val covers = args.covers.mapValues { Base64.decode(it.value, Base64.DEFAULT) }
    ReadingWidgetStore.write(activity.applicationContext, args.snapshot, covers)
    ReadingWidgetProviders.updateAll(activity.applicationContext)
    invoke.resolve(null)
}
class WidgetUpdateArgs(val snapshot: String, val covers: Map<String, String>)
```
Adjust the Rust payload to send `{ snapshot, covers }` accordingly (Task 7 step 1 gains a `covers` field; the frontend builds it — see Task 10 amendment below).

- [ ] **Step 2: Providers.** One receiver per widget, all reading `ReadingWidgetStore.from(context)`:

```kotlin
package com.readest.native_bridge

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.widget.RemoteViews

// R resolves to THIS module's own generated R class (namespace com.readest.native_bridge).
// Resources still merge into the app APK at build time; the import must stay plugin-local.

open class ReadingWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        updateWidgets(context, manager, ids)
    }
}

class ContinueReadingWidgetProvider : ReadingWidgetProvider()
class StreakWidgetProvider : ReadingWidgetProvider()
class NextInSeriesWidgetProvider : ReadingWidgetProvider()

object ReadingWidgetProviders {
    private val providers = listOf(
        ContinueReadingWidgetProvider::class.java,
        StreakWidgetProvider::class.java,
        NextInSeriesWidgetProvider::class.java,
    )

    fun updateAll(context: Context) {
        val manager = AppWidgetManager.getInstance(context)
        providers.forEach { cls ->
            val cn = ComponentName(context, cls)
            updateWidgets(context, manager, manager.getAppWidgetIds(cn))
        }
    }

    fun updateWidgets(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val store = ReadingWidgetStore.from(context).apply { reload() }
        ids.forEach { id ->
            val providerClass = manager.getAppWidgetInfo(id)?.provider?.className ?: return@forEach
            val views = when (providerClass) {
                ContinueReadingWidgetProvider::class.java.name -> continueReadingViews(context, store)
                StreakWidgetProvider::class.java.name -> streakViews(context, store)
                NextInSeriesWidgetProvider::class.java.name -> nextInSeriesViews(context, store)
                else -> null
            } ?: return@forEach
            manager.updateAppWidget(id, views)
        }
    }

    private fun continueReadingViews(ctx: Context, store: ReadingWidgetStore): RemoteViews {
        val eink = store.snapshot?.style == "eink"
        val views = RemoteViews(ctx.packageName, R.layout.widget_continue_reading)
        val book = store.snapshot?.continueReading
        if (book == null) {
            views.setTextViewText(R.id.w_title, ctx.getString(R.string.widget_empty_continue))
            views.setViewVisibility(R.id.w_progress, android.view.View.GONE)
            views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, null))
            return views
        }
        views.setTextViewText(R.id.w_title, book.optString("title"))
        views.setProgressBar(R.id.w_progress, 100, book.optInt("progressPct"), false)
        views.setTextViewText(R.id.w_pct, "${book.optInt("progressPct")}%")
        applyCoverOrLetter(views, R.id.w_cover, ctx, store, book.optString("coverFile"), book.optString("title"))
        views.setInt(R.id.w_root, "setBackgroundResource", if (eink) R.drawable.w_card_bg_eink else R.drawable.w_card_bg)
        views.setOnClickPendingIntent(R.id.w_root, deepLink(ctx, book.optString("hash")))
        return views
    }
    // streakViews / nextInSeriesViews follow identically from their layouts & snapshot fields.

    private fun deepLink(ctx: Context, hash: String?): PendingIntent {
        val uri = android.net.Uri.parse(if (hash.isNullOrBlank()) "readest://library" else "readest://book/$hash")
        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, uri).setPackage(ctx.packageName)
        return PendingIntent.getActivity(ctx, hash?.hashCode() ?: 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun applyCoverOrLetter(views: RemoteViews, viewId: Int, ctx: Context, store: ReadingWidgetStore, file: String?, title: String) {
        val bmp = file?.removeSuffix(".png")?.let { store.loadCover(it) }
        if (bmp != null) views.setImageViewBitmap(viewId, bmp)
        else views.setImageViewBitmap(viewId, letterCover(title)) // generated Bitmap: initial + flat tint    }
}
```
Implementer notes: add string resources `widget_empty_*`; generate `letterCover` with `Bitmap.createBitmap(96,144)` + `Canvas.drawText` (initial letter on a flat tint, no gradient); add an intent-filter data URI for `readest://library` (scheme already registered). `chapterLabel` is intentionally empty in v1 — no trigger populates it; the widget shows % only (spec §3.1 allows this).

- [ ] **Step 3: Layouts.** `widget_continue_reading.xml`: vertical LinearLayout — horizontal row (ImageView `w_cover` 44dp rounded via `R.drawable.w_cover_mask` outline clip, TextView `w_title` maxLines=2 ellipsize=end, TextView `w_pct`), ProgressBar `w_progress` (horizontal, `w_progress_bar` drawable: flat green fill on grey track; e-ink variant swaps fill to dark grey). `widget_streak.xml`: centered flame text 🔥 + big `w_streak_days` + `w_minutes_today` + 7 `View`s of fixed height bound to week values (set via `setViewVisibility` scaling or simple text fallback — v1 renders bars as seven 10dp squares toggled between filled/empty by comparing against week max). `widget_next_in_series.xml`: ImageView `w_cover`, `w_series`, `w_finished_label`, Button-styled TextView `w_next_pill` background `w_next_pill`.
- [ ] **Step 4: `xml/widget_continue_reading_info.xml`** (clone for the other two):
```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp" android:minHeight="110dp"
    android:targetCellWidth="2" android:targetCellHeight="2"
    android:resizeMode="horizontal|vertical"
    android:updatePeriodMillis="0"
    android:initialLayout="@layout/widget_continue_reading"
    android:description="@string/widget_continue_reading_desc" />
```
- [ ] **Step 5: Manifest receivers** in `gen/android/app/src/main/AndroidManifest.xml` (inside `<application>`):
```xml
<receiver android:name="com.readest.native_bridge.ContinueReadingWidgetProvider" android:exported="false">
  <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE"/></intent-filter>
  <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_continue_reading_info"/>
</receiver>
<!-- repeat for StreakWidgetProvider / NextInSeriesWidgetProvider -->
```
- [ ] **Step 6: Build gate (local):** `pnpm tauri android build` requires the Android SDK — NOT available locally. Instead verify via CI: push branch, confirm the nightly workflow's android leg compiles (or add a temporary `workflow_dispatch` build). Do not block on device testing here.
- [ ] **Step 7: Commit (stage all new Kotlin/layout/xml files explicitly — `-am` alone would silently skip untracked files):**
```bash
git add plugins/tauri-plugin-native-bridge/android/src/main/java/ReadingWidgetProviders.kt \
        plugins/tauri-plugin-native-bridge/android/src/main/res/layout/ \
        plugins/tauri-plugin-native-bridge/android/src/main/res/xml/ \
        plugins/tauri-plugin-native-bridge/android/src/main/res/drawable/
git add -u   # NativeBridgePlugin.kt + gen manifest
git commit -m "feat(widgets): android home-screen reading widgets"
```

### Task 10: Frontend covers + final payload

Amend `widgetService.publishNow` (Task 5) to attach covers: for each referenced `coverFile` hash, read the book's cover image (via the repo's existing cover-loading util — grep `coverImageUrl` usage), downscale to 256px max dimension, encode PNG→base64, and send `{ snapshot, covers }`. Books whose cover was sent before needn't resend (keep a Set of sent hashes in-module).

- [ ] Implement + `pnpm lint`. **Commit (modifies tracked widgetService.ts only):**
```bash
git commit -am "feat(widgets): publish downsized covers with snapshot"
```

---

## Chunk 5: iOS WidgetKit extension

### Task 11: Shared store + extension target

**Files:**
- Modify: `gen/apple/project.yml`
- Create: `gen/apple/ReadestWidgets/{ReadestWidgetsBundle.swift, ContinueReadingWidget.swift, StreakWidget.swift, NextInSeriesWidget.swift, WidgetSnapshotStore.swift, Info.plist, ReadestWidgets.entitlements}`
- Modify: `plugins/tauri-plugin-native-bridge/ios/Sources/NativeBridgePlugin.swift` (handle `update_reading_widgets` command: write JSON + covers into App Group container, then `WidgetCenter.shared.reloadAllTimelines()`)

- [ ] **Step 1: Swift command handler** — dispatch is by method name from `run_mobile_plugin`, same as `auth_with_safari` (NativeBridgePlugin.swift:776):

```swift
@objc public func update_reading_widgets(_ invoke: Invoke) throws {
    let args = invoke.parseArgs(WidgetUpdateArgs.self)   // { snapshot: String, covers: [String: String] }
    // Write snapshot JSON + base64-decoded covers into the App Group container
    // (group.com.bilingify.readest)/widget-store/.
    // Then WidgetCenter.shared.reloadAllTimelines()
    invoke.resolve()
}
```
If the App Group container is unavailable (dev build without entitlements), log and no-op — the widget extension renders its placeholder timeline.

- [ ] **Step 2: WidgetSnapshotStore.swift** — reads `$GROUP_ID/widget-store/snapshot.json` + cover files; returns typed struct; corrupt JSON → nil (placeholder timeline).
- [ ] **Step 3: Widgets** — `ReadestWidgetsBundle` declares three `Widget`s; each uses a static `TimelineProvider` returning one `.after(nextPublishCheck)` entry rendering from the store; tap URLs `readest://book/{hash}` / `readest://library` via `.widgetURL(_:)`. E-ink style: flat colors when `snapshot.style == "eink"`.
- [ ] **Step 4: project.yml** — add target mirroring ShareExtension:
```yaml
  ReadestWidgets:
    type: app-extension
    platform: iOS
    sources: [ReadestWidgets]
    settings:
      base:
        INFOPLIST_FILE: ReadestWidgets/Info.plist
        CODE_SIGN_ENTITLEMENTS: ReadestWidgets/ReadestWidgets.entitlements
        PRODUCT_BUNDLE_IDENTIFIER: com.bilingify.readest.ReadestWidgets
```
⚠️ The iOS app bundle ID is `com.bilingify.readest` (project.yml line 14; App Group `group.com.bilingify.readest`) — the Android applicationId (`com.jlnshen.reader`) does NOT apply to iOS. Extension bundle IDs must be prefixed with the containing app's ID or embedding/signing fails.
plus `dependencies:` embedding under `Readest_iOS`, and NSExtensionPointIdentifier `com.apple.widgetkit-extension` in its Info.plist. Ensure BOTH entitlements files contain the same App Group (`group.com.bilingify.readest`).
- [ ] **Step 5: Commit (stage the whole new target tree explicitly)**
```bash
git add apps/readest-app/src-tauri/gen/apple/ReadestWidgets apps/readest-app/src-tauri/gen/apple/project.yml
git add -u   # entitlements / plugin Swift changes
git commit -m "feat(widgets): ios WidgetKit reading widgets"
```

---

## Chunk 6: Verification & docs

### Task 12: Full-suite verification

- [ ] `cd apps/readest-app && pnpm test` — all green (new stats/snapshot/deeplink suites included).
- [ ] `pnpm -C apps/readest-app format:check && pnpm -C apps/readest-app lint` — clean.
- [ ] `cargo check` in src-tauri — clean.
- [ ] Manual device matrix (requires signed builds from CI artifacts): add each widget on Android launcher + iOS springboard; cold-start tap-through on `readest://book/{hash}`; e-ink device visual pass; airplane-mode render from stale store.
- [ ] Update CHANGELOG.md `[Unreleased]` (Added section) per repo convention.
- [ ] Squash-free PR from `feat/home-screen-widgets-spec` → `main`; label `e2e-android` to trigger the device lane.
