import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BookMenu from '@/app/reader/components/sidebar/BookMenu';

let currentBookData: { isFixedLayout: boolean; book: { format: string } } | null = null;
let aiEnabled = true;

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => null,
    getBookData: () => currentBookData,
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    bookKeys: ['book-1'],
    recreateViewer: vi.fn(),
    getViewSettings: () => null,
  }),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: () => ({ getVisibleLibrary: () => [] }),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ sideBarBookKey: 'book-1' }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      kosync: { enabled: false },
      webdav: { enabled: false },
      readwise: { enabled: false },
      hardcover: { enabled: false },
      aiSettings: { enabled: aiEnabled },
    },
  }),
}));
vi.mock('@/store/parallelViewStore', () => ({
  useParallelViewStore: () => ({
    parallelViews: [],
    setParallel: vi.fn(),
    unsetParallel: vi.fn(),
  }),
}));
vi.mock('@/services/environment', () => ({ isWebAppPlatform: () => false }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: vi.fn() } }));
vi.mock('@/helpers/settings', () => ({ saveViewSettings: vi.fn() }));
vi.mock('@/app/reader/components/ProofreadRules', () => ({
  setProofreadRulesVisibility: vi.fn(),
}));
vi.mock('@/components/AboutWindow', () => ({ setAboutDialogVisible: vi.fn() }));
vi.mock('@/app/reader/hooks/useBooksManager', () => ({
  default: () => ({ openParallelView: vi.fn() }),
}));
vi.mock('@/app/reader/hooks/useAISummary', () => ({
  useAISummary: () => ({ runRecap: vi.fn(), runChapterSummary: vi.fn() }),
}));
vi.mock('@/components/Menu', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/MenuItem', () => ({
  default: ({ label, children }: { label: string; children?: React.ReactNode }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  currentBookData = null;
  aiEnabled = true;
});

describe('BookMenu AI Summary gating', () => {
  it('shows AI Summary for reflowable books when AI is enabled', () => {
    currentBookData = { isFixedLayout: false, book: { format: 'EPUB' } };
    render(<BookMenu />);
    expect(screen.getByText('AI Summary')).toBeTruthy();
  });

  it('hides AI Summary for image-only (CBZ) books', () => {
    currentBookData = { isFixedLayout: true, book: { format: 'CBZ' } };
    render(<BookMenu />);
    expect(screen.queryByText('AI Summary')).toBeNull();
  });

  it('keeps AI Summary for fixed-layout PDFs (text layer can be indexed)', () => {
    currentBookData = { isFixedLayout: true, book: { format: 'PDF' } };
    render(<BookMenu />);
    expect(screen.getByText('AI Summary')).toBeTruthy();
  });

  it('hides AI Summary when the assistant is disabled', () => {
    currentBookData = { isFixedLayout: false, book: { format: 'EPUB' } };
    aiEnabled = false;
    render(<BookMenu />);
    expect(screen.queryByText('AI Summary')).toBeNull();
  });
});
