import React from 'react';
import { MdTranslate } from 'react-icons/md';

import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import { IMAGE_BOOK_FORMATS } from '@/types/book';
import { eventDispatcher } from '@/utils/event';

// Fixed-layout comic (CBZ) + AI-configured: enter region-translate mode.
const MangaBubbleToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { setHoveredBookKey } = useReaderStore();
  const bookData = getBookData(bookKey);

  const isComic = !!bookData?.book && IMAGE_BOOK_FORMATS.has(bookData.book.format);
  if (!isComic || !isAIAssistantConfigured(settings.aiSettings)) return null;

  return (
    <button
      title={_('Translate Region')}
      aria-label={_('Translate Region')}
      className='btn btn-ghost h-8 min-h-8 w-8 p-0'
      onClick={() => {
        setHoveredBookKey('');
        eventDispatcher.dispatch('manga-bubble-mode', { bookKey });
      }}
    >
      <MdTranslate size={18} className='fill-base-content' />
    </button>
  );
};

export default MangaBubbleToggler;
