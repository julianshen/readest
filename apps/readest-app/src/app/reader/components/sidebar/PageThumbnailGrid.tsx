import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';

import { BookDoc, SectionItem } from '@/libs/document';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useTranslation } from '@/hooks/useTranslation';
import { clearThumbnailCache } from '@/utils/thumbnailCache';
import { useSectionThumbnail } from '../../hooks/useSectionThumbnail';

interface ThumbCellProps {
  bookKey: string;
  section: SectionItem;
  index: number;
  href: string;
  current: boolean;
  onSelect: (href: string) => void;
}

const ThumbCell: React.FC<ThumbCellProps> = ({
  bookKey,
  section,
  index,
  href,
  current,
  onSelect,
}) => {
  const _ = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { rootMargin: '200px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const dataUrl = useSectionThumbnail(bookKey, section, index, visible);

  return (
    <button
      ref={ref}
      onClick={() => onSelect(href)}
      className={clsx(
        'flex flex-col items-center gap-1 rounded p-1',
        current ? 'bg-base-300 ring-primary ring-2' : 'hover:bg-base-200',
      )}
      aria-label={_('Page {{page}}', { page: index + 1 })}
      aria-current={current ? 'true' : undefined}
    >
      <div className='bg-base-200 flex aspect-[2/3] w-full items-center justify-center overflow-hidden rounded'>
        {dataUrl ? (
          <img src={dataUrl} alt='' className='h-full w-full object-cover' />
        ) : (
          <span className='text-base-content/40 text-xs'>{index + 1}</span>
        )}
      </div>
      <span className='text-base-content/70 text-xs'>{index + 1}</span>
    </button>
  );
};

const PageThumbnailGrid: React.FC<{ bookKey: string; bookDoc: BookDoc }> = ({
  bookKey,
  bookDoc,
}) => {
  const getView = useReaderStore((s) => s.getView);
  const { setSideBarVisible } = useSidebarStore();
  const sections: SectionItem[] = bookDoc.sections ?? [];
  const toc = bookDoc.toc ?? [];
  // Reactive: the highlight must track page turns while the grid is open.
  const currentIndex = useBookProgress(bookKey)?.index ?? 0;
  const rtl = bookDoc.dir === 'rtl';
  const isMobile = window.innerWidth < 640 || window.innerHeight < 640;

  useEffect(() => () => clearThumbnailCache(bookKey), [bookKey]);

  const handleSelect = (href: string) => {
    getView(bookKey)?.goTo(href);
    if (isMobile) setSideBarVisible(false);
  };

  return (
    <div
      dir={rtl ? 'rtl' : 'ltr'}
      className='grid grid-cols-3 gap-2 p-3'
      data-setting-id='reader.sidebar.thumbnail-grid'
    >
      {sections.map((section, index) => (
        <ThumbCell
          key={section.id}
          bookKey={bookKey}
          section={section}
          index={index}
          href={toc[index]?.href ?? section.id}
          current={index === currentIndex}
          onSelect={handleSelect}
        />
      ))}
    </div>
  );
};

export default PageThumbnailGrid;
