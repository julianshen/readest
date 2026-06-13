import { useCallback, useRef } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useNotebookStore } from '@/store/notebookStore';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';

const PROMPTS: Record<string, string> = {
  recap:
    'Please recap what I have read so far in this book, covering the story up to where I am now. Write a flowing narrative — key events, character developments, and where we left off.',
  chapter:
    'Please provide a concise summary of the chapter I am currently reading. Cover the key events, characters, and important details in the order they occur.',
};

export function useAISummary(bookKey: string) {
  const _ = useTranslation();
  const { getProgress } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const { setNotebookVisible, setNotebookActiveTab } = useNotebookStore();
  const busyRef = useRef(false);

  const run = useCallback(
    async (kind: 'recap' | 'chapter') => {
      if (busyRef.current) return;
      busyRef.current = true;
      try {
        const bookData = getBookData(bookKey);
        const book = bookData?.book;
        const progress = getProgress(bookKey);
        const sectionIndex = progress?.index ?? 0;

        if (!book) {
          busyRef.current = false;
          return;
        }

        // If at the very beginning, there's nothing to recap
        if (kind === 'recap' && sectionIndex <= 0) {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            message: _("You're at the very beginning \u2014 nothing to recap yet."),
          });
          return;
        }

        // Open the notebook panel
        setNotebookVisible(true);
        setNotebookActiveTab('ai');

        // Dispatch an event that the AI chat component listens for.
        // The component injects the prompt as a user message and the AI
        // responds naturally through the streaming chat flow.
        eventDispatcher.dispatch('ai-assistant-request', {
          prompt: PROMPTS[kind],
        });
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
