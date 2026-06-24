import React, { useEffect, useRef, useState } from 'react';

import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { getLanguageName } from '@/utils/lang';
import {
  computeNaturalCropRect,
  captureRegionToBlob,
  regionCacheKey,
  type CropRect,
} from '@/utils/pageCapture';
import { findPageImage } from '@/utils/pageImage';
import {
  translateRegion,
  BubbleErrorCodes,
  type RegionResult,
} from '@/services/ai/bubbleTranslationService';
import RegionSelectOverlay from './RegionSelectOverlay';
import BubbleTranslationPopup from './BubbleTranslationPopup';

const MAX_EDGE = 1536;
const POPUP_WIDTH = 280;

interface PopupState {
  loading: boolean;
  result: RegionResult;
  error: string | null;
  position: { x: number; y: number; placeAbove?: boolean };
}

const MangaBubbleTranslator: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const { settings } = useSettingsStore();
  const { getView } = useReaderStore();

  const [selecting, setSelecting] = useState(false);
  const [popup, setPopup] = useState<PopupState | null>(null);
  const cacheRef = useRef(new Map<string, RegionResult>());

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.bookKey !== bookKey) return;
      setPopup(null);
      setSelecting(true);
    };
    eventDispatcher.on('manga-bubble-mode', handler);
    return () => eventDispatcher.off('manga-bubble-mode', handler);
  }, [bookKey]);

  const onSelect = async (screenRect: CropRect) => {
    setSelecting(false);
    const view = getView(bookKey);
    const contents = view?.renderer?.getContents?.() ?? [];
    // getContents() returns ALL loaded pages (incl. off-screen preloaded ones)
    // sorted by index, so contents[0] isn't necessarily the visible page. Pick
    // the content whose iframe contains the drag rect's center; fall back to the
    // renderer's primary index, then the first content.
    const cx = (screenRect.left + screenRect.right) / 2;
    const cy = (screenRect.top + screenRect.bottom) / 2;
    const frameRectOf = (c: { doc?: Document }) =>
      (c.doc?.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect();
    const primary =
      contents.find((c) => {
        const r = frameRectOf(c);
        return !!r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      }) ??
      contents.find((c) => c.index === view?.renderer?.primaryIndex) ??
      contents[0];
    const doc = primary?.doc as Document | undefined;
    const pageImg = await findPageImage(doc as Document);
    const iframe = doc?.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!pageImg || !iframe) return;

    const frameRect = iframe.getBoundingClientRect();
    const m = getComputedStyle(iframe).transform.match(/matrix\((.+)\)/);
    const parts = m?.[1]?.split(/\s*,\s*/).map(parseFloat) ?? [];
    const frameScaleX = Number.isFinite(parts[0]) ? parts[0]! : 1;
    const frameScaleY = Number.isFinite(parts[3]) ? parts[3]! : 1;

    const crop = computeNaturalCropRect({
      screenRect,
      frameRect,
      frameScaleX,
      frameScaleY,
      imgRect: pageImg.rect,
      naturalWidth: pageImg.naturalWidth,
      naturalHeight: pageImg.naturalHeight,
      maxEdge: MAX_EDGE,
    });
    if (!crop) return;

    const targetLang = getLanguageName(getLocale());
    // If the region is near the bottom, anchor the popup above it (the popup
    // applies translateY(-100%)) so it can't run off the bottom edge.
    const placeAbove = screenRect.bottom + 160 > window.innerHeight;
    const position = {
      x: Math.max(8, Math.min(screenRect.left, window.innerWidth - POPUP_WIDTH - 8)),
      y: placeAbove ? screenRect.top - 6 : screenRect.bottom + 6,
      placeAbove,
    };
    const key = regionCacheKey(primary?.index ?? 0, screenRect, targetLang);
    const cached = cacheRef.current.get(key);
    if (cached) {
      setPopup({ loading: false, result: cached, error: null, position });
      return;
    }

    setPopup({
      loading: true,
      result: { transcription: '', translation: '' },
      error: null,
      position,
    });
    try {
      const blob = await captureRegionToBlob(pageImg.source, crop);
      if (!blob) throw new Error(BubbleErrorCodes.FAILED);
      const result = await translateRegion({
        imageBlob: blob,
        targetLang,
        aiSettings: settings.aiSettings,
      });
      cacheRef.current.set(key, result);
      setPopup({ loading: false, result, error: null, position });
    } catch (error) {
      const code = error instanceof Error ? error.message : BubbleErrorCodes.FAILED;
      setPopup({
        loading: false,
        result: { transcription: '', translation: '' },
        error: code,
        position,
      });
    }
  };

  return (
    <>
      {selecting && (
        <RegionSelectOverlay onSelect={onSelect} onCancel={() => setSelecting(false)} />
      )}
      {popup && (
        <BubbleTranslationPopup
          loading={popup.loading}
          transcription={popup.result.transcription}
          translation={popup.result.translation}
          error={popup.error}
          position={popup.position}
          width={POPUP_WIDTH}
          onDismiss={() => setPopup(null)}
        />
      )}
    </>
  );
};

export default MangaBubbleTranslator;
