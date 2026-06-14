import clsx from 'clsx';
import React, { useState } from 'react';
import { MdClose, MdChevronRight } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import useBooksManager from '../../hooks/useBooksManager';
import type { Book } from '@/types/book';

// Dismissible footer pill shown at end-of-book when a next volume exists.
const NextVolumePill: React.FC<{ nextBook: Book }> = ({ nextBook }) => {
  const _ = useTranslation();
  const { openBook } = useBooksManager();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  return (
    <div
      className={clsx(
        'bg-base-200 eink-bordered pointer-events-auto flex items-center gap-2',
        'mx-auto mb-2 max-w-[92%] rounded-full px-3 py-2 shadow-sm',
      )}
      data-setting-id='reader.footer.next-volume'
    >
      <button
        className='btn btn-primary flex min-w-0 flex-1 items-center gap-1 rounded-full px-2 py-1'
        onClick={() => openBook(nextBook.hash)}
      >
        <span className='text-base-content/70 shrink-0 text-xs'>{_('Next Volume')}</span>
        <span className='truncate text-sm font-medium'>{nextBook.title}</span>
        <MdChevronRight className='shrink-0' size={18} />
      </button>
      <button
        className='btn btn-ghost btn-circle btn-xs shrink-0'
        aria-label={_('Close')}
        onClick={() => setDismissed(true)}
      >
        <MdClose size={16} />
      </button>
    </div>
  );
};

export default NextVolumePill;
