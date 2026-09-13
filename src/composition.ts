import * as CordisModule from "cordis";
import { AppConfig, Env, loadConfig } from "./config.js";
import {
  systemClock,
  type Clock,
  type PdfReaderPort,
  type UploadStore,
} from "./application/ports.js";
import type { IdGenerator } from "./domain/ids.js";
import { FileSystemDataPaths } from "./infrastructure/fs/paths.js";
import { FileSystemCatalogStore } from "./infrastructure/fs/catalog-store.js";
import { FileSystemNoteStore } from "./infrastructure/fs/note-store.js";
import { FileSystemUploadStore } from "./infrastructure/fs/upload-store.js";
import { createPdfjsReader } from "./infrastructure/pdf/index.js";
import { createLlmProviderFromEnv } from "./llm/index.js";
import { LibraryService } from "./application/library-service.js";
import { NoteService } from "./application/note-service.js";
import { ReadingService } from "./application/reading-service.js";
import { ReconciliationService } from "./application/reconciliation-service.js";
import { ConversationStore } from "./conversations/conversation-store.js";
import { PaperAgent } from "./agent/paper-agent.js";
import { defaultIdGenerator } from "./domain/ids.js";
import type { LlmProvider } from "./application/ports.js";

export interface ComposedServices {
  config: AppConfig;
  paths: FileSystemDataPaths;
  clock: Clock;
  catalog: FileSystemCatalogStore;
  notes: FileSystemNoteStore;
  uploads: UploadStore;
  pdf: PdfReaderPort;
  llm: LlmProvider;
  library: LibraryService;
  noteService: NoteService;
  reading: ReadingService;
  reconciliation: ReconciliationService;
  conversations: ConversationStore;
  agent: PaperAgent;
}

export interface ComposeOverrides {
  env?: Env;
  config?: AppConfig;
  pdf?: PdfReaderPort;
  llm?: LlmProvider;
  clock?: Clock;
  ids?: IdGenerator;
}

export interface Composition {
  ctx: CordisContext;
  services: ComposedServices;
  dispose(): Promise<void>;
}

interface CordisContext {
  provide(name: string, value: unknown): unknown;
  get(name: string): unknown;
  set(name: string, value: unknown): void;
  plugin(plugin: (ctx: CordisContext) => unknown, config?: unknown): unknown;
  fiber: { dispose(): Promise<void> };
}

const ContextCtor = (CordisModule as unknown as { Context: new () => CordisContext }).Context;

export async function compose(overrides: ComposeOverrides = {}): Promise<Composition> {
  const env = overrides.env ?? process.env;
  const config = overrides.config ?? loadConfig(env);
  const ctx = new ContextCtor();
  const clock = overrides.clock ?? systemClock;
  const ids = overrides.ids ?? defaultIdGenerator;
  const paths = new FileSystemDataPaths(config.dataRoot);
  const catalog = new FileSystemCatalogStore(paths);
  const notes = new FileSystemNoteStore(paths);
  const uploads = new FileSystemUploadStore(paths, () => clock.now());
  const pdf = overrides.pdf ?? createPdfjsReader();
  const llm = overrides.llm ?? createLlmProviderFromEnv(env);
  const library = new LibraryService({ catalog, notes, uploads, pdf, paths, clock, ids });
  const noteService = new NoteService({ catalog, notes, clock });
  const reading = new ReadingService({ catalog, pdf, library, limits: config.pdf });
  const reconciliation = new ReconciliationService({ paths, catalog, notes, clock });
  const conversations = new ConversationStore({ paths, clock, ids: { conversationId: () => `cnv_${ids.paperId().slice(4)}` } });
  const agent = new PaperAgent({
    provider: llm,
    conversations,
    services: { library, notes: noteService, reading, reconciliation },
    model: config.llm.model,
  });

  const services: ComposedServices = {
    config,
    paths,
    clock,
    catalog,
    notes,
    uploads,
    pdf,
    llm,
    library,
    noteService,
    reading,
    reconciliation,
    conversations,
    agent,
  };

  for (const [name, value] of Object.entries(services)) {
    ctx.provide(name, value);
  }
  await (ctx.plugin((pluginCtx) => {
    pluginCtx.provide("composition/ready", true);
  }) as Promise<unknown>);

  return {
    ctx,
    services,
    dispose: async () => {
      await ctx.fiber.dispose();
    },
  };
}
