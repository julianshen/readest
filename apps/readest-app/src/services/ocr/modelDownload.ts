import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface OcrModelProgress {
  file: string;
  received: number;
  total: number;
}

export const ensureOcrModels = (lang: string): Promise<void> =>
  invoke('ensure_ocr_models', { lang });

export const onOcrModelProgress = (cb: (p: OcrModelProgress) => void): Promise<UnlistenFn> =>
  listen<OcrModelProgress>('ocr-model-download', (e) => cb(e.payload));
