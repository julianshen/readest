import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface OcrModelProgress {
  file: string;
  received: number;
  total: number;
}

// Serialize model downloads process-wide. `BooksGrid` mounts one
// `AutoBubblePageTranslator` per open book, and every language shares the
// detector file, so concurrent `ensure` calls would race on the same
// partial-download (`.part`) file. Chaining runs them one at a time regardless
// of which component (or how many) invoked the download.
let ensureChain: Promise<unknown> = Promise.resolve();

export const ensureOcrModels = (lang: string): Promise<void> => {
  const next = ensureChain.then(() => invoke<void>('ensure_ocr_models', { lang }));
  // A failed download must not wedge the chain for the next caller.
  ensureChain = next.catch(() => {});
  return next;
};

export const ocrModelsPresent = (lang: string): Promise<boolean> =>
  invoke<boolean>('ocr_models_present', { lang });

export const onOcrModelProgress = (cb: (p: OcrModelProgress) => void): Promise<UnlistenFn> =>
  listen<OcrModelProgress>('ocr-model-download', (e) => cb(e.payload));
