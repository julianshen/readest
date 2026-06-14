import clsx from 'clsx';
import React, { useState } from 'react';
import { MdContentCopy, MdClose } from 'react-icons/md';

import { useTranslation } from '@/hooks/useTranslation';
import { BubbleErrorCodes } from '@/services/ai/bubbleTranslationService';

interface Props {
  loading: boolean;
  transcription: string;
  translation: string;
  error: string | null; // a BubbleErrorCodes value or null
  position: { x: number; y: number };
  width: number;
  onDismiss: () => void;
}

const BubbleTranslationPopup: React.FC<Props> = ({
  loading,
  transcription,
  translation,
  error,
  position,
  width,
  onDismiss,
}) => {
  const _ = useTranslation();
  const [showOriginal, setShowOriginal] = useState(false);

  const errorText =
    error === BubbleErrorCodes.NOT_CONFIGURED
      ? _('Configure an AI provider in Settings → AI Assistant first.')
      : error === BubbleErrorCodes.VISION_UNSUPPORTED
        ? _(
            "This model can't read images — choose a vision-capable model in Settings → AI Assistant.",
          )
        : error
          ? _('Translation failed. Please try again.')
          : null;

  const noText = !loading && !error && !translation && !transcription;

  return (
    <div
      className={clsx(
        'bg-base-100 eink-bordered absolute z-50 rounded-lg p-3 shadow-lg',
        'not-eink:border not-eink:border-base-300',
      )}
      style={{ left: position.x, top: position.y, width }}
      data-setting-id='reader.manga-bubble-popup'
    >
      <div className='mb-1 flex items-center justify-between'>
        <span className='text-base-content/60 text-xs'>{_('Bubble Translation')}</span>
        <button
          className='btn btn-ghost btn-xs btn-circle'
          aria-label={_('Close')}
          onClick={onDismiss}
        >
          <MdClose size={14} />
        </button>
      </div>

      {loading && <div className='loading loading-dots loading-sm' />}
      {errorText && <div className='text-error text-sm'>{errorText}</div>}
      {noText && (
        <div className='text-base-content/70 text-sm'>{_('No text detected in this region')}</div>
      )}

      {!loading && !error && translation && (
        <>
          <p className='text-sm leading-relaxed'>{translation}</p>
          <div className='mt-2 flex items-center gap-3'>
            <button
              className='btn btn-ghost btn-xs gap-1'
              onClick={() => navigator.clipboard?.writeText(translation)}
            >
              <MdContentCopy size={13} /> {_('Copy')}
            </button>
            {transcription && (
              <button className='btn btn-ghost btn-xs' onClick={() => setShowOriginal((v) => !v)}>
                {showOriginal ? _('Hide original') : _('Show original')}
              </button>
            )}
          </div>
          {showOriginal && transcription && (
            <p className='text-base-content/70 mt-2 border-t border-base-300 pt-2 text-xs'>
              {transcription}
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default BubbleTranslationPopup;
