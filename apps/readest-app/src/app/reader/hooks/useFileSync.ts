import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { BookNote } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useTranslation } from '@/hooks/useTranslation';
import { debounce } from '@/utils/debounce';
import { eventDispatcher } from '@/utils/event';
import { FileSyncEngine } from '@/services/sync/file/engine';
import { FileSyncError } from '@/services/sync/file/provider';
import type { FileSyncBackendKind } from '@/services/sync/file/providerRegistry';
import { buildFileSyncEngine, getReadyFileSyncBackends } from '@/services/sync/file/runLibrarySync';
import { settingsKeyForBackend } from '@/services/sync/cloudSyncProvider';
import { removeBookNoteOverlays } from '../utils/annotatorUtil';
import { useWindowActiveChanged } from './useWindowActiveChanged';

const PUSH_DEBOUNCE_MS = 15_000;
const PULL_COOLDOWN_MS = 60_000;
const OPEN_PULL_SKIP_MS = 30_000;

type EngineEntry = { kind: FileSyncBackendKind; engine: FileSyncEngine };

/**
 * Reader-level file sync for every ready third-party backend. Automatic sync
 * mirrors all active providers; the legacy WebDAV events intentionally keep
 * targeting WebDAV alone so existing reader-close/manual controls do not
 * unexpectedly fan out to another provider.
 */
