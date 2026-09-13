import { AppError } from "../domain/errors.js";
import type { AttachmentId, PaperId } from "../domain/ids.js";
import { isAttachmentId, isPaperId } from "../domain/ids.js";
import type { AttachmentRecord } from "../domain/paper.js";
import type { CatalogStore, PdfExtraction, PdfReaderPort } from "./ports.js";
import type { LibraryService } from "./library-service.js";

export interface ReadLimits {
  maxBytes: number;
  maxPages: number;
  maxChars: number;
}

export interface ReadPaperInput {
  paper_id: string;
  attachment_id?: string;
  pages?: number[];
}

export interface ReadPaperResult {
  paper_id: PaperId;
  paper_title: string;
  attachment_id: AttachmentId;
  attachment_title: string;
  page_count: number | null;
  status: PdfExtraction["status"];
  pages: Array<{ page: number; text: string }>;
  truncated: PdfExtraction["truncated"];
  continuation: { next_page: number } | null;
  error: string | null;
}

export interface SearchPaperInput {
  paper_id: string;
  query: string;
  attachment_id?: string;
  max_results?: number;
}

export interface SearchHit {
  paper_id: PaperId;
  paper_title: string;
  attachment_id: AttachmentId;
  attachment_title: string;
  page: number;
  snippet: string;
}

export interface SearchPaperResult {
  query: string;
  results: SearchHit[];
  scanned_attachments: number;
}

export interface ReadingServiceDeps {
  catalog: CatalogStore;
  pdf: PdfReaderPort;
  library: LibraryService;
  limits: ReadLimits;
}

export class ReadingService {
  constructor(private readonly deps: ReadingServiceDeps) {}

  async readPaper(input: ReadPaperInput): Promise<ReadPaperResult> {
    const paperId = this.requirePaperId(input.paper_id);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    const attachment = this.resolveAttachment(paper.attachments, paper.primary_attachment_id, input.attachment_id);
    const pages = input.pages;
    if (pages !== undefined) {
      if (!Array.isArray(pages) || pages.some((p) => !Number.isInteger(p) || p < 1)) {
        throw new AppError("INVALID_INPUT", "pages must be an array of positive page numbers.", {
          field: "pages",
        });
      }
    }
    const bytes = await this.deps.library.readAttachmentBytes(paperId, attachment.attachment_id);
    const extraction = await this.deps.pdf.extract(bytes, {
      pages,
      maxBytes: this.deps.limits.maxBytes,
      maxPages: this.deps.limits.maxPages,
      maxChars: this.deps.limits.maxChars,
    });
    return {
      paper_id: paperId,
      paper_title: paper.metadata.title,
      attachment_id: attachment.attachment_id,
      attachment_title: attachment.title,
      page_count: extraction.page_count,
      status: extraction.status,
      pages: extraction.pages,
      truncated: extraction.truncated,
      continuation: extraction.continuation,
      error: extraction.error,
    };
  }

  async searchPaper(input: SearchPaperInput): Promise<SearchPaperResult> {
    const paperId = this.requirePaperId(input.paper_id);
    if (typeof input.query !== "string" || input.query.trim() === "") {
      throw new AppError("INVALID_INPUT", "query must be a non-empty string.", { field: "query" });
    }
    const maxResults = clamp(input.max_results ?? 20, 1, 100);
    const catalog = await this.deps.catalog.load();
    const paper = catalog.papers[paperId];
    if (!paper) throw new AppError("NOT_FOUND", `Paper ${paperId} was not found.`, { paper_id: paperId });
    const attachments = input.attachment_id
      ? [this.resolveAttachment(paper.attachments, paper.primary_attachment_id, input.attachment_id)]
      : Object.values(paper.attachments);
    const needle = input.query.toLocaleLowerCase();
    const results: SearchHit[] = [];
    for (const attachment of attachments) {
      const bytes = await this.deps.library.readAttachmentBytes(paperId, attachment.attachment_id);
      const extraction = await this.deps.pdf.extract(bytes, {
        maxBytes: this.deps.limits.maxBytes,
        maxPages: this.deps.limits.maxPages,
        maxChars: this.deps.limits.maxChars,
      });
      for (const page of extraction.pages) {
        const haystack = page.text.toLocaleLowerCase();
        let index = haystack.indexOf(needle);
        while (index !== -1 && results.length < maxResults) {
          results.push({
            paper_id: paperId,
            paper_title: paper.metadata.title,
            attachment_id: attachment.attachment_id,
            attachment_title: attachment.title,
            page: page.page,
            snippet: snippetAround(page.text, index, input.query.length),
          });
          index = haystack.indexOf(needle, index + needle.length);
        }
        if (results.length >= maxResults) break;
      }
      if (results.length >= maxResults) break;
    }
    return {
      query: input.query,
      results,
      scanned_attachments: attachments.length,
    };
  }

  private resolveAttachment(
    attachments: Record<AttachmentId, AttachmentRecord>,
    primaryId: AttachmentId,
    requestedId: string | undefined,
  ): AttachmentRecord {
    const id = requestedId ?? primaryId;
    if (!isAttachmentId(id)) {
      throw new AppError("INVALID_ID", `"${id}" is not a valid Attachment ID.`, {
        attachment_id: id,
      });
    }
    const attachment = attachments[id];
    if (!attachment) {
      throw new AppError("NOT_FOUND", `Attachment ${id} was not found.`, {
        attachment_id: id,
      });
    }
    return attachment;
  }

  private requirePaperId(value: string): PaperId {
    if (!isPaperId(value)) {
      throw new AppError("INVALID_ID", `"${value}" is not a valid Paper ID.`, { paper_id: value });
    }
    return value;
  }
}

function snippetAround(text: string, index: number, matchLength: number): string {
  const radius = 80;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + matchLength + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
