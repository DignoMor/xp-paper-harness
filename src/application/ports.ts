import type { Readable } from "node:stream";
import type { PaperMetadata } from "../domain/paper.js";
import type { Catalog } from "../domain/catalog.js";
import type { AttachmentId, PaperId, UploadId } from "../domain/ids.js";
import type { ManagedFrontmatter, ParsedNote } from "../domain/note.js";

export interface Clock {
  now(): Date;
  isoNow(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

export interface CatalogStore {
  load(): Promise<Catalog>;
  save(catalog: Catalog): Promise<void>;
  exists(): Promise<boolean>;
  readRaw(): Promise<string | null>;
  transact<T>(
    mutator: (current: Catalog) => Promise<{ catalog: Catalog; result: T }> | { catalog: Catalog; result: T },
  ): Promise<T>;
}

export interface NoteStore {
  read(paperId: PaperId): Promise<ParsedNote | null>;
  write(paperId: PaperId, managed: ManagedFrontmatter, body: string, expectedRaw: string | null): Promise<ParsedNote>;
  exists(paperId: PaperId): Promise<boolean>;
  listPaperIds(): Promise<PaperId[]>;
  remove(paperId: PaperId): Promise<void>;
}

export interface StagedUpload {
  upload_id: UploadId;
  original_filename: string;
  media_type: string;
  byte_size: number;
  staged_at: string;
  path: string;
}

export interface UploadStore {
  stage(
    uploadId: UploadId,
    source: Readable,
    opts: { originalFilename: string; mediaType: string; maxBytes: number },
  ): Promise<StagedUpload>;
  get(uploadId: UploadId): Promise<StagedUpload | null>;
  readBytes(uploadId: UploadId): Promise<Uint8Array | null>;
  remove(uploadId: UploadId): Promise<void>;
  purgeExpired(maxAgeMs: number): Promise<number>;
  list(): Promise<StagedUpload[]>;
}

export type PdfExtractionStatus =
  | "ok"
  | "unreadable"
  | "encrypted"
  | "image_only"
  | "oversized"
  | "corrupt";

export interface PdfPage {
  page: number;
  text: string;
}

export interface PdfExtraction {
  status: PdfExtractionStatus;
  page_count: number | null;
  pages: PdfPage[];
  embedded_title: string | null;
  metadata?: Partial<PaperMetadata>;
  truncated: { bytes: boolean; pages: boolean; chars: boolean };
  continuation: { next_page: number } | null;
  error: string | null;
}

export interface PdfReadOptions {
  pages?: number[];
  maxBytes?: number;
  maxPages?: number;
  maxChars?: number;
}

export interface PdfReaderPort {
  extract(bytes: Uint8Array, options?: PdfReadOptions): Promise<PdfExtraction>;
}

export interface DataPaths {
  readonly root: string;
  catalogFile(): string;
  papersDir(): string;
  attachmentsDir(paperId: PaperId): string;
  attachmentFile(paperId: PaperId, attachmentId: AttachmentId): string;
  notesDir(): string;
  noteFile(paperId: PaperId): string;
  sessionsDir(): string;
  sessionFile(conversationId: string): string;
  uploadsDir(): string;
  tmpDir(): string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmChatRequest {
  model: string;
  session_id: string;
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  signal?: AbortSignal;
}

export type LlmEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: LlmToolCall }
  | { type: "done"; finish_reason: string }
  | { type: "error"; code: string; message: string };

export interface LlmProvider {
  readonly name: string;
  readonly defaultModel: string;
  stream(request: LlmChatRequest): AsyncIterable<LlmEvent>;
}
