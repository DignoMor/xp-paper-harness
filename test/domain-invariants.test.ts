import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestHarness } from "./helpers/harness.js";
import { createTestHarness, textBytes } from "./helpers/harness.js";
import { parseCatalog, validateMetadata } from "../src/domain/catalog.js";
import { applyPaperMetadataPatch } from "../src/domain/metadata.js";
import { parseNote } from "../src/domain/note.js";
import { emptyMetadata } from "../src/domain/paper.js";
import { uuidv7 } from "../src/domain/ids.js";

function captureError(fn: () => unknown): { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string };
  }
  throw new Error("Expected function to throw.");
}

function validMetadata(): Record<string, unknown> {
  return { item_type: "journalArticle", title: "Fixture", creators: [], tags: [] };
}

function buildCatalog(
  metadata: Record<string, unknown>,
  attachment: Record<string, unknown> = {},
): unknown {
  const paperId = `ppr_${uuidv7()}`;
  const attachmentId = `att_${uuidv7()}`;
  return {
    schema_version: 1,
    revision: 1,
    papers: {
      [paperId]: {
        paper_id: paperId,
        metadata,
        attachments: {
          [attachmentId]: {
            attachment_id: attachmentId,
            title: "Fixture PDF",
            description: "",
            original_filename: "paper.pdf",
            media_type: "application/pdf",
            sha256: "0".repeat(64),
            byte_size: 1,
            imported_at: "2026-01-01T00:00:00.000Z",
            page_count: 1,
            extraction_status: "ok",
            extraction_error: null,
            storage_path: `papers/${paperId}/attachments/${attachmentId}.pdf`,
            ...attachment,
          },
        },
        primary_attachment_id: attachmentId,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
  };
}

describe("Catalog validation invariants", () => {
  it("accepts a catalog whose Attachment media_type is application/pdf", () => {
    expect(() => parseCatalog(buildCatalog(validMetadata()))).not.toThrow();
  });

  it("rejects a catalog Attachment whose media_type is not application/pdf", () => {
    const error = captureError(() =>
      parseCatalog(buildCatalog(validMetadata(), { media_type: "text/plain" })),
    );
    expect(error.code).toBe("CORRUPT_CATALOG");
  });

  it("requires tags on a catalog record's metadata", () => {
    const { tags: _tags, ...metadataWithoutTags } = validMetadata();
    const error = captureError(() => parseCatalog(buildCatalog(metadataWithoutTags)));
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("rejects a catalog record whose tags is not an array", () => {
    const error = captureError(() =>
      parseCatalog(buildCatalog({ ...validMetadata(), tags: "not-an-array" })),
    );
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("requires tags when validating a standalone paper metadata object", () => {
    const { tags: _tags, ...metadataWithoutTags } = validMetadata();
    const error = captureError(() => validateMetadata(metadataWithoutTags, "metadata"));
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("keeps tags intact when a metadata patch omits them", () => {
    const current = { ...emptyMetadata("Original"), tags: ["keep-me"] };
    const patched = applyPaperMetadataPatch(current, { title: "Renamed" });
    expect(patched.title).toBe("Renamed");
    expect(patched.tags).toEqual(["keep-me"]);
  });
});

describe("Paper Note frontmatter invariants", () => {
  it("rejects an unknown managed frontmatter key", () => {
    const paperId = `ppr_${uuidv7()}`;
    const raw = `---\npaper_id: ${paperId}\ntitle: Fixture\nextra: nope\n---\n\n# Notes\n`;
    const error = captureError(() => parseNote(raw));
    expect(error.code).toBe("CORRUPT_CATALOG");
  });

  it("accepts the canonical paper_id, title, and optional doi keys", () => {
    const paperId = `ppr_${uuidv7()}`;
    const raw = `---\npaper_id: ${paperId}\ntitle: Fixture\ndoi: 10.1234/ok\n---\n\n# Notes\n`;
    expect(() => parseNote(raw)).not.toThrow();
  });
});

describe("updatePaperMetadata without tags", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("accepts a patch that omits tags and preserves the existing tags", async () => {
    const uploadId = await harness.stage(textBytes("pdf:tags-invariant"));
    const { paper } = await harness.library.importPaper({
      upload_id: uploadId,
      metadata: { title: "Tags Fixture", tags: ["existing"] },
    });

    const updated = await harness.library.updatePaperMetadata(paper.paper_id, {
      title: "Renamed",
    });

    expect(updated.metadata.title).toBe("Renamed");
    expect(updated.metadata.tags).toEqual(["existing"]);
  });
});
