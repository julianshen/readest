import React from 'react';
import { MdTranslate, MdAutoAwesome } from 'react-icons/md';

import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import { isImagePageBook } from '@/utils/book';
import { MANGA_AUTO_TRANSLATE_ENABLED } from '@/services/constants';
import { eventDispatcher } from '@/utils/event';

// Fixed-layout comic (CBZ) tools: manual region translate (needs AI) and,
// behind a dark-launch flag, whole-page auto bubble translation (on-device OCR).
const MangaBubbleToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { setHoveredBookKey } = useReaderStore();
  const bookData = getBookData(bookKey);

  const isImagePage =
    !!bookData?.book && isImagePageBook(bookData.book.format, !!bookData.isFixedLayout);
  if (!isImagePage) return null;

  const showRegion = isAIAssistantConfigured(settings.aiSettings);
  const showAuto = MANGA_AUTO_TRANSLATE_ENABLED && appService?.osPlatform === 'android';
  if (!showRegion && !showAuto) return null;

  const dispatch = (event: string) => {
    setHoveredBookKey('');
    eventDispatcher.dispatch(event, { bookKey });
  };

  return (
    <>
      {showRegion && (
        <button
          title={_('Translate Region')}
          aria-label={_('Translate Region')}
          className='btn btn-ghost h-8 min-h-8 w-8 p-0'
          onClick={() => dispatch('manga-bubble-mode')}
        >
          <MdTranslate size={18} className='fill-base-content' />
        </button>
      )}
      {showAuto && (
        <button
          title={_('Auto-translate page')}
          aria-label={_('Auto-translate page')}
          className='btn btn-ghost h-8 min-h-8 w-8 p-0'
          onClick={() => dispatch('manga-auto-translate')}
        >
          <MdAutoAwesome size={18} className='fill-base-content' />
        </button>
      )}
    </>
  );
};

export default MangaBubbleToggler;
