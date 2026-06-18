import { useCallback, useRef, useState } from 'react';
import { mapImageBBoxToViewport, type OverlayGeometry } from '@/utils/bubbleOverlay';
import type { BubbleMarker } from '@/app/reader/components/annotator/AutoBubbleOverlay';
import type { OcrSourceLang, TranslatedRegion } from '@/services/ocr/types';
import { ocrPageRegions } from '@/services/ocr/ocrBackend';
import { translateRegions, pageCacheKey } from '@/services/ocr/translatePage';

// Pure: project translated regions onto positioned overlay markers.
export const regionsToMarkers = (
  regions: TranslatedRegion[],
  geom: OverlayGeometry,
): BubbleMarker[] =>
  regions.map((r) => ({
    id: r.id,
    rect: mapImageBBoxToViewport(r.bbox, geom),
    translation: r.translation,
  }));

// Orchestrates one page: OCR (backend) -> translate (existing translator) ->
// markers, cached per page key. DOM geometry + page bytes are supplied by the
// caller so this hook stays free of foliate/DOM coupling.
export const useAutoBubbleTranslate = () => {
  const cache = useRef(new Map<string, TranslatedRegion[]>());
  const [markers, setMarkers] = useState<BubbleMarker[]>([]);
  const [regions, setRegions] = useState<TranslatedRegion[]>([]);

  const run = useCallback(
    async (args: {
      cacheKeyParts: { bookKey: string; sectionIndex: number; target: string };
      imageBytes: Uint8Array;
      geometry: OverlayGeometry;
      sourceLang: OcrSourceLang;
      langs: { source: string; target: string };
      translate: (input: string[], o: { source: string; target: string }) => Promise<string[]>;
    }) => {
      const key = pageCacheKey(
        args.cacheKeyParts.bookKey,
        args.cacheKeyParts.sectionIndex,
        args.cacheKeyParts.target,
      );
      let translated = cache.current.get(key);
      if (!translated) {
        const detected = await ocrPageRegions(args.imageBytes, args.sourceLang);
        translated = await translateRegions(detected, args.translate, args.langs);
        cache.current.set(key, translated);
      }
      setRegions(translated);
      setMarkers(regionsToMarkers(translated, args.geometry));
    },
    [],
  );

  const clear = useCallback(() => {
    setMarkers([]);
    setRegions([]);
  }, []);

  return { markers, regions, run, clear };
};
