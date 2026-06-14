import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';

import type { CropRect } from '@/utils/pageCapture';

const MIN_DRAG = 24;

interface Props {
  onSelect: (rect: CropRect) => void;
  onCancel: () => void;
}

// Full-cell overlay: drag a rectangle; on pointer-up >= MIN_DRAG px emit it,
// else cancel. Esc cancels. Rect coords are viewport (clientX/Y) based.
const RegionSelectOverlay: React.FC<Props> = ({ onSelect, onCancel }) => {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const rectOf = (): CropRect | null => {
    if (!start || !cur) return null;
    return {
      left: Math.min(start.x, cur.x),
      top: Math.min(start.y, cur.y),
      right: Math.max(start.x, cur.x),
      bottom: Math.max(start.y, cur.y),
    };
  };
  const box = rectOf();

  return (
    <div
      ref={ref}
      className='fixed inset-0 z-50 cursor-crosshair touch-none bg-black/10'
      data-setting-id='reader.manga-bubble-overlay'
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        setStart({ x: e.clientX, y: e.clientY });
        setCur({ x: e.clientX, y: e.clientY });
      }}
      onPointerMove={(e) => start && setCur({ x: e.clientX, y: e.clientY })}
      onPointerUp={() => {
        const r = rectOf();
        if (r && r.right - r.left >= MIN_DRAG && r.bottom - r.top >= MIN_DRAG) onSelect(r);
        else onCancel();
      }}
      onPointerCancel={onCancel}
    >
      {box && (
        <div
          className={clsx(
            'pointer-events-none absolute border-2 border-dashed border-blue-500 bg-blue-500/10',
            'eink-bordered',
          )}
          style={{
            left: box.left,
            top: box.top,
            width: box.right - box.left,
            height: box.bottom - box.top,
          }}
        />
      )}
    </div>
  );
};

export default RegionSelectOverlay;
