import { invoke } from '@tauri-apps/api/core';
import { isTauriAppPlatform } from '@/services/environment';
import type { AppService } from '@/services/appService';
import type { Book } from '@/types/book';
import { getCoverFilename } from '@/utils/book';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  computeStreak,
  createDailyStatsRecorder,
  type DailyStatsRecorder,
} from '@/services/stats/dailyStats';
import { buildWidgetSnapshot, type WidgetSnapshot } from './widgetSnapshot';

const PROGRESS_THROTTLE_MS = 60_000; // at most one progress-driven publish/minute
const DEBOUNCE_MS = 5_000;

let recorder: DailyStatsRecorder | null = null;
let appService: AppService | null = null;
let lastProgressPublish = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
/** Cover hashes already sent to the native side — avoids re-encoding bitmaps. */
const sentCovers = new Set<string>();

async function readCoverBase64(book: Book): Promise<string | null> {
  if (!appService) return null;
  try {
    const fs = appService.getFileSystem();
    const file = await fs.openFile(`${appService.localBooksDir}/${getCoverFilename(book)}`, 'None');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  } catch {
    return null; // no cover — provider falls back to a letter-cover
  }
}

async function publishNow() {
  if (!recorder || !isTauriAppPlatform()) return;
  const library: Book[] = useLibraryStore.getState().getVisibleLibrary();
  const isEink = !!useSettingsStore.getState().settings?.viewSettings?.isEink;
  const now = Date.now();
  const snapshot: WidgetSnapshot = buildWidgetSnapshot(
    library,
    computeStreak(recorder.getMap(), now),
    null, // chapterLabel intentionally empty in v1
    isEink ? 'eink' : 'default',
    now,
  );

  // Attach base64 PNG covers for hashes referenced by the snapshot.
  const covers: Record<string, string> = {};
  for (const section of [snapshot.continueReading, snapshot.nextInSeries]) {
    if (!section?.coverFile) continue;
    const hash = section.coverFile.replace(/\.png$/, '');
    if (sentCovers.has(hash)) continue;
    const book = library.find((b) => b.hash === hash);
    const data = book ? await readCoverBase64(book) : null;
    sentCovers.add(hash); // mark even on failure so we don't retry every publish
    if (data) covers[hash] = data;
  }

  await invoke('update_reading_widgets', {
    payload: { snapshot: JSON.stringify(snapshot), covers },
  });
}

/**
 * Debounced + throttled publish entry point. Progress-driven callers pass
 * `fromProgress` so page turns are throttled harder than lifecycle events
 * (open/close/finish/style change), which pass `force`.
 */
export function requestWidgetPublish(opts: { force?: boolean; fromProgress?: boolean } = {}) {
  if (!recorder || !isTauriAppPlatform()) return;
  if (opts.fromProgress && Date.now() - lastProgressPublish < PROGRESS_THROTTLE_MS) return;
  if (opts.fromProgress) lastProgressPublish = Date.now();

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void publishNow();
  }, DEBOUNCE_MS);
}

/**
 * Initialize the widget pipeline once per app session. Call from the library
 * page init effect where the app service is available.
 */
export async function initWidgetService(service: AppService): Promise<void> {
  if (!isTauriAppPlatform() || initialized) return;
  initialized = true;
  appService = service;
  recorder = createDailyStatsRecorder(service.getFileSystem());
  await recorder.load();

  // Library mutations (add / delete / finish / progress persist).
  useLibraryStore.subscribe(() => requestWidgetPublish({ force: true }));

  // Flush on background; republish on return (covers day rollover).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void recorder?.flush();
    } else {
      requestWidgetPublish({ force: true });
    }
  });

  requestWidgetPublish({ force: true });
}

export function getDailyStatsRecorder(): DailyStatsRecorder | null {
  return recorder;
}
