import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FileSystemDataPaths } from "../../src/infrastructure/fs/paths.js";
import { FileSystemCatalogStore } from "../../src/infrastructure/fs/catalog-store.js";
import { FileSystemNoteStore } from "../../src/infrastructure/fs/note-store.js";
import { FileSystemUploadStore } from "../../src/infrastructure/fs/upload-store.js";
import { LibraryService } from "../../src/application/library-service.js";
import { NoteService } from "../../src/application/note-service.js";
import { ReadingService } from "../../src/application/reading-service.js";
import { ReconciliationService } from "../../src/application/reconciliation-service.js";
import { ConversationStore } from "../../src/conversations/conversation-store.js";
import { PaperAgent } from "../../src/agent/paper-agent.js";
import { FakeLlmProvider, type FakeHandler, type FakeTurn } from "../../src/llm/fake-provider.js";
import { systemClock } from "../../src/application/ports.js";
import type {
  PdfExtraction,
  PdfReadOptions,
  PdfReaderPort,
  Clock,
} from "../../src/application/ports.js";
import { sha256Hex } from "../../src/infrastructure/fs/atomic.js";
import type { Env } from "../../src/config.js";
import { loadConfig, type AppConfig } from "../../src/config.js";

export class FakePdfReader implements PdfReaderPort {
  private readonly byHash = new Map<string, PdfExtraction>();
  private fallback: PdfExtraction;

  constructor(fallback?: Partial<PdfExtraction>) {
    this.fallback = makeExtraction(fallback);
  }

  register(bytes: Uint8Array, extraction: Partial<PdfExtraction>): void {
    this.byHash.set(sha256Hex(bytes), makeExtraction(extraction));
  }

  setDefault(extraction: Partial<PdfExtraction>): void {
    this.fallback = makeExtraction(extraction);
  }

  async extract(bytes: Uint8Array, _options?: PdfReadOptions): Promise<PdfExtraction> {
    return this.byHash.get(sha256Hex(bytes)) ?? this.fallback;
  }
}

export function makeExtraction(overrides: Partial<PdfExtraction> = {}): PdfExtraction {
  const pages = overrides.pages ?? [{ page: 1, text: "Default fixture text" }];
  return {
    status: overrides.status ?? "ok",
    page_count: overrides.page_count ?? pages.length,
    pages,
    embedded_title: overrides.embedded_title ?? null,
    metadata: overrides.metadata,
    truncated: overrides.truncated ?? { bytes: false, pages: false, chars: false },
    continuation: overrides.continuation ?? null,
    error: overrides.error ?? null,
  };
}

export interface TestHarnessOptions {
  env?: Env;
  pdf?: FakePdfReader;
  clock?: Clock;
  llmScript?: FakeTurn[];
  llmHandler?: FakeHandler;
}

export interface TestHarness {
  dir: string;
  config: AppConfig;
  paths: FileSystemDataPaths;
  catalog: FileSystemCatalogStore;
  noteStore: FileSystemNoteStore;
  uploads: FileSystemUploadStore;
  pdf: FakePdfReader;
  library: LibraryService;
  noteService: NoteService;
  reading: ReadingService;
  reconciliation: ReconciliationService;
  conversations: ConversationStore;
  agent: PaperAgent;
  llm: FakeLlmProvider;
  stage(bytes: Uint8Array, filename?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createTestHarness(options: TestHarnessOptions = {}): Promise<TestHarness> {
  const dir = await mkdtemp(join(tmpdir(), "paper-harness-test-"));
  const config = loadConfig({
    PAPER_HARNESS_DATA_ROOT: dir,
    LLM_PROVIDER: "fake",
    ...options.env,
  });
  const paths = new FileSystemDataPaths(dir);
  const clock = options.clock ?? systemClock;
  const catalog = new FileSystemCatalogStore(paths);
  const noteStore = new FileSystemNoteStore(paths);
  const uploads = new FileSystemUploadStore(paths, () => clock.now());
  const pdf = options.pdf ?? new FakePdfReader();
  const library = new LibraryService({ catalog, notes: noteStore, uploads, pdf, paths, clock });
  const noteService = new NoteService({ catalog, notes: noteStore, clock });
  const reading = new ReadingService({ catalog, pdf, library, limits: config.pdf });
  const reconciliation = new ReconciliationService({ paths, catalog, notes: noteStore, clock });
  const conversations = new ConversationStore({ paths, clock });
  const llm = new FakeLlmProvider({ script: options.llmScript, handler: options.llmHandler as never });
  const agent = new PaperAgent({
    provider: llm,
    conversations,
    services: { library, notes: noteService, reading, reconciliation },
  });

  return {
    dir,
    config,
    paths,
    catalog,
    noteStore,
    uploads,
    pdf,
    library,
    noteService,
    reading,
    reconciliation,
    conversations,
    agent,
    llm,
    async stage(bytes, filename = "paper.pdf") {
      const uploadId = `upl_${(await import("../../src/domain/ids.js")).uuidv7()}`;
      await uploads.stage(uploadId as never, Readable.from([bytes]), {
        originalFilename: filename,
        mediaType: "application/pdf",
        maxBytes: config.upload.maxBytes,
      });
      return uploadId;
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
