import { useTranslation } from '@/hooks/useTranslation';
import type { ViewportRect } from '@/utils/bubbleOverlay';

export interface BubbleMarker {
  id: number;
  rect: ViewportRect;
  translation: string;
}

interface Props {
  markers: BubbleMarker[];
  onActivate: (id: number) => void;
}

// A transparent, click-through layer with one tappable marker per detected
// bubble. The layer ignores pointer events; only the markers capture taps so
// reading/pinch still work between bubbles.
const AutoBubbleOverlay = ({ markers, onActivate }: Props) => {
  const _ = useTranslation();
  return (
    <div className='pointer-events-none fixed inset-0 z-40'>
      {markers.map((m) => (
        <button
          key={m.id}
          aria-label={_('Show translation')}
          onClick={() => onActivate(m.id)}
          className='pointer-events-auto absolute rounded-sm border border-blue-500/70 bg-blue-500/10'
          style={{ left: m.rect.left, top: m.rect.top, width: m.rect.width, height: m.rect.height }}
        />
      ))}
    </div>
  );
};

export default AutoBubbleOverlay;
