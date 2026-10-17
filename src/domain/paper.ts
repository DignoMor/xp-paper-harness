import type { AttachmentId, PaperId } from "./ids.js";

export interface Creator {
  creator_type: string;
  first_name?: string;
  last_name?: string;
  name?: string;
}

export interface PaperMetadata {
  item_type: string;
  title: string;
  creators: Creator[];
  abstract_note?: string;
  publication_title?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  date?: string;
  doi?: string;
  url?: string;
  tags: string[];
}

export const PAPER_METADATA_FIELDS = [
  "item_type",
  "title",
  "creators",
  "abstract_note",
  "publication_title",
  "volume",
  "issue",
  "pages",
  "date",
  "doi",
  "url",
  "tags",
] as const;

export type PaperMetadataField = (typeof PAPER_METADATA_FIELDS)[number];

export type ExtractionStatus =
  | "ok"
  | "pending"
  | "unreadable"
  | "encrypted"
  | "image_only"
  | "oversized"
  | "corrupt";

export interface AttachmentRecord {
  attachment_id: AttachmentId;
  title: string;
  description: string;
  original_filename: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  imported_at: string;
  page_count: number | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  storage_path: string;
}

export const ATTACHMENT_METADATA_FIELDS = [
  "attachment_id",
  "title",
  "description",
  "original_filename",
  "media_type",
  "sha256",
  "byte_size",
  "imported_at",
  "page_count",
  "extraction_status",
  "extraction_error",
  "storage_path",
] as const;

export const ATTACHMENT_MUTABLE_FIELDS = ["title", "description"] as const;

export interface PaperRecord {
  paper_id: PaperId;
  metadata: PaperMetadata;
  attachments: Record<AttachmentId, AttachmentRecord>;
  primary_attachment_id: AttachmentId;
  created_at: string;
  updated_at: string;
}

export interface PaperSummary {
  paper_id: PaperId;
  title: string;
  item_type: string;
  creators: Creator[];
  date: string | null;
  doi: string | null;
  attachment_count: number;
  updated_at: string;
}

export interface PaperDetail {
  catalog_revision?: number;
  paper_id: PaperId;
  metadata: PaperMetadata;
  created_at: string;
  updated_at: string;
  primary_attachment_id: AttachmentId;
  attachments: Array<AttachmentRecord & { primary: boolean }>;
}

export function emptyMetadata(title: string): PaperMetadata {
  return {
    item_type: "journalArticle",
    title,
    creators: [],
    tags: [],
  };
}

export function paperToSummary(record: PaperRecord): PaperSummary {
  return {
    paper_id: record.paper_id,
    title: record.metadata.title,
    item_type: record.metadata.item_type,
    creators: record.metadata.creators,
    date: record.metadata.date ?? null,
    doi: record.metadata.doi ?? null,
    attachment_count: Object.keys(record.attachments).length,
    updated_at: record.updated_at,
  };
}

export function paperToDetail(record: PaperRecord): PaperDetail {
  const attachments = Object.values(record.attachments)
    .slice()
    .sort((a, b) => a.imported_at.localeCompare(b.imported_at))
    .map((attachment) => ({
      ...attachment,
      primary: attachment.attachment_id === record.primary_attachment_id,
    }));
  return {
    paper_id: record.paper_id,
    metadata: record.metadata,
    created_at: record.created_at,
    updated_at: record.updated_at,
    primary_attachment_id: record.primary_attachment_id,
    attachments,
  };
}
