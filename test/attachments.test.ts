import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, textBytes, type TestHarness } from "./helpers/harness.js";
import { sha256Hex } from "../src/infrastructure/fs/atomic.js";
import { uuidv7 } from "../src/domain/ids.js";
import type { PaperDetail } from "../src/domain/paper.js";

async function importPaper(
  h: TestHarness,
  bytes: Uint8Array,
  filename = "primary.pdf",
): Promise<PaperDetail> {
  const upload = await h.stage(bytes, filename);
  const result = await h.library.importPaper({ upload_id: upload });
  return result.paper;
}

describe("Supplementary attachments (ticket #9)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("adds a supplementary attachment with a stable id and full metadata", async () => {
    const paper = await importPaper(h, textBytes("primary content"), "primary.pdf");
    const primaryId = paper.primary_attachment_id;

    const supplementary = textBytes("supplementary content");
    h.pdf.register(supplementary, {
      pages: [
        { page: 1, text: "supp page one" },
        { page: 2, text: "supp page two" },
        { page: 3, text: "supp page three" },
      ],
    });
    const upload = await h.stage(supplementary, "supplement.pdf");

    const detail = await h.library.addAttachment({
      upload_id: upload,
      paper_id: paper.paper_id,
      title: "Supplement",
      description: "Extra material",
    });

    expect(detail.attachments).toHaveLength(2);
    const added = detail.attachments.find((attachment) => attachment.attachment_id !== primaryId)!;
    expect(added.attachment_id).toMatch(/^att_/);
    expect(added.title).toBe("Supplement");
    expect(added.description).toBe("Extra material");
    expect(added.original_filename).toBe("supplement.pdf");
    expect(added.media_type).toBe("application/pdf");
    expect(added.sha256).toBe(sha256Hex(supplementary));
    expect(added.byte_size).toBe(supplementary.byteLength);
    expect(typeof added.imported_at).toBe("string");
    expect(added.page_count).toBe(3);
    expect(added.extraction_status).toBe("ok");
    expect(added.extraction_error).toBeNull();
    expect(added.storage_path).toBe(
      `papers/${paper.paper_id}/attachments/${added.attachment_id}.pdf`,
    );
    expect(detail.attachments.filter((attachment) => attachment.primary)).toHaveLength(1);
    expect(await h.uploads.get(upload as never)).toBeNull();
  });

  it("patches only title and description, requires the current revision, and rejects the rest", async () => {
    const paper = await importPaper(h, textBytes("patch attachment body"), "patch.pdf");
    const attachmentId = paper.primary_attachment_id;
    const revision = await h.library.getCatalogRevision();

    const updated = await h.library.updateAttachmentMetadata(
      paper.paper_id,
      attachmentId,
      { title: "New title", description: "New description" },
      revision,
    );
    const attachment = updated.attachments.find((a) => a.attachment_id === attachmentId)!;
    expect(attachment.title).toBe("New title");
    expect(attachment.description).toBe("New description");
    expect(await h.library.getCatalogRevision()).toBe(revision + 1);

    await expect(
      h.library.updateAttachmentMetadata(paper.paper_id, attachmentId, { title: "stale" }, revision),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    await expect(
      h.library.updateAttachmentMetadata(paper.paper_id, attachmentId, { bogus: true }),
    ).rejects.toMatchObject({ code: "UNKNOWN_FIELD" });

    const immutablePatches: Array<Record<string, unknown>> = [
      { attachment_id: "att_00000000-0000-7000-8000-000000000000" },
      { original_filename: "other.pdf" },
      { media_type: "text/plain" },
      { sha256: "0".repeat(64) },
      { byte_size: 1 },
      { imported_at: "2026-01-01T00:00:00.000Z" },
      { storage_path: "elsewhere.pdf" },
      { page_count: 1 },
      { extraction_status: "ok" },
      { extraction_error: "nope" },
      { revision: 3 },
    ];
    for (const patch of immutablePatches) {
      await expect(
        h.library.updateAttachmentMetadata(paper.paper_id, attachmentId, patch),
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    }
  });

  it("changes only the paper-level primary reference and keeps the former primary", async () => {
    const paper = await importPaper(h, textBytes("set primary body"), "primary.pdf");
    const formerPrimaryId = paper.primary_attachment_id;

    const upload = await h.stage(textBytes("supplementary body"), "supplement.pdf");
    const added = await h.library.addAttachment({ upload_id: upload, paper_id: paper.paper_id });
    const newPrimaryId = added.attachments.find(
      (attachment) => attachment.attachment_id !== formerPrimaryId,
    )!.attachment_id;

    const detail = await h.library.setPrimaryAttachment(paper.paper_id, newPrimaryId, await h.library.getCatalogRevision());
    expect(detail.primary_attachment_id).toBe(newPrimaryId);
    expect(detail.attachments).toHaveLength(2);
    expect(detail.attachments.filter((attachment) => attachment.primary)).toEqual([
      expect.objectContaining({ attachment_id: newPrimaryId }),
    ]);

    const formerPrimary = detail.attachments.find((a) => a.attachment_id === formerPrimaryId)!;
    expect(formerPrimary.primary).toBe(false);

    const record = await h.library.getPaperRecord(paper.paper_id);
    expect(record.primary_attachment_id).toBe(newPrimaryId);
    expect(record.attachments[formerPrimaryId]).toBeDefined();
    expect("primary" in record.attachments[formerPrimaryId]!).toBe(false);
  });

  it("reads and searches a supplementary attachment by id", async () => {
    const primaryBytes = textBytes("primary reading body");
    h.pdf.register(primaryBytes, { pages: [{ page: 1, text: "Primary alpha passage" }] });
    const paper = await importPaper(h, primaryBytes, "primary.pdf");
    const primaryId = paper.primary_attachment_id;

    const supplementaryBytes = textBytes("supplementary reading body");
    h.pdf.register(supplementaryBytes, {
      pages: [{ page: 7, text: "Supplementary beta passage" }],
    });
    const upload = await h.stage(supplementaryBytes, "supplement.pdf");
    const added = await h.library.addAttachment({ upload_id: upload, paper_id: paper.paper_id });
    const supplementaryId = added.attachments.find((a) => a.attachment_id !== primaryId)!
      .attachment_id;

    const readPrimary = await h.reading.readPaper({ paper_id: paper.paper_id });
    expect(readPrimary.attachment_id).toBe(primaryId);
    expect(readPrimary.pages[0]?.text).toContain("alpha");

    const readSupplementary = await h.reading.readPaper({
      paper_id: paper.paper_id,
      attachment_id: supplementaryId,
    });
    expect(readSupplementary.attachment_id).toBe(supplementaryId);
    expect(readSupplementary.pages[0]?.text).toContain("beta");

    const search = await h.reading.searchPaper({
      paper_id: paper.paper_id,
      query: "beta",
      attachment_id: supplementaryId,
    });
    expect(search.results).toHaveLength(1);
    expect(search.results[0]?.attachment_id).toBe(supplementaryId);
    expect(search.results[0]?.page).toBe(7);
  });

  it("rejects invalid and unknown paper or attachment ids", async () => {
    const paper = await importPaper(h, textBytes("id validation body"), "ids.pdf");

    await expect(h.reading.readPaper({ paper_id: "bad" })).rejects.toMatchObject({
      code: "INVALID_ID",
    });
    await expect(h.reading.readPaper({ paper_id: `ppr_${uuidv7()}` })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      h.reading.readPaper({ paper_id: paper.paper_id, attachment_id: "bad" }),
    ).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(
      h.reading.readPaper({ paper_id: paper.paper_id, attachment_id: `att_${uuidv7()}` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      h.library.addAttachment({ upload_id: `upl_${uuidv7()}`, paper_id: "bad" }),
    ).rejects.toMatchObject({ code: "INVALID_ID" });
  });

  it("rolls back a failed add with no new record and no orphan file", async () => {
    const paper = await importPaper(h, textBytes("rollback primary body"), "primary.pdf");
    const directory = h.paths.attachmentsDir(paper.paper_id);
    const before = (await readdir(directory)).sort();

    const revision = await h.library.getCatalogRevision();
    const upload = await h.stage(textBytes("rollback supplementary body"), "supplement.pdf");
    await expect(
      h.library.addAttachment({
        upload_id: upload,
        paper_id: paper.paper_id,
        expected_revision: revision + 5,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    expect((await readdir(directory)).sort()).toEqual(before);
    expect((await h.library.getPaper(paper.paper_id)).attachments).toHaveLength(1);
  });

  it("rejects a duplicate-hash add without creating an orphan", async () => {
    const primaryBytes = textBytes("duplicate primary body");
    const paper = await importPaper(h, primaryBytes, "primary.pdf");
    const directory = h.paths.attachmentsDir(paper.paper_id);
    const before = (await readdir(directory)).sort();

    const upload = await h.stage(new Uint8Array(primaryBytes), "duplicate.pdf");
    await expect(
      h.library.addAttachment({ upload_id: upload, paper_id: paper.paper_id }),
    ).rejects.toMatchObject({ code: "DUPLICATE_HASH" });

    expect((await readdir(directory)).sort()).toEqual(before);
    expect((await h.library.getPaper(paper.paper_id)).attachments).toHaveLength(1);
  });
});
