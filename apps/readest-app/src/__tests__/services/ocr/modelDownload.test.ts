import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const listen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import {
  ensureOcrModels,
  onOcrModelProgress,
  ocrModelsPresent,
} from '@/services/ocr/modelDownload';

afterEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe('ensureOcrModels', () => {
  it('calls invoke with ensure_ocr_models and the given lang', async () => {
    invoke.mockResolvedValue(undefined);
    await ensureOcrModels('ja');
    expect(invoke).toHaveBeenCalledWith('ensure_ocr_models', { lang: 'ja' });
  });
});

describe('ocrModelsPresent', () => {
  it('calls invoke with ocr_models_present and the given lang, returns the boolean result', async () => {
    invoke.mockResolvedValue(true);
    const result = await ocrModelsPresent('ja');
    expect(invoke).toHaveBeenCalledWith('ocr_models_present', { lang: 'ja' });
    expect(result).toBe(true);
  });

  it('returns false when invoke resolves false', async () => {
    invoke.mockResolvedValue(false);
    const result = await ocrModelsPresent('ja');
    expect(result).toBe(false);
  });
});

describe('onOcrModelProgress', () => {
  it('subscribes to ocr-model-download and forwards payload to callback', async () => {
    const unlisten = vi.fn();
    listen.mockImplementation((_event: string, handler: (e: { payload: unknown }) => void) => {
      handler({ payload: { file: 'model.bin', received: 100, total: 200 } });
      return Promise.resolve(unlisten);
    });

    const cb = vi.fn();
    const un = await onOcrModelProgress(cb);

    expect(listen).toHaveBeenCalledWith('ocr-model-download', expect.any(Function));
    expect(cb).toHaveBeenCalledWith({ file: 'model.bin', received: 100, total: 200 });
    expect(un).toBe(unlisten);
  });
});
