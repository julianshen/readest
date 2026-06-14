import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Book } from '@/types/book';

const mockOpen = vi.hoisted(() => vi.fn());
const mockPartialMD5 = vi.hoisted(() => vi.fn());
const mockConvertArchiveToCbz = vi.hoisted(() => vi.fn());

vi.mock('@/utils/md5', async () => {
  const actual = await vi.importActual<typeof import('@/utils/md5')>('@/utils/md5');
  return { ...actual, partialMD5: mockPartialMD5 };
});

vi.mock('@/libs/document', async () => {
  const actual = await vi.importActual<typeof import('@/libs/document')>('@/libs/document');
  class MockDocumentLoader {
    open() {
      return mockOpen();
    }
  }
  return { ...actual, DocumentLoader: MockDocumentLoader };
});

vi.mock('@/utils/comicConvert', () => ({ convertArchiveToCbz: mockConvertArchiveToCbz }));

vi.mock('@/utils/txt', () => ({ TxtToEpubConverter: vi.fn() }));
vi.mock('@/utils/svg', () => ({ svg2png: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@/libs/storage', () => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  createProgressHandler: vi.fn(),
  batchGetDownloadUrls: vi.fn(),
}));

import { BaseAppService } from '@/services/appService';

// Concrete test subclass of BaseAppService with mocked fs
class TestAppService extends BaseAppService {
  protected fs = {
    openFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    removeFile: vi.fn(),
    readDir: vi.fn(),
    createDir: vi.fn(),
    removeDir: vi.fn(),
    exists: vi.fn(),
    stats: vi.fn(),
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn().mockResolvedValue(''),
    getImageURL: vi.fn(),
    getPrefix: vi.fn(),
  };

  protected resolvePath() {
    return { baseDir: 0, basePrefix: async () => '', fp: '', base: 'Books' as const };
  }

  async init() {}
  async setCustomRootDir() {}
  async selectDirectory() {
    return '';
  }
  async selectFiles() {
    return [];
  }
  async saveFile() {
    return false;
  }
  async ask() {
    return false;
  }
  async openDatabase() {
    return {} as ReturnType<BaseAppService['openDatabase']>;
  }
  async createWindow() {}
  async getCacheDir() {
    return '';
  }
  async clearWebviewCache() {}
  async showNotification() {}

  getFs() {
    return this.fs;
  }
}

const TEST_METADATA = {
  title: 'Test Comic',
  author: 'Test Author',
  language: 'en',
  identifier: 'isbn-123',
};

function setupMockBookDoc() {
  const bookDoc = {
    metadata: TEST_METADATA,
    getCover: vi.fn().mockResolvedValue(null),
  };
  mockOpen.mockResolvedValue({ book: bookDoc, format: 'CBZ' });
}

describe('importBook CB7 pre-conversion', () => {
  let service: TestAppService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TestAppService();
    const fs = service.getFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
    mockPartialMD5.mockResolvedValue('comic-hash');
    setupMockBookDoc();
  });

  it('does NOT convert a .cbr file (CBR/RAR unsupported)', async () => {
    const books: Book[] = [];
    const mockFile = new File(['rar content'], 'test.cbr');
    await service.importBook(mockFile, books);

    expect(mockConvertArchiveToCbz).not.toHaveBeenCalled();
  });

  it('converts a .cb7 file to CBZ before import', async () => {
    const books: Book[] = [];
    mockConvertArchiveToCbz.mockResolvedValue(
      new File(['cbz content'], 'test.cbz', { type: 'application/vnd.comicbook+zip' }),
    );

    const mockFile = new File(['7z content'], 'test.cb7');
    await service.importBook(mockFile, books);

    expect(mockConvertArchiveToCbz).toHaveBeenCalledTimes(1);
  });

  it('does NOT convert a .cbz file', async () => {
    const books: Book[] = [];
    const mockFile = new File(['cbz content'], 'test.cbz', {
      type: 'application/vnd.comicbook+zip',
    });
    await service.importBook(mockFile, books);

    expect(mockConvertArchiveToCbz).not.toHaveBeenCalled();
  });

  it('does NOT convert a .epub file', async () => {
    const books: Book[] = [];
    const mockFile = new File(['epub content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    expect(mockConvertArchiveToCbz).not.toHaveBeenCalled();
  });

  it('stores the CONVERTED cbz bytes (not the original archive) for a string-path .cb7 import', async () => {
    const books: Book[] = [];
    const convertedFile = new File(['converted cbz bytes'], 'test.cbz', {
      type: 'application/vnd.comicbook+zip',
    });
    mockConvertArchiveToCbz.mockResolvedValue(convertedFile);

    const fs = service.getFs();
    // String-path import: fs.openFile resolves the original .cb7 into a File.
    fs.openFile.mockResolvedValue(new File(['7z content'], 'test.cb7'));

    const cb7Path = '/path/to/test.cb7';
    const result = await service.importBook(cb7Path, books);

    expect(result).not.toBeNull();
    expect(mockConvertArchiveToCbz).toHaveBeenCalledTimes(1);

    // The original .cb7 path must NEVER be copied into Books — doing so would
    // store raw 7z bytes under the .cbz book filename (the bug).
    const copyFromOriginal = fs.copyFile.mock.calls.find(
      (c: unknown[]) => c[0] === cb7Path && c[3] === 'Books',
    );
    expect(copyFromOriginal).toBeUndefined();

    // The CONVERTED cbz fileobj must be written into Books instead.
    const wroteConverted = fs.writeFile.mock.calls.find(
      (c: unknown[]) => c[1] === 'Books' && c[2] === convertedFile,
    );
    expect(wroteConverted).toBeDefined();
  });

  it('aborts the import when the converter rejects', async () => {
    const books: Book[] = [];
    mockConvertArchiveToCbz.mockRejectedValue(new Error('encrypted archives are not supported'));

    const mockFile = new File(['7z content'], 'locked.cb7');

    // Converter errors propagate (importBook rethrows in its outer catch),
    // surfacing as the standard "failed to import" path. No book is added and
    // DocumentLoader is never reached.
    await expect(service.importBook(mockFile, books)).rejects.toThrow(
      /encrypted archives are not supported/,
    );
    expect(books).toHaveLength(0);
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
