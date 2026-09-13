import { AppError } from "./errors.js";
import { isAttachmentId, isPaperId, type AttachmentId, type PaperId } from "./ids.js";
import {
  ATTACHMENT_METADATA_FIELDS,
  PAPER_METADATA_FIELDS,
  type AttachmentRecord,
  type ExtractionStatus,
  type PaperMetadata,
  type PaperRecord,
} from "./paper.js";
import {
  assertKnownKeys,
  requireArray,
  requireInteger,
  requireObject,
  requireString,
} from "./validate.js";

export const CATALOG_SCHEMA_VERSION = 1 as const;

export interface Catalog {
  schema_version: typeof CATALOG_SCHEMA_VERSION;
  revision: number;
  papers: Record<PaperId, PaperRecord>;
}

export function emptyCatalog(): Catalog {
  return { schema_version: CATALOG_SCHEMA_VERSION, revision: 0, papers: {} };
}

const EXTRACTION_STATUSES: ReadonlySet<string> = new Set<ExtractionStatus>([
  "ok",
  "pending",
  "unreadable",
  "encrypted",
  "image_only",
  "oversized",
  "corrupt",
]);

const PAPER_RECORD_FIELDS = [
  "paper_id",
  "metadata",
  "attachments",
  "primary_attachment_id",
  "created_at",
  "updated_at",
] as const;

export function validateMetadata(value: unknown, label: string): PaperMetadata {
  const obj = requireObject(value, label);
  assertKnownKeys(obj, PAPER_METADATA_FIELDS, label);
  const item_type = requireString(obj.item_type, `${label}.item_type`, { max: 100 });
  const title = requireString(obj.title, `${label}.title`, { max: 2000 });
  const creatorsRaw = requireArray(obj.creators, `${label}.creators`);
  const creators = creatorsRaw.map((creator, index) => {
    const c = requireObject(creator, `${label}.creators[${index}]`);
    assertKnownKeys(c, ["creator_type", "first_name", "last_name", "name"], `${label}.creators[${index}]`);
    const creator_type = requireString(c.creator_type, `${label}.creators[${index}].creator_type`, {
      max: 100,
    });
    const out: PaperMetadata["creators"][number] = { creator_type };
    if (c.first_name !== undefined) out.first_name = requireString(c.first_name, "first_name", { max: 500 });
    if (c.last_name !== undefined) out.last_name = requireString(c.last_name, "last_name", { max: 500 });
    if (c.name !== undefined) out.name = requireString(c.name, "name", { max: 1000 });
    if (!out.name && !out.first_name && !out.last_name) {
      throw new AppError("INVALID_INPUT", `creators[${index}] must have a name or personal name parts.`, {
        field: "creators",
      });
    }
    return out;
  });
  const metadata: PaperMetadata = { item_type, title, creators, tags: [] };
  for (const field of [
    "abstract_note",
    "publication_title",
    "volume",
    "issue",
    "pages",
    "date",
    "doi",
    "url",
  ] as const) {
    const raw = obj[field];
    if (raw !== undefined) metadata[field] = requireString(raw, `${label}.${field}`, { max: 20000 });
  }
  if (obj.tags !== undefined) {
    metadata.tags = requireArray(obj.tags, `${label}.tags`).map((tag, i) =>
      requireString(tag, `${label}.tags[${i}]`, { max: 200 }),
    );
  }
  return metadata;
}

function validateAttachment(value: unknown, label: string): AttachmentRecord {
  const obj = requireObject(value, label);
  assertKnownKeys(obj, ATTACHMENT_METADATA_FIELDS, label);
  const attachment_id = obj.attachment_id;
  if (!isAttachmentId(attachment_id)) {
    throw new AppError("CORRUPT_CATALOG", `${label}.attachment_id is invalid.`, { label });
  }
  const extraction_status = requireString(obj.extraction_status, `${label}.extraction_status`);
  if (!EXTRACTION_STATUSES.has(extraction_status)) {
    throw new AppError("CORRUPT_CATALOG", `${label}.extraction_status is unknown.`, {
      value: extraction_status,
    });
  }
  const page_count =
    obj.page_count === null ? null : requireInteger(obj.page_count, `${label}.page_count`);
  const extraction_error =
    obj.extraction_error === null
      ? null
      : requireString(obj.extraction_error, `${label}.extraction_error`, { max: 4000 });
  return {
    attachment_id,
    title: requireString(obj.title, `${label}.title`, { max: 2000 }),
    description: requireString(obj.description, `${label}.description`, { max: 10000 }),
    original_filename: requireString(obj.original_filename, `${label}.original_filename`, { max: 1000 }),
    media_type: requireString(obj.media_type, `${label}.media_type`, { max: 200 }),
    sha256: requireString(obj.sha256, `${label}.sha256`, { max: 64 }),
    byte_size: requireInteger(obj.byte_size, `${label}.byte_size`),
    imported_at: requireString(obj.imported_at, `${label}.imported_at`, { max: 100 }),
    page_count,
    extraction_status: extraction_status as ExtractionStatus,
    extraction_error,
    storage_path: requireString(obj.storage_path, `${label}.storage_path`, { max: 1000 }),
  };
}

