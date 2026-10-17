import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { AppError } from "../domain/errors.js";
import { normalizeDoi } from "../domain/doi.js";
import type { AttachmentId, IdGenerator, PaperId, UploadId } from "../domain/ids.js";
import { isAttachmentId, isPaperId, isUploadId } from "../domain/ids.js";
import { applyAttachmentMetadataPatch, applyPaperMetadataPatch } from "../domain/metadata.js";
import {
  emptyMetadata,
  paperToDetail,
  paperToSummary,
  type AttachmentRecord,
  type ExtractionStatus,
  type PaperDetail,
  type PaperMetadata,
  type PaperRecord,
  type PaperSummary,
} from "../domain/paper.js";
import type { Catalog } from "../domain/catalog.js";
import { CATALOG_SCHEMA_VERSION, validateMetadata } from "../domain/catalog.js";
import type { ParsedNote } from "../domain/note.js";
import type {
  CatalogStore,
  Clock,
  DataPaths,
  NoteStore,
  PdfExtraction,
  PdfReaderPort,
  StagedUpload,
  UploadStore,
} from "./ports.js";
import { atomicWriteFile, ensureDir, removeIfExists, sha256Hex } from "../infrastructure/fs/atomic.js";
import { isNotFound } from "../infrastructure/fs/errors.js";
import { defaultIdGenerator } from "../domain/ids.js";
import { assertKnownKeys, isPlainObject } from "../domain/validate.js";
import { PAPER_METADATA_FIELDS } from "../domain/paper.js";

export interface ImportPaperInput {
  upload_id: string;
  metadata?: Record<string, unknown>;
  mode?: "new" | "attach";
  existing_paper_id?: string;
  expected_revision?: number;
}

export interface AddAttachmentInput {
  upload_id: string;
  paper_id: string;
  expected_revision?: number;
  title?: string;
  description?: string;
}

export interface LibraryServiceDeps {
  catalog: CatalogStore;
  notes: NoteStore;
  uploads: UploadStore;
  pdf: PdfReaderPort;
  paths: DataPaths;
  clock: Clock;
  ids?: IdGenerator;
}

export interface ImportResult {
  paper: PaperDetail;
  note: ParsedNote;
  imported_as: "new_paper" | "attachment";
}

export class LibraryService {
  private readonly ids: IdGenerator;

  constructor(private readonly deps: LibraryServiceDeps) {
    this.ids = deps.ids ?? defaultIdGenerator;
  }

  async getCatalogRevision(): Promise<number> {
    return (await this.deps.catalog.load()).revision;
  }