export const useFileSync = (bookKey: string) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { userProfilePlan } = useQuotaStats();
  const getViewsById = useReaderStore((state) => state.getViewsById);
  const getView = useReaderStore((state) => state.getView);
  const getConfig = useBookDataStore((state) => state.getConfig);
  const setConfig = useBookDataStore((state) => state.setConfig);
  const getBookData = useBookDataStore((state) => state.getBookData);
  const saveConfig = useBookDataStore((state) => state.saveConfig);
  const progress = useBookProgress(bookKey);

  const readyKinds = useMemo(
    () => getReadyFileSyncBackends(settings, userProfilePlan ?? 'free'),
    [settings, userProfilePlan],
  );
  const readyKindsKey = readyKinds.join(',');
  const [engines, setEngines] = useState<EngineEntry[]>([]);
  // Each mirror has its own pending state: flushing WebDAV must never drop
  // a scheduled Google Drive/S3/etc. update.
  const dirtyKindsRef = useRef(new Set<FileSyncBackendKind>());
  const lastPulledAtRef = useRef(0);
  const hasPulledOnce = useRef(false);
  const fileSyncedRef = useRef(new Set<FileSyncBackendKind>());
  const coverSyncedRef = useRef(new Set<FileSyncBackendKind>());

  const engineKey = useMemo(() => {
    const webdav = settings.webdav;
    const s3 = settings.s3;
    return [
      readyKindsKey,
      `webdav:${webdav?.serverUrl}:${webdav?.username}:${webdav?.password}:${webdav?.rootPath}`,
      `gdrive:${settings.googleDrive?.enabled}`,
      `s3:${s3?.endpoint}:${s3?.region}:${s3?.bucket}:${s3?.accessKeyId}:${s3?.secretAccessKey}`,
      `onedrive:${settings.onedrive?.enabled}`,
      `icloud:${settings.icloud?.enabled}`,
    ].join('|');
  }, [
    readyKindsKey,
    settings.webdav,
    settings.googleDrive,
    settings.s3,
    settings.onedrive,
    settings.icloud,
  ]);

  useEffect(() => {
    let cancelled = false;
    setEngines([]);
    if (readyKinds.length === 0) return;
    (async () => {
      const built: EngineEntry[] = [];
      for (const kind of readyKinds) {
        const engine = await buildFileSyncEngine(envConfig, kind);
        if (engine) built.push({ kind, engine });
      }
      if (!cancelled) setEngines(built);
    })();
    return () => {
      cancelled = true;
    };
    // engineKey captures only connection-relevant settings. Read settings
    // inside the builder so ordinary lastSyncedAt writes do not rebuild it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineKey, envConfig]);

  useEffect(() => {
    hasPulledOnce.current = false;
    lastPulledAtRef.current = 0;
    dirtyKindsRef.current.clear();
    fileSyncedRef.current.clear();
    coverSyncedRef.current.clear();
  }, [readyKindsKey]);

  const sliceFor = useCallback(
    (kind: FileSyncBackendKind) => settings[settingsKeyForBackend(kind)],
    [settings],
  );
  const allowsPush = useCallback(
    (kind: FileSyncBackendKind) => (sliceFor(kind)?.strategy ?? 'silent') !== 'receive',
    [sliceFor],
  );
  const allowsPull = useCallback(
    (kind: FileSyncBackendKind) => (sliceFor(kind)?.strategy ?? 'silent') !== 'send',
    [sliceFor],
  );

  const handleSyncError = useCallback(
    (kind: FileSyncBackendKind, label: string, error: unknown) => {
      if (kind === 'webdav' && error instanceof FileSyncError && error.code === 'AUTH_FAILED') {
        eventDispatcher.dispatch('toast', {
          type: 'error',
          message: _('WebDAV authentication failed. Reconnect in Settings.'),
        });
      }
      console.warn(label, kind, error);
    },
    [_],
  );

  const ensureDeviceId = useCallback(
    (kind: FileSyncBackendKind): string => {
      const latest = useSettingsStore.getState().settings;
      const key = settingsKeyForBackend(kind);
      let deviceId = latest[key]?.deviceId;
      if (!deviceId) {
        deviceId = uuidv4();
        const next = { ...latest, [key]: { ...latest[key], deviceId } };
        setSettings(next);
        void saveSettings(envConfig, next);
      }
      return deviceId;
    },
    [envConfig, saveSettings, setSettings],
  );

  const updateLastSyncedAt = useCallback(
    async (kinds: FileSyncBackendKind[]) => {
      if (!kinds.length) return;
      let next = useSettingsStore.getState().settings;
      for (const kind of kinds) {
        switch (kind) {
          case 'webdav':
            next = { ...next, webdav: { ...next.webdav, lastSyncedAt: Date.now() } };
            break;
          case 'gdrive':
            next = { ...next, googleDrive: { ...next.googleDrive, lastSyncedAt: Date.now() } };
            break;
          case 's3':
            next = { ...next, s3: { ...next.s3, lastSyncedAt: Date.now() } };
            break;
          case 'onedrive':
            next = { ...next, onedrive: { ...next.onedrive, lastSyncedAt: Date.now() } };
            break;
          case 'icloud':
            next = { ...next, icloud: { ...next.icloud, lastSyncedAt: Date.now() } };
            break;
        }
      }
      setSettings(next);
      await saveSettings(envConfig, next);
    },
    [envConfig, saveSettings, setSettings],
  );

  const entriesFor = useCallback(
    (kinds?: readonly FileSyncBackendKind[]) =>
      kinds ? engines.filter(({ kind }) => kinds.includes(kind)) : engines,
    [engines],
  );

  const pushConfigs = useCallback(
    async (kinds?: readonly FileSyncBackendKind[]) => {
      if (useReaderStore.getState().getViewState(bookKey)?.previewMode) return;
      const config = getConfig(bookKey);
      const book = getBookData(bookKey)?.book;
      if (!config || !book) return;

      const pushed: FileSyncBackendKind[] = [];
      for (const { kind, engine } of entriesFor(kinds)) {
        if (!allowsPush(kind)) continue;
        const providerSettings = sliceFor(kind);
        if (!(providerSettings?.syncProgress ?? true) && !(providerSettings?.syncNotes ?? true)) {
          continue;
        }
        try {
          await engine.pushBookConfig(book, config, ensureDeviceId(kind));
          pushed.push(kind);
          dirtyKindsRef.current.delete(kind);
        } catch (error) {
          handleSyncError(kind, 'file sync push failed', error);
        }
      }
      if (pushed.length) {
        await updateLastSyncedAt(pushed);
      }
    },
    [
      allowsPush,
      bookKey,
      ensureDeviceId,
      entriesFor,
      getBookData,
      getConfig,
      handleSyncError,
      sliceFor,
      updateLastSyncedAt,
    ],
  );

  const pushBookFiles = useCallback(
    async (kinds?: readonly FileSyncBackendKind[]) => {
      const book = getBookData(bookKey)?.book;
      if (!book) return;
      const uploaded: FileSyncBackendKind[] = [];
      for (const { kind, engine } of entriesFor(kinds)) {
        if (!allowsPush(kind) || !(sliceFor(kind)?.syncBooks ?? false)) continue;
        if (fileSyncedRef.current.has(kind)) continue;
        fileSyncedRef.current.add(kind);
        try {
          if ((await engine.pushBookFile(book)).uploaded) uploaded.push(kind);
        } catch (error) {
          fileSyncedRef.current.delete(kind);
          handleSyncError(kind, 'file sync book push failed', error);
        }
      }
      await updateLastSyncedAt(uploaded);
    },
    [allowsPush, bookKey, entriesFor, getBookData, handleSyncError, sliceFor, updateLastSyncedAt],
  );

  const pushBookCovers = useCallback(
    async (kinds?: readonly FileSyncBackendKind[]) => {
      const book = getBookData(bookKey)?.book;
      if (!book) return;
      for (const { kind, engine } of entriesFor(kinds)) {
        if (!allowsPush(kind) || coverSyncedRef.current.has(kind)) continue;
        coverSyncedRef.current.add(kind);
        try {
          await engine.pushBookCover(book);
        } catch (error) {
          coverSyncedRef.current.delete(kind);
          handleSyncError(kind, 'file sync cover push failed', error);
        }
      }
    },
    [allowsPush, bookKey, entriesFor, getBookData, handleSyncError],
  );

  const pullConfigs = useCallback(
    async (kinds?: readonly FileSyncBackendKind[]): Promise<boolean> => {
      const config = getConfig(bookKey);
      const book = getBookData(bookKey)?.book;
      if (!config || !book) return false;

      let working = config;
      let applied = false;
      let mergedNotes: BookNote[] | undefined;
      const pulled: FileSyncBackendKind[] = [];
      for (const { kind, engine } of entriesFor(kinds)) {
        if (!allowsPull(kind)) continue;
        const providerSettings = sliceFor(kind);
        const wantProgress = providerSettings?.syncProgress ?? true;
        const wantNotes = providerSettings?.syncNotes ?? true;
        if (!wantProgress && !wantNotes) continue;
        const before = working;
        try {
          const result = await engine.pullBookConfig(book, working);
          lastPulledAtRef.current = Date.now();
          pulled.push(kind);
          if (!result.applied || !result.mergedConfig) continue;
          applied = true;
          let merged = result.mergedConfig;
          if (!wantProgress) {
            merged = {
              ...merged,
              progress: before.progress,
              location: before.location,
              xpointer: before.xpointer,
            };
          }
          if (!wantNotes) {
            merged = { ...merged, booknotes: before.booknotes };
          } else if (result.mergedNotes) {
            mergedNotes = result.mergedNotes;
          }
          working = merged;
        } catch (error) {
          handleSyncError(kind, 'file sync pull failed', error);
        }
      }
      await updateLastSyncedAt(pulled);
      if (!applied) return false;

      if (mergedNotes) {
        const view = getView(bookKey);
        const previousById = new Map((config.booknotes ?? []).map((note) => [note.id, note]));
        for (const note of mergedNotes) {
          const previous = previousById.get(note.id);
          if (note.deletedAt && (!previous || !previous.deletedAt)) {
            getViewsById(bookKey.split('-')[0]!).forEach((entry) =>
              removeBookNoteOverlays(entry, note),
            );
          } else if (!note.deletedAt && note.cfi && view) {
            try {
              view.addAnnotation(note);
            } catch {
              // It belongs to a different spine section; Foliate renders it later.
            }
          }
        }
      }

      setConfig(bookKey, working);
      const latest = getConfig(bookKey);
      if (latest) await saveConfig(envConfig, bookKey, latest, settings);
      return true;
    },
    [
      allowsPull,
      bookKey,
      entriesFor,
      envConfig,
      getBookData,
      getConfig,
      getView,
      getViewsById,
      handleSyncError,
      saveConfig,
      settings,
      setConfig,
      sliceFor,
      updateLastSyncedAt,
    ],
  );

  const pushNow = useCallback(() => pushConfigs(), [pushConfigs]);
  const pushDirtyNow = useCallback(() => {
    const dirtyKinds = [...dirtyKindsRef.current];
    return dirtyKinds.length ? pushConfigs(dirtyKinds) : Promise.resolve();
  }, [pushConfigs]);
  const pullNow = useCallback(() => pullConfigs(), [pullConfigs]);
  const pushWebDAVNow = useCallback(() => pushConfigs(['webdav']), [pushConfigs]);
  const pullWebDAVNow = useCallback(() => pullConfigs(['webdav']), [pullConfigs]);
  const pushWebDAVFiles = useCallback(() => pushBookFiles(['webdav']), [pushBookFiles]);
  const pushWebDAVCovers = useCallback(() => pushBookCovers(['webdav']), [pushBookCovers]);

  const syncRefs = useRef({
    pushNow,
    pushDirtyNow,
    pullNow,
    pushBookFiles,
    pushBookCovers,
    pushWebDAVNow,
    pullWebDAVNow,
    pushWebDAVFiles,
    pushWebDAVCovers,
  });
  useEffect(() => {
    syncRefs.current = {
      pushNow,
      pushDirtyNow,
      pullNow,
      pushBookFiles,
      pushBookCovers,
      pushWebDAVNow,
      pullWebDAVNow,
      pushWebDAVFiles,
      pushWebDAVCovers,
    };
  }, [
    pullNow,
    pullWebDAVNow,
    pushBookCovers,
    pushBookFiles,
    pushDirtyNow,
    pushNow,
    pushWebDAVCovers,
    pushWebDAVFiles,
    pushWebDAVNow,
  ]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedPush = useCallback(
    debounce(() => {
      void syncRefs.current.pushDirtyNow();
    }, PUSH_DEBOUNCE_MS),
    [],
  );
  const markDirtyAndSchedule = useCallback(() => {
    for (const { kind } of engines) dirtyKindsRef.current.add(kind);
    debouncedPush();
  }, [debouncedPush, engines]);

  const isReady = engines.length > 0;
  useEffect(() => {
    if (!isReady || !progress?.location || hasPulledOnce.current) return;
    hasPulledOnce.current = true;
    if (Date.now() - lastPulledAtRef.current < OPEN_PULL_SKIP_MS) return;
    void (async () => {
      // Bootstrap separately per mirror: a populated WebDAV config must not
      // stop an empty Drive/S3 config path from being created.
      for (const { kind } of engines) {
        const merged = await pullConfigs([kind]);
        if (!merged) {
          dirtyKindsRef.current.add(kind);
          await pushConfigs([kind]);
        }
      }
      await Promise.all([syncRefs.current.pushBookCovers(), syncRefs.current.pushBookFiles()]);
    })();
  }, [engines, isReady, progress?.location, pullConfigs, pushConfigs]);

  useEffect(() => {
    if (isReady && progress?.location) markDirtyAndSchedule();
  }, [isReady, markDirtyAndSchedule, progress?.location]);

  const config = getConfig(bookKey);
  const booknoteFingerprint = useMemo(() => {
    const notes = config?.booknotes ?? [];
    let latest = 0;
    for (const note of notes) latest = Math.max(latest, note.updatedAt ?? 0, note.deletedAt ?? 0);
    return `${notes.length}:${latest}`;
  }, [config?.booknotes]);
  useEffect(() => {
    if (isReady && Date.now() - lastPulledAtRef.current >= 1_000) markDirtyAndSchedule();
  }, [booknoteFingerprint, isReady, markDirtyAndSchedule]);

  useEffect(() => {
    const matchesBook = (event: CustomEvent) =>
      !event.detail?.bookKey || event.detail.bookKey === bookKey;
    const handlePush = (event: CustomEvent) => {
      if (!matchesBook(event)) return;
      dirtyKindsRef.current.add('webdav');
      fileSyncedRef.current.delete('webdav');
      coverSyncedRef.current.delete('webdav');
      void syncRefs.current.pushWebDAVNow();
      void syncRefs.current.pushWebDAVFiles();
      void syncRefs.current.pushWebDAVCovers();
    };
    const handlePull = (event: CustomEvent) => {
      if (!matchesBook(event)) return;
      lastPulledAtRef.current = 0;
      hasPulledOnce.current = false;
      void syncRefs.current.pullWebDAVNow();
    };
    eventDispatcher.on('push-webdav-sync', handlePush);
    eventDispatcher.on('pull-webdav-sync', handlePull);
    eventDispatcher.on('flush-webdav-sync', handlePush);
    return () => {
      eventDispatcher.off('push-webdav-sync', handlePush);
      eventDispatcher.off('pull-webdav-sync', handlePull);
      eventDispatcher.off('flush-webdav-sync', handlePush);
    };
  }, [bookKey, debouncedPush]);

  useWindowActiveChanged((isActive) => {
    if (!isReady) return;
    if (isActive) {
      if (Date.now() - lastPulledAtRef.current >= PULL_COOLDOWN_MS) {
        void syncRefs.current.pullNow();
      }
    } else if (dirtyKindsRef.current.size > 0) {
      debouncedPush.flush();
    }
  });

  useEffect(() => () => debouncedPush.flush(), [debouncedPush]);

  return { pushNow, pullNow };
};

export default useFileSync;