export function validatePaperRecord(
  value: unknown,
  key: string,
  label: string,
): PaperRecord {
  const obj = requireObject(value, label);
  assertKnownKeys(obj, PAPER_RECORD_FIELDS, label);
  const paper_id = obj.paper_id;
  if (!isPaperId(paper_id)) {
    throw new AppError("CORRUPT_CATALOG", `${label}.paper_id is invalid.`, { label });
  }
  if (paper_id !== key) {
    throw new AppError("CORRUPT_CATALOG", `${label}.paper_id does not match its catalog key.`, {
      label,
      key,
    });
  }
  const metadata = validateMetadata(obj.metadata, `${label}.metadata`);
  const attachmentsObj = requireObject(obj.attachments, `${label}.attachments`);
  const attachments: Record<AttachmentId, AttachmentRecord> = {} as Record<
    AttachmentId,
    AttachmentRecord
  >;
  for (const [attKey, attValue] of Object.entries(attachmentsObj)) {
    if (!isAttachmentId(attKey)) {
      throw new AppError("CORRUPT_CATALOG", `${label}.attachments has an invalid key "${attKey}".`, {
        label,
      });
    }
    const attachment = validateAttachment(attValue, `${label}.attachments.${attKey}`);
    if (attachment.attachment_id !== attKey) {
      throw new AppError(
        "CORRUPT_CATALOG",
        `${label}.attachments key does not match its attachment_id.`,
        { label, key: attKey },
      );
    }
    attachments[attKey] = attachment;
  }
  const primaryRaw = obj.primary_attachment_id;
  if (!isAttachmentId(primaryRaw)) {
    throw new AppError("CORRUPT_CATALOG", `${label}.primary_attachment_id is invalid.`, { label });
  }
  if (!attachments[primaryRaw]) {
    throw new AppError(
      "CORRUPT_CATALOG",
      `${label}.primary_attachment_id does not reference a known attachment.`,
      { label, primary_attachment_id: primaryRaw },
    );
  }
  return {
    paper_id,
    metadata,
    attachments,
    primary_attachment_id: primaryRaw,
    created_at: requireString(obj.created_at, `${label}.created_at`, { max: 100 }),
    updated_at: requireString(obj.updated_at, `${label}.updated_at`, { max: 100 }),
  };
}

export function parseCatalog(value: unknown): Catalog {
  const obj = requireObject(value, "catalog");
  assertKnownKeys(obj, ["schema_version", "revision", "papers"], "catalog");
  const schemaVersion = obj.schema_version;
  if (schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new AppError("UNKNOWN_SCHEMA", "The catalog schema version is not supported.", {
      schema_version: schemaVersion,
      supported: CATALOG_SCHEMA_VERSION,
    });
  }
  const revision = requireInteger(obj.revision, "catalog.revision");
  const papersObj = requireObject(obj.papers, "catalog.papers");
  const papers: Record<PaperId, PaperRecord> = {} as Record<PaperId, PaperRecord>;
  for (const [key, paperValue] of Object.entries(papersObj)) {
    if (!isPaperId(key)) {
      throw new AppError("CORRUPT_CATALOG", `catalog.papers has an invalid key "${key}".`, { key });
    }
    papers[key] = validatePaperRecord(paperValue, key, `catalog.papers.${key}`);
  }
  const catalog: Catalog = {
    schema_version: CATALOG_SCHEMA_VERSION,
    revision,
    papers,
  };
  assertCatalogInvariants(catalog);
  return catalog;
}

export function assertCatalogInvariants(catalog: Catalog): void {
  for (const [paperId, paper] of Object.entries(catalog.papers)) {
    const ids = Object.keys(paper.attachments);
    if (ids.length === 0) {
      throw new AppError("CORRUPT_CATALOG", `Paper ${paperId} has no attachments.`, { paper_id: paperId });
    }
    if (!paper.attachments[paper.primary_attachment_id]) {
      throw new AppError(
        "CORRUPT_CATALOG",
        `Paper ${paperId} primary attachment is missing.`,
        { paper_id: paperId },
      );
    }
  }
}

export function serializeCatalog(catalog: Catalog): string {
  const papers: Record<string, PaperRecord> = {};
  for (const key of Object.keys(catalog.papers).sort()) {
    const paper = catalog.papers[key as PaperId];
    if (!paper) continue;
    const attachments: Record<string, AttachmentRecord> = {};
    for (const attKey of Object.keys(paper.attachments).sort()) {
      const att = paper.attachments[attKey as AttachmentId];
      if (att) attachments[attKey] = orderedAttachment(att);
    }
    papers[key] = {
      paper_id: paper.paper_id,
      metadata: orderedMetadata(paper.metadata),
      attachments: attachments as Record<AttachmentId, AttachmentRecord>,
      primary_attachment_id: paper.primary_attachment_id,
      created_at: paper.created_at,
      updated_at: paper.updated_at,
    };
  }
  const ordered: Catalog = {
    schema_version: catalog.schema_version,
    revision: catalog.revision,
    papers: papers as Record<PaperId, PaperRecord>,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderedMetadata(metadata: PaperMetadata): PaperMetadata {
  const out = {} as PaperMetadata;
  for (const field of PAPER_METADATA_FIELDS) {
    const value = metadata[field];
    if (value !== undefined) {
      (out as unknown as Record<string, unknown>)[field] = value;
    }
  }
  return out;
}

function orderedAttachment(attachment: AttachmentRecord): AttachmentRecord {
  const out = {} as AttachmentRecord;
  for (const field of ATTACHMENT_METADATA_FIELDS) {
    (out as unknown as Record<string, unknown>)[field] = attachment[field];
  }
  return out;
}
