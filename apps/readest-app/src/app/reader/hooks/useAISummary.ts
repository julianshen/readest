import { useCallback, useRef } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useOpenAIInNotebook } from './useOpenAIInNotebook';
import { summarizeChapter, recapToPosition, SummaryErrorCodes } from '@/services/ai/summaryService';
import { eventDispatcher } from '@/utils/event';
import { getLocale } from '@/utils/misc';
import { useTranslation } from '@/hooks/useTranslation';

export function useAISummary(bookKey: string) {
  const _ = useTranslation();
  const { getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { addMessage } = useAIChatStore();
  const { openAIInNotebook } = useOpenAIInNotebook();
  const busyRef = useRef(false);

  const run = useCallback(
    async (kind: 'recap' | 'chapter') => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const bookData = getBookData(bookKey);
        const bookDoc = bookData?.bookDoc;
        const book = bookData?.book;
        const progress = getProgress(bookKey);
        const sectionIndex = progress?.index ?? 0;
        if (!bookDoc || !book) return;

        const title =
          kind === 'recap'
            ? `${_('Recap')} — ${book.title}`
            : `${_('Chapter Summary')} — ${book.title}`;
        const conversationId = await openAIInNotebook({
          bookHash: book.hash,
          newConversationTitle: title,
        });
        if (!conversationId) return;

        eventDispatcher.dispatch('toast', {
          type: 'info',
          message:
            kind === 'recap'
              ? _('Generating recap — this may take a minute...')
              : _('Summarizing chapter — this may take a moment...'),
        });

        try {
          const aiSettings = useSettingsStore.getState().settings.aiSettings;
          const args = {
            bookDoc,
            bookHash: book.hash,
            bookTitle: book.title,
            uiLanguage: getLocale(),
            aiSettings,
          };
          const text =
            kind === 'recap'
              ? await recapToPosition({ ...args, currentSectionIndex: sectionIndex })
              : await summarizeChapter({ ...args, sectionIndex });
          await addMessage({ conversationId, role: 'assistant', content: text });
        } catch (e) {
          if ((e as Error).message === SummaryErrorCodes.NOT_CONFIGURED) {
            eventDispatcher.dispatch('toast', {
              type: 'warning',
              message: _('Configure an AI provider in Settings → AI Assistant first'),
            });
            return;
          }
          if ((e as Error).message === SummaryErrorCodes.NOTHING_TO_RECAP) {
            await addMessage({
              conversationId,
              role: 'assistant',
              content: _("You're at the very beginning — nothing to recap yet."),
            });
            return;
          }
          // CHAPTER_UNREADABLE and provider failures both land here by design
          await addMessage({
            conversationId,
            role: 'assistant',
            content: _('Summary failed. Please try again.'),
          });
        }
      } finally {
        busyRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookKey],
  );

  return {
    runRecap: () => run('recap'),
    runChapterSummary: () => run('chapter'),
  };
}
