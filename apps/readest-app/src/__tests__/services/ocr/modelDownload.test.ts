import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const listen = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { ensureOcrModels, onOcrModelProgress } from '@/services/ocr/modelDownload';

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
