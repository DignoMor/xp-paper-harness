import { AppError } from "./errors.js";
import {
  ATTACHMENT_MUTABLE_FIELDS,
  PAPER_METADATA_FIELDS,
  type AttachmentRecord,
  type PaperMetadata,
} from "./paper.js";
import { assertImmutableAbsent, assertKnownKeys, isPlainObject } from "./validate.js";

const PAPER_IMMUTABLE_FIELDS = [
  "paper_id",
  "attachments",
  "primary_attachment_id",
  "created_at",
  "updated_at",
  "revision",
  "catalog_revision",
];

const ATTACHMENT_IMMUTABLE_FIELDS = [
  "attachment_id",
  "original_filename",
  "media_type",
  "sha256",
  "byte_size",
  "imported_at",
  "storage_path",
  "page_count",
  "extraction_status",
  "extraction_error",
  "revision",
  "catalog_revision",
];

export function applyPaperMetadataPatch(
  current: PaperMetadata,
  patch: unknown,
): PaperMetadata {
  if (!isPlainObject(patch)) {
    throw new AppError("INVALID_INPUT", "metadata patch must be an object.", {
      field: "metadata",
    });
  }
  assertImmutableAbsent(patch, PAPER_IMMUTABLE_FIELDS, "paper metadata patch");
  assertKnownKeys(patch, PAPER_METADATA_FIELDS, "paper metadata patch");
  if (Object.keys(patch).length === 0) {
    throw new AppError("INVALID_INPUT", "metadata patch must include at least one field.", {});
  }
  const next = structuredClone(current);
  const draft: Record<string, unknown> = { ...next, ...patch };
  for (const field of Object.keys(patch)) {
    const value = draft[field];
    if (value === undefined) continue;
    if (field === "creators" || field === "tags") {
      if (!Array.isArray(value)) {
        throw new AppError("INVALID_INPUT", `${field} must be an array.`, { field });
      }
    } else if (typeof value !== "string") {
      throw new AppError("INVALID_INPUT", `${field} must be a string.`, { field });
    }
  }
  return draft as unknown as PaperMetadata;
}

export interface AttachmentMetadataPatch {
  title?: string;
  description?: string;
}

export function applyAttachmentMetadataPatch(
  current: AttachmentRecord,
  patch: unknown,
): Pick<AttachmentRecord, "title" | "description"> {
  if (!isPlainObject(patch)) {
    throw new AppError("INVALID_INPUT", "attachment metadata patch must be an object.", {
      field: "metadata",
    });
  }
  assertImmutableAbsent(patch, ATTACHMENT_IMMUTABLE_FIELDS, "attachment metadata patch");
  assertKnownKeys(patch, ATTACHMENT_MUTABLE_FIELDS, "attachment metadata patch");
  const result: Pick<AttachmentRecord, "title" | "description"> = {
    title: current.title,
    description: current.description,
  };
  if (patch.title !== undefined) {
    if (typeof patch.title !== "string") {
      throw new AppError("INVALID_INPUT", "title must be a string.", { field: "title" });
    }
    result.title = patch.title;
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== "string") {
      throw new AppError("INVALID_INPUT", "description must be a string.", { field: "description" });
    }
    result.description = patch.description;
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError("INVALID_INPUT", "patch must include at least one field.", {});
  }
  return result;
}
