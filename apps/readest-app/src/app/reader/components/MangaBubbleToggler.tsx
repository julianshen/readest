import React, { useState } from 'react';
import { MdTranslate, MdAutoAwesome, MdArrowDropDown } from 'react-icons/md';

import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { isAIAssistantConfigured } from '@/services/ai/providers';
import { isImagePageBook } from '@/utils/book';
import { MANGA_AUTO_TRANSLATE_ENABLED } from '@/services/constants';
import { resolveOcrSourceLang } from '@/services/ocr/sourceLang';
import type { OcrSourceLang } from '@/services/ocr/types';
import { eventDispatcher } from '@/utils/event';

const OCR_LANGS: { code: OcrSourceLang; label: string }[] = [
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

// Fixed-layout comic tools: manual region translate (needs AI) and, behind a
// dark-launch flag, whole-page auto bubble translation (on-device OCR). The
// auto button auto-detects the book's source language and lets the reader
// override it (remembered per book).
const MangaBubbleToggler: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { setHoveredBookKey, getViewSettings, setViewSettings } = useReaderStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const bookData = getBookData(bookKey);

  const isImagePage =
    !!bookData?.book && isImagePageBook(bookData.book.format, !!bookData.isFixedLayout);
  if (!isImagePage) return null;

  const showRegion = isAIAssistantConfigured(settings.aiSettings);
  const showAuto = MANGA_AUTO_TRANSLATE_ENABLED && appService?.osPlatform === 'android';
  if (!showRegion && !showAuto) return null;

  const remembered = getViewSettings(bookKey)?.ocrSourceLang;
  const resolved = resolveOcrSourceLang(bookData?.book?.primaryLanguage, remembered);

  const runAuto = (lang: OcrSourceLang) => {
    setHoveredBookKey('');
    setMenuOpen(false);
    eventDispatcher.dispatch('manga-auto-translate', { bookKey, sourceLang: lang });
  };

  const pickLang = (lang: OcrSourceLang) => {
    const vs = getViewSettings(bookKey);
    if (vs) setViewSettings(bookKey, { ...vs, ocrSourceLang: lang });
    runAuto(lang);
  };

  const onAutoClick = () => {
    if (resolved) runAuto(resolved);
    else setMenuOpen((v) => !v); // undetected → force a choice
  };

  return (
    <>
      {showRegion && (
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
      )}
      {showAuto && (
        <div className='dropdown dropdown-end'>
          <div className='flex'>
            <button
              title={_('Auto-translate page')}
              aria-label={_('Auto-translate page')}
              className='btn btn-ghost h-8 min-h-8 w-8 p-0'
              onClick={onAutoClick}
            >
              <MdAutoAwesome size={18} className='fill-base-content' />
            </button>
            <button
              title={_('Change OCR language')}
              aria-label={_('Change OCR language')}
              className='btn btn-ghost h-8 min-h-8 w-4 p-0'
              onClick={() => setMenuOpen((v) => !v)}
            >
              <MdArrowDropDown size={16} className='fill-base-content' />
            </button>
          </div>
          {menuOpen && (
            <>
              {/* Backdrop: closes the menu on an outside click/tap. */}
              <button
                type='button'
                aria-hidden='true'
                tabIndex={-1}
                className='fixed inset-0 z-40 cursor-default'
                onClick={() => setMenuOpen(false)}
              />
              <ul className='dropdown-content menu bg-base-200 rounded-box z-50 w-40 p-1 shadow'>
                {OCR_LANGS.map(({ code, label }) => (
                  <li key={code}>
                    <button
                      className={resolved === code ? 'font-bold' : ''}
                      onClick={() => pickLang(code)}
                    >
                      {_(label)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
};

export default MangaBubbleToggler;
