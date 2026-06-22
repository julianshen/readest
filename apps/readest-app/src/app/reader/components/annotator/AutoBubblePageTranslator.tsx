import React, { useEffect, useRef, useState } from 'react';

import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useTranslator } from '@/hooks/useTranslator';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { captureRegionToBlob } from '@/utils/pageCapture';
import type { OverlayGeometry } from '@/utils/bubbleOverlay';
import { useAutoBubbleTranslate } from '@/app/reader/hooks/useAutoBubbleTranslate';
import {
  ensureOcrModels,
  onOcrModelProgress,
  ocrModelsPresent,
} from '@/services/ocr/modelDownload';
import AutoBubbleOverlay from './AutoBubbleOverlay';
import BubbleTranslationPopup from './BubbleTranslationPopup';

const MAX_EDGE = 1536;
const POPUP_WIDTH = 280;
// Phase 1 hardcodes Japanese as the OCR source language (manga). A per-book
// source-language picker is a Phase-1b follow-up.
const OCR_SOURCE_LANG = 'ja' as const;

interface PopupState {
  transcription: string;
  translation: string;
  position: { x: number; y: number; placeAbove?: boolean };
}

// Whole-page auto bubble translation: OCR the rendered comic page on-device,
// translate every detected bubble in one batch, and overlay tap-to-reveal
// markers. This is the no-drag counterpart to MangaBubbleTranslator (manual
// region select); the small DOM-geometry glue is intentionally duplicated to
// keep the proven manual path untouched — unifying them is a Phase-1b cleanup.
const AutoBubblePageTranslator: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { getView } = useReaderStore();
  const { translate } = useTranslator();
  const { markers, regions, run, clear } = useAutoBubbleTranslate();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [translating, setTranslating] = useState(false);
  const modelsReady = useRef(false);

  // Drop markers/popup when the page turns: they're positioned against the
  // previous page's geometry, so they'd otherwise float over the new page.
  // `location` only changes on an actual relocate (page turn / scroll).
  const location = useBookProgress(bookKey)?.location;
  useEffect(() => {
    clear();
    setPopup(null);
  }, [location, clear]);

  const onAutoTranslate = async () => {
    setPopup(null);

    if (!modelsReady.current) {
      const present = await ocrModelsPresent(OCR_SOURCE_LANG).catch(() => false);
      if (present) {
        modelsReady.current = true;
      } else {
        const { ask } = await import('@tauri-apps/plugin-dialog');
        const ok = await ask(_('Download Japanese OCR models (~235 MB)?'));
        if (!ok) return;

        let lastPct = -1;
        const dispatchProgress = (pct: number) => {
          eventDispatcher.dispatch('toast', {
            message: `${_('Downloading OCR models…')} ${pct}%`,
            type: 'info',
            timeout: 4000,
          });
        };
        dispatchProgress(0);
        const un = await onOcrModelProgress(({ received, total }) => {
          const pct = total > 0 ? Math.round((received / total) * 100) : 0;
          if (pct >= lastPct + 5) {
            lastPct = pct;
            dispatchProgress(pct);
          }
        });
        try {
          await ensureOcrModels('ja');
          modelsReady.current = true;
        } catch {
          eventDispatcher.dispatch('toast', {
            message: _('Failed to download OCR models. Please try again.'),
            type: 'error',
            timeout: 5000,
          });
          un();
          return;
        }
        un();
      }
    }

    const view = getView(bookKey);
    const contents = view?.renderer?.getContents?.() ?? [];
    // getContents() returns all loaded pages sorted by index, so contents[0]
    // isn't necessarily on-screen — prefer the renderer's primary page.
    const primary = contents.find((c) => c.index === view?.renderer?.primaryIndex) ?? contents[0];
    const doc = primary?.doc as Document | undefined;
    const img = doc?.querySelector('img') as HTMLImageElement | null;
    const iframe = doc?.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!img || !iframe) return;

    // DOM geometry glue — parallels MangaBubbleTranslator.onSelect.
    const frameRect = iframe.getBoundingClientRect();
    const m = getComputedStyle(iframe).transform.match(/matrix\((.+)\)/);
    const parts = m?.[1]?.split(/\s*,\s*/).map(parseFloat) ?? [];
    const frameScaleX = Number.isFinite(parts[0]) ? parts[0]! : 1;
    const frameScaleY = Number.isFinite(parts[3]) ? parts[3]! : 1;
    const imgRect = img.getBoundingClientRect(); // iframe-local

    // Capture the whole page, downscaled to MAX_EDGE on the long side. The OCR
    // backend returns bboxes in the pixel space of these bytes, so the overlay
    // geometry's natural size must be the *captured* size, not img.naturalWidth.
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (longEdge <= 0) return;
    const k = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
    const outW = Math.max(1, Math.round(img.naturalWidth * k));
    const outH = Math.max(1, Math.round(img.naturalHeight * k));
    const blob = await captureRegionToBlob(img, {
      sx: 0,
      sy: 0,
      sw: img.naturalWidth,
      sh: img.naturalHeight,
      outW,
      outH,
    });
    if (!blob) return;
    const imageBytes = new Uint8Array(await blob.arrayBuffer());

    const geometry: OverlayGeometry = {
      frameLeft: frameRect.left,
      frameTop: frameRect.top,
      frameScaleX,
      frameScaleY,
      imgLeft: imgRect.left,
      imgTop: imgRect.top,
      imgWidth: imgRect.width,
      imgHeight: imgRect.height,
      naturalWidth: outW,
      naturalHeight: outH,
    };

    const target = getLocale();
    setTranslating(true);
    try {
      await run({
        cacheKeyParts: { bookKey, sectionIndex: primary?.index ?? 0, target },
        imageBytes,
        geometry,
        sourceLang: OCR_SOURCE_LANG,
        langs: { source: OCR_SOURCE_LANG, target },
        translate: (input, o) => translate(input, o),
      });
    } catch {
      eventDispatcher.dispatch('toast', {
        timeout: 5000,
        message: _('Translation failed. Please try again.'),
        type: 'error',
      });
    } finally {
      setTranslating(false);
    }
  };

  // Keep the runner fresh (translate/getView change across renders) so the
  // once-registered listener never calls a stale closure.
  const runAutoRef = useRef<() => void>(() => {});
  runAutoRef.current = () => {
    void onAutoTranslate();
  };

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.bookKey !== bookKey) return;
      runAutoRef.current();
    };
    eventDispatcher.on('manga-auto-translate', handler);
    return () => eventDispatcher.off('manga-auto-translate', handler);
  }, [bookKey]);

  const onActivate = (id: number) => {
    const region = regions.find((r) => r.id === id);
    const marker = markers.find((mk) => mk.id === id);
    if (!region || !marker) return;
    const placeAbove = marker.rect.top + marker.rect.height + 160 > window.innerHeight;
    setPopup({
      transcription: region.original,
      translation: region.translation,
      position: {
        x: Math.max(8, Math.min(marker.rect.left, window.innerWidth - POPUP_WIDTH - 8)),
        y: placeAbove ? marker.rect.top - 6 : marker.rect.top + marker.rect.height + 6,
        placeAbove,
      },
    });
  };

  return (
    <>
      {translating && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-base-100/30'>
          <span className='loading loading-spinner loading-lg' />
          <span className='sr-only'>{_('Translating page…')}</span>
        </div>
      )}
      {markers.length > 0 && <AutoBubbleOverlay markers={markers} onActivate={onActivate} />}
      {popup && (
        <BubbleTranslationPopup
          loading={false}
          transcription={popup.transcription}
          translation={popup.translation}
          error={null}
          position={popup.position}
          width={POPUP_WIDTH}
          onDismiss={() => setPopup(null)}
        />
      )}
    </>
  );
};

export default AutoBubblePageTranslator;
