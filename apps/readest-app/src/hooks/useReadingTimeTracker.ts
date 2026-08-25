import { useEffect } from 'react';
import { getDailyStatsRecorder, requestWidgetPublish } from '@/services/widgets/widgetService';

const TICK_SEC = 5;
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Accumulates ACTIVE reading seconds (reader mounted, tab visible, user not
 * idle beyond IDLE_TIMEOUT_MS) into the daily stats recorder. Flushes on
 * unmount (book close) so at most one tick of data is ever lost.
 */
export const useReadingTimeTracker = (bookKey: string) => {
  useEffect(() => {
    const recorder = getDailyStatsRecorder();
    if (!recorder) return;

    let idle = false;
    let accumulated = 0;
    const bumpIdle = () => {
      idle = false;
    };
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bumpIdle, { passive: true }));
    const idleTimer = setInterval(() => {
      idle = true;
    }, IDLE_TIMEOUT_MS);

    const tick = setInterval(() => {
      if (idle || document.visibilityState !== 'visible') return;
      recorder.recordTick(Date.now(), TICK_SEC);
      accumulated += TICK_SEC;
      if (accumulated % 30 === 0) void recorder.flush();
    }, TICK_SEC * 1000);

    // Publish streak changes at most once per minute of reading.
    const publishTick = setInterval(() => requestWidgetPublish({ fromProgress: true }), 60_000);

    return () => {
      clearInterval(tick);
      clearInterval(idleTimer);
      clearInterval(publishTick);
      events.forEach((e) => window.removeEventListener(e, bumpIdle));
      void recorder.flush();
    };
  }, [bookKey]);
};