  async listPapers(): Promise<PaperSummary[]> {
    const catalog = await this.deps.catalog.load();
    return Object.values(catalog.papers)
      .map(paperToSummary)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async getPaper(paperIdRaw: string): Promise<PaperDetail> {
    const paperId = this.requirePaperId(paperIdRaw);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    return { ...paperToDetail(paper), catalog_revision: catalog.revision };
  }

  async getPaperRecord(paperIdRaw: string): Promise<PaperRecord> {
    const paperId = this.requirePaperId(paperIdRaw);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    return paper;
  }

  async readAttachmentBytes(paperIdRaw: string, attachmentIdRaw: string): Promise<Uint8Array> {
    const paperId = this.requirePaperId(paperIdRaw);
    const attachmentId = this.requireAttachmentId(attachmentIdRaw);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    const attachment = paper.attachments[attachmentId];
    if (!attachment) {
      throw new AppError("NOT_FOUND", `Attachment ${attachmentId} was not found.`, {
        paper_id: paperId,
        attachment_id: attachmentId,
      });
    }
    try {
      return new Uint8Array(await readFile(this.deps.paths.attachmentFile(paperId, attachmentId)));
    } catch (error) {
      if (isNotFound(error)) {
        throw new AppError("NOT_FOUND", `Attachment file for ${attachmentId} is missing.`, {
          paper_id: paperId,
          attachment_id: attachmentId,
        });
      }
      throw error;
    }
  }

  async requireStagedUpload(uploadIdRaw: string): Promise<StagedUpload> {
    const uploadId = this.requireUploadId(uploadIdRaw);
    const upload = await this.deps.uploads.get(uploadId);
    if (!upload) {
      throw new AppError("UPLOAD_EXPIRED", `Upload ${uploadId} is no longer available.`, {
        upload_id: uploadId,
      });
    }
    return upload;
  }

  async importPaper(input: ImportPaperInput): Promise<ImportResult> {
    const upload = await this.requireStagedUpload(input.upload_id);
    const uploadId = upload.upload_id;
    const bytes = await this.deps.uploads.readBytes(uploadId);
    if (!bytes) {
      throw new AppError("INVALID_UPLOAD", `Upload ${uploadId} could not be read.`, {
        upload_id: uploadId,
      });
    }
    const sha256 = sha256Hex(bytes);
    const catalog = await this.deps.catalog.load();
    const duplicate = findDuplicateHash(catalog, sha256);
    if (duplicate) {
      throw new AppError(
        "DUPLICATE_HASH",
        "An Attachment with identical content already exists in the Library.",
        {
          sha256,
          paper_id: duplicate.paper_id,
          attachment_id: duplicate.attachment_id,
        },
      );
    }

    const extraction = await this.safeExtract(bytes, { maxPages: 1, maxChars: 5000 });
    const metadata = this.buildImportMetadata(input.metadata, extraction, upload.original_filename);

    const doi = normalizeDoi(metadata.doi);
    if (input.mode === "attach") {
      if (!input.existing_paper_id) {
        throw new AppError(
          "INVALID_INPUT",
          "An explicit existing_paper_id is required to attach to an existing Paper.",
          doi ? { doi } : {},
        );
      }
      return this.attachExisting(input.existing_paper_id, uploadId, bytes, sha256, extraction, {
        title: upload.original_filename,
      }, input.expected_revision);
    }
    if (input.mode !== "new" && doi) {
      const matches = findByDoi(catalog, doi);
      if (matches.length > 0) {
        throw new AppError(
          "DOI_COLLISION",
          "A Paper with the same DOI already exists; choose new_paper or attach.",
          {
            doi,
            candidates: matches.map((m) => ({
              paper_id: m.paper_id,
              title: m.metadata.title,
              doi: m.metadata.doi ?? null,
            })),
          },
        );
      }
    }

    return this.createNewPaper({
      uploadId,
      bytes,
      sha256,
      extraction,
      metadata,
      originalFilename: upload.original_filename,
      expectedRevision: input.expected_revision,
      allowDoiCollision: input.mode === "new",
    });
  }

  async addAttachment(input: AddAttachmentInput): Promise<PaperDetail> {
    const paperId = this.requirePaperId(input.paper_id);
    const upload = await this.requireStagedUpload(input.upload_id);
    const uploadId = upload.upload_id;
    const bytes = await this.deps.uploads.readBytes(uploadId);
    if (!bytes) {
      throw new AppError("INVALID_UPLOAD", `Upload ${uploadId} could not be read.`, {
        upload_id: uploadId,
      });
    }
    const sha256 = sha256Hex(bytes);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    const duplicate = findDuplicateHash(catalog, sha256);
    if (duplicate) {
      throw new AppError(
        "DUPLICATE_HASH",
        "An Attachment with identical content already exists in the Library.",
        { sha256, paper_id: duplicate.paper_id, attachment_id: duplicate.attachment_id },
      );
    }
    const extraction = await this.safeExtract(bytes, { maxPages: 1, maxChars: 5000 });
    const attachmentId = this.ids.attachmentId();
    const now = this.deps.clock.isoNow();
    const attachment = this.buildAttachmentRecord({
      attachmentId,
      paperId,
      sha256,
      byteSize: bytes.byteLength,
      extraction,
      originalFilename: upload.original_filename,
      importedAt: now,
      title: input.title ?? upload.original_filename,
      description: input.description ?? "",
    });
    const filePath = this.deps.paths.attachmentFile(paperId, attachmentId);
    await ensureDir(this.deps.paths.attachmentsDir(paperId));
    await atomicWriteFile(filePath, bytes);
    try {
      await this.deps.catalog.transact((current) => {
        this.assertRevision(current, input.expected_revision);
        this.assertUniqueHash(current, sha256);
        const target = current.papers[paperId];
        if (!target) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
        const updated: PaperRecord = {
          ...target,
          attachments: { ...target.attachments, [attachmentId]: attachment },
          updated_at: now,
        };
        return {
          catalog: {
            ...current,
            revision: current.revision + 1,
            papers: { ...current.papers, [paperId]: updated },
          },
          result: updated,
        };
      });
    } catch (error) {
      await removeIfExists(filePath);
      throw error;
    }
    await this.deps.uploads.remove(uploadId);
    return this.getPaper(paperId);
  }

  async setPrimaryAttachment(
    paperIdRaw: string,
    attachmentIdRaw: string,
    expectedRevision?: number,
  ): Promise<PaperDetail> {
    const paperId = this.requirePaperId(paperIdRaw);
    const attachmentId = this.requireAttachmentId(attachmentIdRaw);
    await this.deps.catalog.transact((current) => {
      this.assertRevision(current, expectedRevision, true);
      const paper = current.papers[paperId];
      if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
      if (!paper.attachments[attachmentId]) {
        throw new AppError("NOT_FOUND", `Attachment ${attachmentId} was not found.`, {
          paper_id: paperId,
          attachment_id: attachmentId,
        });
      }
      const updated: PaperRecord = {
        ...paper,
        primary_attachment_id: attachmentId,
        updated_at: this.deps.clock.isoNow(),
      };
      return {
        catalog: {
          ...current,
          revision: current.revision + 1,
          papers: { ...current.papers, [paperId]: updated },
        },
        result: updated,
      };
    });
    return this.getPaper(paperId);
  }

  async updatePaperMetadata(
    paperIdRaw: string,
    patch: unknown,
    expectedRevision?: number,
  ): Promise<PaperDetail> {
    const paperId = this.requirePaperId(paperIdRaw);
    applyPaperMetadataPatch((await this.getPaperRecord(paperId)).metadata, patch);
    const updated = await this.deps.catalog.transact((current) => {
      this.assertRevision(current, expectedRevision, true);
      const paper = current.papers[paperId];
      if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
      const metadata = applyPaperMetadataPatch(paper.metadata, patch);
      const next: PaperRecord = {
        ...paper,
        metadata,
        updated_at: this.deps.clock.isoNow(),
      };
      return {
        catalog: {
          ...current,
          revision: current.revision + 1,
          papers: { ...current.papers, [paperId]: next },
        },
        result: next,
      };
    });
    await this.syncNoteFrontmatter(updated);
    return this.getPaper(paperId);
  }

  async updateAttachmentMetadata(
    paperIdRaw: string,
    attachmentIdRaw: string,
    patch: unknown,
    expectedRevision?: number,
  ): Promise<PaperDetail> {
    const paperId = this.requirePaperId(paperIdRaw);
    const attachmentId = this.requireAttachmentId(attachmentIdRaw);
    const record = await this.getPaperRecord(paperId);
    const existing = record.attachments[attachmentId];
    if (existing) applyAttachmentMetadataPatch(existing, patch);
    await this.deps.catalog.transact((current) => {
      this.assertRevision(current, expectedRevision, true);
      const paper = current.papers[paperId];
      if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
      const attachment = paper.attachments[attachmentId];
      if (!attachment) {
        throw new AppError("NOT_FOUND", `Attachment ${attachmentId} was not found.`, {
          paper_id: paperId,
          attachment_id: attachmentId,
        });
      }
      const mutable = applyAttachmentMetadataPatch(attachment, patch);
      const nextAttachment: AttachmentRecord = { ...attachment, ...mutable };
      const updated: PaperRecord = {
        ...paper,
        attachments: { ...paper.attachments, [attachmentId]: nextAttachment },
        updated_at: this.deps.clock.isoNow(),
      };
      return {
        catalog: {
          ...current,
          revision: current.revision + 1,
          papers: { ...current.papers, [paperId]: updated },
        },
        result: updated,
      };
    });
    return this.getPaper(paperId);
  }

  private async attachExisting(
    paperIdRaw: string,
    uploadId: UploadId,
    bytes: Uint8Array,
    sha256: string,
    extraction: PdfExtraction,
    opts: { title: string },
    expectedRevision?: number,
  ): Promise<ImportResult> {
    const paperId = this.requirePaperId(paperIdRaw);
    const catalog = await this.deps.catalog.load();
    if (!catalog.papers[paperId]) {
      throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    }
    const detail = await this.addAttachment({
      upload_id: uploadId,
      paper_id: paperId,
      expected_revision: expectedRevision,
      title: opts.title,
    });
    const note = await this.deps.notes.read(paperId);
    if (!note) throw new AppError("NOT_FOUND", `Paper Note for ${paperId} was not found.`, { paper_id: paperId });
    return { paper: detail, note, imported_as: "attachment" };
  }

  private async createNewPaper(input: {
    uploadId: UploadId;
    bytes: Uint8Array;
    sha256: string;
    extraction: PdfExtraction;
    metadata: PaperMetadata;
    originalFilename: string;
    allowDoiCollision: boolean;
    expectedRevision?: number;
  }): Promise<ImportResult> {
    const paperId = this.ids.paperId();
    const attachmentId = this.ids.attachmentId();
    const now = this.deps.clock.isoNow();
    const attachment = this.buildAttachmentRecord({
      attachmentId,
      paperId,
      sha256: input.sha256,
      byteSize: input.bytes.byteLength,
      extraction: input.extraction,
      originalFilename: input.originalFilename,
      importedAt: now,
      title: input.originalFilename,
      description: "",
    });
    const record: PaperRecord = {
      paper_id: paperId,
      metadata: input.metadata,
      attachments: { [attachmentId]: attachment },
      primary_attachment_id: attachmentId,
      created_at: now,
      updated_at: now,
    };
    const filePath = this.deps.paths.attachmentFile(paperId, attachmentId);
    await ensureDir(this.deps.paths.attachmentsDir(paperId));
    await atomicWriteFile(filePath, input.bytes);
    let note: ParsedNote;
    try {
      note = await this.deps.notes.write(
        paperId,
        { paper_id: paperId, title: record.metadata.title, doi: record.metadata.doi },
        "# Notes\n",
        null,
      );
      await this.deps.catalog.transact((current) => {
        this.assertRevision(current, input.expectedRevision);
        this.assertUniqueHash(current, input.sha256);
        const doi = normalizeDoi(input.metadata.doi);
        if (!input.allowDoiCollision && doi && findByDoi(current, doi).length) {
          throw new AppError("DOI_COLLISION", "A matching DOI requires an explicit new or attach choice.", { doi });
        }
        return {
          catalog: {
            schema_version: CATALOG_SCHEMA_VERSION,
            revision: current.revision + 1,
            papers: { ...current.papers, [paperId]: record },
          },
          result: record,
        };
      });
    } catch (error) {
      await removeIfExists(filePath);
      await removeIfExists(this.deps.paths.noteFile(paperId));
      throw error;
    }
    await this.deps.uploads.remove(input.uploadId);
    const detail = await this.getPaper(paperId);
    return { paper: detail, note, imported_as: "new_paper" };
  }

  private async syncNoteFrontmatter(paper: PaperRecord): Promise<void> {
    const note = await this.deps.notes.read(paper.paper_id);
    if (!note) return;
    const managed = {
      paper_id: paper.paper_id,
      title: paper.metadata.title,
      doi: paper.metadata.doi,
    };
    await this.deps.notes.write(paper.paper_id, managed, note.body, note.raw);
  }

  private buildImportMetadata(
    input: Record<string, unknown> | undefined,
    extraction: PdfExtraction,
    originalFilename: string,
  ): PaperMetadata {
    const fallback = titleFromFilename(originalFilename);
    const metadata = emptyMetadata(fallback);
    if (input !== undefined) this.applyMetadataInput(metadata, input);
    const extracted = { title: extraction.embedded_title, ...extraction.metadata };
    const draft = { ...metadata } as Record<string, unknown>;
    for (const field of PAPER_METADATA_FIELDS) {
      const supplied = input?.[field];
      const empty = supplied === undefined || supplied === null ||
        (typeof supplied === "string" && supplied.trim() === "") ||
        (Array.isArray(supplied) && supplied.length === 0);
      const value = extracted[field as keyof typeof extracted];
      if (empty && value !== undefined && value !== null && value !== "") draft[field] = typeof value === "string" ? value.trim() : value;
    }
    if (typeof draft.title !== "string" || draft.title.trim() === "") draft.title = fallback;
    return validateMetadata(draft, "metadata");
  }

  private applyMetadataInput(metadata: PaperMetadata, input: Record<string, unknown>): void {
    if (!isPlainObject(input)) {
      throw new AppError("INVALID_INPUT", "metadata must be an object.", { field: "metadata" });
    }
    assertKnownKeys(input, PAPER_METADATA_FIELDS, "metadata");
    const draft: Record<string, unknown> = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      draft[key] = value;
    }
    const validated = validateMetadata(draft, "metadata");
    Object.assign(metadata, validated);
  }

