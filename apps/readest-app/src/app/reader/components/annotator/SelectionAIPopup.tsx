'use client';

import React, { useState } from 'react';
import { PiSparkle } from 'react-icons/pi';
import { FiCopy } from 'react-icons/fi';
import Popup from '@/components/Popup';
import { Position, TextSelection } from '@/utils/sel';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getLocale } from '@/utils/misc';
import { eventDispatcher } from '@/utils/event';
import {
  runSelectionAction,
  SelectionAction,
  SelectionErrorCodes,
} from '@/services/ai/selectionAIService';

interface SelectionAIPopupProps {
  bookKey: string;
  selection: TextSelection;
  position: Position;
  trianglePosition: Position;
  popupWidth: number;
  popupHeight: number;
  onDismiss: () => void;
}

const ACTIONS: { key: SelectionAction; label: string }[] = [
  { key: 'explain', label: 'Explain' },
  { key: 'simplify', label: 'Simplify' },
  { key: 'define', label: 'Define' },
];

const SelectionAIPopup: React.FC<SelectionAIPopupProps> = ({
  bookKey,
  selection,
  position,
  trianglePosition,
  popupWidth,
  popupHeight,
  onDismiss,
}) => {
  const _ = useTranslation();
  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();
  const [active, setActive] = useState<SelectionAction | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState(false);

  const run = async (action: SelectionAction) => {
    const bookData = getBookData(bookKey);
    const bookDoc = bookData?.bookDoc;
    if (!bookDoc) return;
    setActive(action);
    setAnswer('');
    setError('');
    setStreaming(true);
    try {
      const stream = runSelectionAction(action, {
        bookDoc,
        sectionIndex: selection.index,
        selectedText: selection.text,
        uiLanguage: getLocale(),
        aiSettings: settings.aiSettings,
      });
      for await (const chunk of stream) {
        setAnswer((prev) => prev + chunk);
      }
    } catch (e) {
      setError(
        (e as Error).message === SelectionErrorCodes.NOT_CONFIGURED
          ? _('Configure an AI provider in Settings → AI Assistant first')
          : _("Couldn't generate — try again"),
      );
    } finally {
      setStreaming(false);
    }
  };

  const handleCopy = () => {
    if (answer) navigator.clipboard?.writeText(answer);
    eventDispatcher.dispatch('toast', {
      type: 'info',
      timeout: 2000,
      message: _('Copied'),
    });
  };

  return (
    <div>
      <Popup
        width={popupWidth}
        minHeight={popupHeight}
        position={position}
        trianglePosition={trianglePosition}
        className='select-text flex flex-col bg-base-200'
        triangleClassName='text-base-200'
        onDismiss={onDismiss}
      >
        <div className='flex items-center gap-1 border-b border-base-300 p-2'>
          <PiSparkle className='h-4 w-4 text-base-content/70' />
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              className={`btn btn-ghost btn-xs ${active === a.key ? 'btn-active' : ''}`}
              disabled={streaming}
              onClick={() => run(a.key)}
            >
              {_(a.label)}
            </button>
          ))}
        </div>
        <div className='min-h-12 flex-1 overflow-y-auto p-3 font-sans text-sm text-base-content'>
          {error ? (
            <span className='text-error'>{error}</span>
          ) : active ? (
            <span className='whitespace-pre-wrap'>
              {answer}
              {streaming && <span className='opacity-50'>▍</span>}
            </span>
          ) : (
            <span className='text-base-content/50'>{_('Pick an action above.')}</span>
          )}
        </div>
        {answer && !streaming && (
          <div className='flex justify-end gap-2 border-t border-base-300 p-2'>
            <button className='btn btn-ghost btn-xs' onClick={handleCopy}>
              <FiCopy className='h-3.5 w-3.5' /> {_('Copy')}
            </button>
          </div>
        )}
      </Popup>
    </div>
  );
};

export default SelectionAIPopup;
