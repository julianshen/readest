'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Markdown } from '@copilotkit/react-ui';
import { streamText } from 'ai';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { eventDispatcher } from '@/utils/event';
import { aiLogger } from '@/services/ai';
import {
  LegacyIdbBackend,
  ReedyBackend,
  TauriRustBackend,
  selectBackend,
  type RetrievalBackend,
} from '@/services/ai/adapters';
import type { EmbeddingProgress } from '@/services/ai/types';
import { useEnv } from '@/context/EnvContext';
import { isTauriAppPlatform } from '@/services/environment';
import type { AppService } from '@/types/system';
import { getAIProvider } from '@/services/ai/providers';
import { buildSystemPrompt } from '@/services/ai/prompts';

import { ReedyAssistant } from '@/services/reedy/ui/ReedyAssistant';
import type { ReadingContextSnapshot } from '@/services/reedy/tools/builtins/types';

import { Button } from '@/components/ui/button';
import {
  Loader2Icon,
  BookOpenIcon,
  SendHorizonalIcon,
  SparklesIcon,
  StopCircleIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CopilotAIAssistantProps {
  bookKey: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const CopilotAIAssistant = ({ bookKey }: CopilotAIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const bookData = getBookData(bookKey);

  const useAgentRuntime =
    settings?.aiSettings?.reedy?.enabled === true &&
    settings?.aiSettings?.reedy?.runtime === 'agent' &&
    !!appService &&
    isTauriAppPlatform() &&
    !!bookData?.bookDoc;

  if (useAgentRuntime) {
    return <ReedyAgentAssistantBridge bookKey={bookKey} />;
  }

  return <CopilotMvpAssistant bookKey={bookKey} />;
};

// ---------------------------------------------------------------------------
// MVP chat assistant — CopilotKit Markdown + custom chat state
// ---------------------------------------------------------------------------

const CopilotMvpAssistant = ({ bookKey }: CopilotAIAssistantProps) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { getProgress } = useReaderStore();
  const { conversations, loadConversations, pendingPrompt, setPendingPrompt } = useAIChatStore();
  const bookData = getBookData(bookKey);
  const progress = getProgress(bookKey);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<EmbeddingProgress | null>(null);
  const [indexed, setIndexed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const deferredPromptRef = useRef<string | null>(null);
  const sendMessageRef = useRef<((text: string) => Promise<void>) | null>(null);

  const bookHash = bookKey.split('-')[0] || '';
  const bookTitle = bookData?.book?.title || 'Unknown';
  const authorName = bookData?.book?.author || '';
  const currentPage = progress?.pageinfo?.current ?? 0;
  const aiSettings = settings?.aiSettings;

  const backend = useMemo<RetrievalBackend | null>(() => {
    if (!aiSettings) {
      console.error('[CopilotAIAssistant] aiSettings is null; backend unavailable');
      return null;
    }
    const isTauri = isTauriAppPlatform();
    console.log(
      '[CopilotAIAssistant] platform=',
      isTauri ? 'tauri' : 'web',
      'aiSettings.provider=',
      aiSettings.provider,
    );
    const legacy = new LegacyIdbBackend(aiSettings);
    const tauriRust: RetrievalBackend | null =
      appService && isTauri ? new TauriRustBackend(aiSettings) : null;
    const reedy: RetrievalBackend | null =
      appService && isTauri ? new ReedyBackend(appService as AppService, aiSettings) : null;
    const selected = selectBackend({
      settings: aiSettings,
      isTauri,
      tauriRust,
      legacy,
      reedy,
    });
    console.log('[CopilotAIAssistant] selected backend=', selected?.kind);
    return selected;
  }, [aiSettings, appService]);

  const handleIndex = useCallback(async () => {
    if (!bookData?.bookDoc) {
      console.error('[CopilotAIAssistant] handleIndex: bookDoc missing');
      return;
    }
    if (!aiSettings) {
      console.error('[CopilotAIAssistant] handleIndex: aiSettings missing');
      return;
    }
    if (!backend) {
      console.error('[CopilotAIAssistant] handleIndex: backend missing');
      return;
    }
    setIsIndexing(true);
    try {
      await backend.indexBook(bookData.bookDoc, bookHash, { onProgress: setIndexProgress });
      setIndexed(true);
      // Send any deferred prompt now that the book is indexed.
      if (deferredPromptRef.current) {
        const p = deferredPromptRef.current;
        deferredPromptRef.current = null;
        sendMessageRef.current?.(p);
      }
    } catch (e) {
      const msg = (e as Error).message;
      aiLogger.rag.indexError(bookHash, msg);
      console.error('[CopilotAIAssistant] indexBook failed:', msg);
      eventDispatcher.dispatch('toast', { message: `${_('Indexing failed')}: ${msg}` });
    } finally {
      setIsIndexing(false);
      setIndexProgress(null);
    }
  }, [bookData?.bookDoc, bookHash, aiSettings, backend, _]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text || !aiSettings || isGenerating) return;

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      };

      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsGenerating(true);

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const provider = getAIProvider(aiSettings);
        const model = provider.getModel();
        const systemPrompt = buildSystemPrompt(bookTitle, authorName, [], currentPage);

        let chunks = '';
        if (backend && (await backend.isIndexed(bookHash))) {
          try {
            const results =
              (await backend.searchForSystemPrompt?.(text, bookHash, {
                topK: aiSettings.maxContextChunks || 5,
                spoilerBoundPosition: aiSettings.spoilerProtection ? currentPage : undefined,
              })) ?? [];
            chunks = results.map((c) => c.text).join('\n\n');
          } catch (e) {
            aiLogger.chat.error(`RAG failed: ${(e as Error).message}`);
          }
        }

        const finalSystem = chunks
          ? `${systemPrompt}\n\nRelevant passages from the book:\n${chunks}`
          : systemPrompt;

        const result = streamText({
          model,
          system: finalSystem,
          messages: [{ role: 'user' as const, content: text }],
          abortSignal: abortController.signal,
        });

        let accumulated = '';
        for await (const part of result.textStream) {
          accumulated += part;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = { ...last, content: accumulated };
            }
            return next;
          });
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          aiLogger.chat.error(`Chat failed: ${(e as Error).message}`);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last && last.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                content: `${_('Error: ')}${(e as Error).message}`,
              };
            }
            return next;
          });
        }
      } finally {
        setIsGenerating(false);
        abortRef.current = null;
      }
    },
    [input, aiSettings, bookTitle, authorName, currentPage, backend, bookHash, isGenerating, _],
  );
  sendMessageRef.current = sendMessage;

  const handleSend = useCallback(() => {
    sendMessage(input.trim());
    setInput('');
  }, [sendMessage, input]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setIsGenerating(false);
    abortRef.current = null;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // ---- Check index status and load conversations ----
  useEffect(() => {
    if (bookHash) loadConversations(bookHash);
    if (bookHash && backend) {
      backend
        .isIndexed(bookHash)
        .then((result) => {
          setIndexed(result);
          setIsLoading(false);
          // If a deferred prompt is waiting and book is already indexed,
          // send it immediately without waiting.
          if (deferredPromptRef.current && result) {
            const p = deferredPromptRef.current;
            deferredPromptRef.current = null;
            sendMessageRef.current?.(p);
          }
          // If not indexed and prompt is waiting, auto-index.
          if (deferredPromptRef.current && !result) {
            handleIndex();
          }
        })
        .catch(() => {
          setIsLoading(false);
        });
    } else if (!backend) {
      setIsLoading(false);
      // No RAG backend — send deferred prompt directly.
      if (deferredPromptRef.current) {
        const p = deferredPromptRef.current;
        deferredPromptRef.current = null;
        sendMessageRef.current?.(p);
      }
    } else {
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookHash, backend, loadConversations]);

  // ---- Consume pending prompt from store (e.g. AI Summary) ----
  useEffect(() => {
    if (pendingPrompt && !isGenerating) {
      const p = pendingPrompt;
      setPendingPrompt(null);

      if (isLoading) {
        // Don't know index state yet — the index-check effect will
        // pick this up once loading completes.
        deferredPromptRef.current = p;
      } else if (!indexed && backend) {
        // Not indexed — auto-index, then the prompt fires after.
        deferredPromptRef.current = p;
        handleIndex();
      } else {
        // Already indexed or no backend — send immediately.
        sendMessage(p);
      }
    }
  }, [
    pendingPrompt,
    isGenerating,
    sendMessage,
    setPendingPrompt,
    indexed,
    isLoading,
    backend,
    handleIndex,
  ]);

  // ---- Guard: AI not enabled ----
  if (!aiSettings?.enabled) {
    return (
      <div className='flex h-full items-center justify-center p-4'>
        <p className='text-muted-foreground text-sm'>{_('Enable AI in Settings')}</p>
      </div>
    );
  }

  if (isLoading) return null;

  const progressPercent =
    indexProgress?.phase === 'embedding' && indexProgress.total > 0
      ? Math.round((indexProgress.current / indexProgress.total) * 100)
      : 0;

  // ---- Not yet indexed, no existing conversations ----
  if (!indexed && !isIndexing && conversations.length === 0) {
    const canIndex = Boolean(bookData?.bookDoc && aiSettings && backend);
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
        <div className='bg-primary/10 rounded-full p-3'>
          <BookOpenIcon className='text-primary size-6' />
        </div>
        <div>
          <h3 className='text-foreground mb-0.5 text-sm font-medium'>{_('Index This Book')}</h3>
          <p className='text-muted-foreground text-xs'>
            {_('Enable AI search and chat for this book')}
          </p>
        </div>
        {!canIndex && (
          <p className='text-error text-xs'>
            {!aiSettings
              ? _('AI settings not loaded. Please configure AI in Settings.')
              : !backend
                ? _('Backend unavailable. Restart the app or check Settings.')
                : _('Book document not ready. Please wait or reopen the book.')}
          </p>
        )}
        <Button onClick={handleIndex} size='sm' className='h-8 text-xs' disabled={!canIndex}>
          <BookOpenIcon className='mr-1.5 size-3.5' />
          {_('Start Indexing')}
        </Button>
      </div>
    );
  }

  // ---- Indexing in progress ----
  if (isIndexing) {
    return (
      <div className='flex h-full flex-col items-center justify-center gap-3 p-4 text-center'>
        <Loader2Icon className='text-primary size-6 animate-spin' />
        <div>
          <p className='text-foreground mb-1 text-sm font-medium'>{_('Indexing book...')}</p>
          <p className='text-muted-foreground text-xs'>
            {indexProgress?.phase === 'embedding'
              ? `${indexProgress.current} / ${indexProgress.total} chunks`
              : _('Preparing...')}
          </p>
        </div>
        <div className='bg-muted h-1.5 w-32 overflow-hidden rounded-full'>
          <div
            className='bg-primary h-full transition-all duration-300'
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    );
  }

  // ---- Chat interface ----
  return (
    <div className='flex h-full flex-col'>
      <ChatMessages
        messages={messages}
        isGenerating={isGenerating}
        onStop={handleStop}
        bookTitle={bookTitle}
      />
      <ChatInput
        input={input}
        setInput={setInput}
        onSend={handleSend}
        isGenerating={isGenerating}
        onKeyDown={handleKeyDown}
        inputRef={inputRef}
        placeholder={_('Ask about this book...')}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Chat message list
// ---------------------------------------------------------------------------

const ChatMessages = ({
  messages,
  isGenerating,
  onStop,
  bookTitle,
}: {
  messages: ChatMessage[];
  isGenerating: boolean;
  onStop: () => void;
  bookTitle: string;
}) => {
  const _ = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center'>
        <div className='bg-primary/10 rounded-full p-3'>
          <SparklesIcon className='text-primary size-6' />
        </div>
        <p className='text-muted-foreground max-w-xs text-xs leading-relaxed'>
          {_(
            'Ask questions about "{{bookTitle}}" and get AI-powered answers with relevant passages.',
            { bookTitle },
          )}
        </p>
      </div>
    );
  }

  return (
    <div className='flex-1 space-y-4 overflow-y-auto p-4'>
      {messages.map((msg) => (
        <div key={msg.id} className='group'>
          {msg.role === 'user' ? (
            <div className='flex justify-end'>
              <div className='bg-primary/10 text-foreground max-w-[85%] rounded-2xl px-4 py-2.5 text-sm'>
                {msg.content}
              </div>
            </div>
          ) : (
            <div className='flex items-start gap-2'>
              <div className='bg-muted flex size-7 shrink-0 items-center justify-center rounded-full'>
                <SparklesIcon className='text-primary size-3.5' />
              </div>
              <div className='text-foreground min-w-0 flex-1 text-sm leading-relaxed'>
                {msg.content ? (
                  <Markdown content={msg.content} />
                ) : (
                  <span className='text-muted-foreground italic'>...</span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}

      {isGenerating && (
        <div className='flex justify-center'>
          <button
            onClick={onStop}
            className='bg-muted text-muted-foreground hover:bg-muted/80 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors'
          >
            <StopCircleIcon className='size-3.5' />
            {_('Stop')}
          </button>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Chat input
// ---------------------------------------------------------------------------

const ChatInput = ({
  input,
  setInput,
  onSend,
  isGenerating,
  onKeyDown,
  inputRef,
  placeholder,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  isGenerating: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
}) => {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      // Auto-resize
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
      }
    },
    [setInput, inputRef],
  );

  return (
    <div className='border-border/40 bg-background flex-shrink-0 border-t p-3'>
      <div className='border-border/60 bg-muted/50 flex items-end gap-2 rounded-xl border p-2'>
        <textarea
          ref={inputRef}
          value={input}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={isGenerating}
          className='placeholder:text-muted-foreground/50 max-h-[160px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-0.5 text-sm outline-none disabled:opacity-50'
        />
        <button
          onClick={onSend}
          disabled={!input.trim() || isGenerating}
          className='bg-primary text-primary-foreground hover:bg-primary/90 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-40'
        >
          <SendHorizonalIcon className='size-4' />
        </button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Reedy agent bridge (Phase 4)
// ---------------------------------------------------------------------------

const ReedyAgentAssistantBridge = ({ bookKey }: CopilotAIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { getProgress, getView } = useReaderStore();
  const bookData = getBookData(bookKey);
  const progress = getProgress(bookKey);

  const bookHash = bookKey.split('-')[0] || '';
  const aiSettings = settings?.aiSettings;

  const readingContext = useMemo<ReadingContextSnapshot>(
    () => ({
      cfi: progress?.location ?? null,
      sectionIndex: progress?.section?.current ?? 0,
      chapterTitle: progress?.sectionLabel ?? null,
      pageNumber: progress?.pageinfo?.current ?? 0,
    }),
    [progress],
  );

  const handleNavigate = useCallback(
    (cfi: string) => {
      getView(bookKey)?.goTo(cfi);
    },
    [bookKey, getView],
  );

  if (!aiSettings || !appService || !bookData?.bookDoc) return null;

  return (
    <ReedyAssistant
      appService={appService as AppService}
      bookDoc={bookData.bookDoc}
      bookHash={bookHash}
      bookKey={bookKey}
      aiSettings={aiSettings}
      readingContext={readingContext}
      onNavigateToCfi={handleNavigate}
    />
  );
};

export { CopilotAIAssistant, ReedyAgentAssistantBridge };
export default CopilotAIAssistant;
