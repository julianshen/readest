import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AutoBubbleOverlay from '@/app/reader/components/annotator/AutoBubbleOverlay';
import type { ViewportRect } from '@/utils/bubbleOverlay';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

afterEach(() => cleanup());

const markers = [
  {
    id: 0,
    rect: { left: 10, top: 20, width: 30, height: 40 } as ViewportRect,
    translation: 'Hello',
  },
  { id: 1, rect: { left: 50, top: 60, width: 30, height: 40 } as ViewportRect, translation: 'Bye' },
];

describe('AutoBubbleOverlay', () => {
  it('renders one positioned marker per region', () => {
    render(<AutoBubbleOverlay markers={markers} onActivate={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.style.left).toBe('10px');
    expect(buttons[0]!.style.top).toBe('20px');
  });

  it('calls onActivate with the region id when a marker is tapped', () => {
    const onActivate = vi.fn();
    render(<AutoBubbleOverlay markers={markers} onActivate={onActivate} />);
    fireEvent.click(screen.getAllByRole('button')[1]!);
    expect(onActivate).toHaveBeenCalledWith(1);
  });
});
