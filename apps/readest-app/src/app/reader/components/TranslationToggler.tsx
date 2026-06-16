import { useEffect, useState } from 'react';
import { RiTranslate } from 'react-icons/ri';

import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { saveViewSettings } from '@/helpers/settings';
import { getTranslationUnavailableReason } from '@/services/translators/utils';
import { eventDispatcher } from '@/utils/event';
import Button from '@/components/Button';

const TranslationToggler = ({ bookKey }: { bookKey: string }) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { getBookData } = useBookDataStore();
  const { getViewSettings, setViewSettings, setHoveredBookKey } = useReaderStore();

  const iconSize20 = useResponsiveSize(20);
  const bookData = getBookData(bookKey);
  const viewSettings = getViewSettings(bookKey)!;
  const [translationEnabled, setTranslationEnabled] = useState(viewSettings.translationEnabled!);

  // Derived from props/settings — compute during render, don't mirror in state.
  const unavailableReason = getTranslationUnavailableReason(
    bookData?.book,
    viewSettings.translateTargetLang,
  );

  useEffect(() => {
    if (translationEnabled === viewSettings.translationEnabled) return;
    if (appService?.isMobile) {
      setHoveredBookKey('');
    }
    saveViewSettings(envConfig, bookKey, 'translationEnabled', translationEnabled, true, false);
    viewSettings.translationEnabled = translationEnabled;
    setViewSettings(bookKey, { ...viewSettings });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translationEnabled]);

  useEffect(() => {
    setTranslationEnabled(viewSettings.translationEnabled);
  }, [viewSettings.translationEnabled]);

  const translationAvailable = unavailableReason === null;
  // The target matching the book's own language would translate every line to
  // itself and render nothing. Keep the button tappable for that case so we can
  // explain why, instead of a silent no-op or an unexplained greyed-out icon.
  const sameLanguage = unavailableReason === 'same-language';

  const handleClick = () => {
    if (!translationEnabled && sameLanguage) {
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _(
          'The target language matches the book language. Pick a different target language.',
        ),
      });
      return;
    }
    setTranslationEnabled(!translationEnabled);
  };

  return (
    <Button
      icon={
        <RiTranslate
          className={translationEnabled ? 'text-blue-500' : 'text-base-content'}
          size={iconSize20}
        />
      }
      aria-label={_('Toggle Translation')}
      disabled={!translationAvailable && !sameLanguage && !translationEnabled}
      onClick={handleClick}
      label={
        translationAvailable
          ? translationEnabled
            ? _('Disable Translation')
            : _('Enable Translation')
          : _('Translation Disabled')
      }
    ></Button>
  );
};

export default TranslationToggler;