  private buildAttachmentRecord(input: {
    attachmentId: AttachmentId;
    paperId: PaperId;
    sha256: string;
    byteSize: number;
    extraction: PdfExtraction;
    originalFilename: string;
    importedAt: string;
    title: string;
    description: string;
  }): AttachmentRecord {
    const status = mapExtractionStatus(input.extraction.status);
    return {
      attachment_id: input.attachmentId,
      title: input.title,
      description: input.description,
      original_filename: input.originalFilename,
      media_type: "application/pdf",
      sha256: input.sha256,
      byte_size: input.byteSize,
      imported_at: input.importedAt,
      page_count: input.extraction.page_count,
      extraction_status: status,
      extraction_error: input.extraction.error,
      storage_path: `papers/${input.paperId}/attachments/${input.attachmentId}.pdf`,
    };
  }

  private async safeExtract(bytes: Uint8Array, options: { maxPages: number; maxChars: number }): Promise<PdfExtraction> {
    try {
      return await this.deps.pdf.extract(bytes, options);
    } catch (error) {
      return {
        status: "unreadable",
        page_count: null,
        pages: [],
        embedded_title: null,
        truncated: { bytes: false, pages: false, chars: false },
        continuation: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private assertUniqueHash(catalog: Catalog, hash: string): void {
    const duplicate = findDuplicateHash(catalog, hash);
    if (duplicate) throw new AppError("DUPLICATE_HASH", "An identical Attachment already exists.", duplicate);
  }

  private assertRevision(catalog: Catalog, expected?: number, required = false): void {
    if (expected === undefined && !required) return;
    if (!Number.isSafeInteger(expected) || expected! < 0) {
      throw new AppError("INVALID_INPUT", "A non-negative integer expected_revision is required.", { field: "expected_revision" });
    }
    if (catalog.revision !== expected) {
      throw new AppError("STALE_REVISION", "The catalog revision is stale; reload and retry.", {
        expected_revision: expected,
        current_revision: catalog.revision,
      });
    }
  }

  private requirePaperId(value: string): PaperId {
    if (!isPaperId(value)) {
      throw new AppError("INVALID_ID", `"${value}" is not a valid Paper ID.`, { paper_id: value });
    }
    return value;
  }

  private requireAttachmentId(value: string): AttachmentId {
    if (!isAttachmentId(value)) {
      throw new AppError("INVALID_ID", `"${value}" is not a valid Attachment ID.`, {
        attachment_id: value,
      });
    }
    return value;
  }

  private requireUploadId(value: string): UploadId {
    if (!isUploadId(value)) {
      throw new AppError("INVALID_ID", `"${value}" is not a valid Upload ID.`, {
        upload_id: value,
      });
    }
    return value;
  }
}

export function findDuplicateHash(
  catalog: Catalog,
  sha256: string,
): { paper_id: PaperId; attachment_id: AttachmentId } | null {
  for (const paper of Object.values(catalog.papers)) {
    for (const attachment of Object.values(paper.attachments)) {
      if (attachment.sha256 === sha256) {
        return { paper_id: paper.paper_id, attachment_id: attachment.attachment_id };
      }
    }
  }
  return null;
}

export function findByDoi(catalog: Catalog, normalizedDoi: string): PaperRecord[] {
  return Object.values(catalog.papers).filter(
    (paper) => normalizeDoi(paper.metadata.doi) === normalizedDoi,
  );
}

export function titleFromFilename(filename: string): string {
  const base = basename(filename, extname(filename));
  const cleaned = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned === "" ? "Untitled" : cleaned;
}

function mapExtractionStatus(status: PdfExtraction["status"]): ExtractionStatus {
  switch (status) {
    case "ok":
      return "ok";
    case "encrypted":
      return "encrypted";
    case "image_only":
      return "image_only";
    case "oversized":
      return "oversized";
    case "corrupt":
      return "corrupt";
    default:
      return "unreadable";
  }
}


