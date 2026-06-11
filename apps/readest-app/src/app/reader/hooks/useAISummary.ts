import { useCallback } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useOpenAIInNotebook } from './useOpenAIInNotebook';
import { summarizeChapter, recapToPosition } from '@/services/ai/summaryService';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';

export function useAISummary(bookKey: string) {
  const _ = useTranslation();
  const { getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();
  const { addMessage } = useAIChatStore();
  const { openAIInNotebook } = useOpenAIInNotebook();

  const run = useCallback(
    async (kind: 'recap' | 'chapter') => {
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

      try {
        const args = {
          bookDoc,
          bookHash: book.hash,
          bookTitle: book.title,
          aiSettings: settings.aiSettings,
        };
        const text =
          kind === 'recap'
            ? await recapToPosition({ ...args, currentSectionIndex: sectionIndex })
            : await summarizeChapter({ ...args, sectionIndex });
        await addMessage({ conversationId, role: 'assistant', content: text });
      } catch (e) {
        if ((e as Error).message === 'AI_NOT_CONFIGURED') {
          eventDispatcher.dispatch('toast', {
            type: 'warning',
            message: _('Configure an AI provider in Settings → AI Assistant first'),
          });
          return;
        }
        await addMessage({
          conversationId,
          role: 'assistant',
          content: _('Summary failed. Please try again.'),
        });
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
