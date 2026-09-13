import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, textBytes, type TestHarness } from "./helpers/harness.js";
import type { PaperDetail } from "../src/domain/paper.js";

async function importPaper(
  h: TestHarness,
  bytes: Uint8Array,
  filename = "paper.pdf",
  metadata?: Record<string, unknown>,
): Promise<PaperDetail> {
  const upload = await h.stage(bytes, filename);
  const result = await h.library.importPaper({ upload_id: upload, metadata });
  return result.paper;
}

describe("Paper metadata and duplicates (ticket #8)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("patches known fields, bumps the catalog revision, and reflects the change immediately", async () => {
    const paper = await importPaper(h, textBytes("metadata patch body"), "patch.pdf");
    const revision = await h.library.getCatalogRevision();

    const updated = await h.library.updatePaperMetadata(
      paper.paper_id,
      {
        title: "Updated Title",
        tags: ["alpha", "beta"],
        creators: [{ creator_type: "author", last_name: "Doe" }],
      },
      revision,
    );

    expect(updated.metadata.title).toBe("Updated Title");
    expect(updated.metadata.tags).toEqual(["alpha", "beta"]);
    expect(updated.metadata.creators).toEqual([{ creator_type: "author", last_name: "Doe" }]);
    expect(await h.library.getCatalogRevision()).toBe(revision + 1);

    const detail = await h.library.getPaper(paper.paper_id);
    expect(detail.metadata.title).toBe("Updated Title");
    const summary = (await h.library.listPapers()).find((s) => s.paper_id === paper.paper_id);
    expect(summary?.title).toBe("Updated Title");
  });

  it("rejects a stale expected revision without changing the catalog on disk", async () => {
    const paper = await importPaper(h, textBytes("stale revision body"), "stale.pdf");
    const file = h.paths.catalogFile();
    const before = await readFile(file, "utf8");

    await expect(
      h.library.updatePaperMetadata(paper.paper_id, { title: "Nope" }, 99999),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    expect(await readFile(file, "utf8")).toBe(before);
    expect((await h.library.getPaper(paper.paper_id)).metadata.title).toBe(paper.metadata.title);
  });

  it("rejects unknown fields and immutable identity fields", async () => {
    const paper = await importPaper(h, textBytes("field validation body"), "fields.pdf");

    await expect(
      h.library.updatePaperMetadata(paper.paper_id, { bogus: true }),
    ).rejects.toMatchObject({ code: "UNKNOWN_FIELD" });

    const immutablePatches: Array<Record<string, unknown>> = [
      { paper_id: "ppr_00000000-0000-7000-8000-000000000000" },
      { primary_attachment_id: "att_00000000-0000-7000-8000-000000000000" },
      { attachments: {} },
      { created_at: "2026-01-01T00:00:00.000Z" },
      { updated_at: "2026-01-01T00:00:00.000Z" },
      { revision: 5 },
    ];
    for (const patch of immutablePatches) {
      await expect(h.library.updatePaperMetadata(paper.paper_id, patch)).rejects.toMatchObject({
        code: "IMMUTABLE_FIELD",
      });
    }
  });

  it("normalizes DOIs so equivalent forms collide", async () => {
    const first = await importPaper(h, textBytes("doi first body"), "first.pdf", {
      doi: "doi:10.1/x",
    });

    const secondUpload = await h.stage(textBytes("doi second body"), "second.pdf");
    await expect(
      h.library.importPaper({
        upload_id: secondUpload,
        metadata: { doi: "https://doi.org/10.1/X" },
      }),
    ).rejects.toMatchObject({
      code: "DOI_COLLISION",
      details: { candidates: [{ paper_id: first.paper_id }] },
    });
  });

  it("creates a distinct paper with mode new and attaches with mode attach", async () => {
    const first = await importPaper(h, textBytes("collision base body"), "base.pdf", {
      doi: "10.1/y",
    });

    const newUpload = await h.stage(textBytes("collision new body"), "new.pdf");
    const created = await h.library.importPaper({
      upload_id: newUpload,
      metadata: { doi: "10.1/y" },
      mode: "new",
    });
    expect(created.imported_as).toBe("new_paper");
    expect(created.paper.paper_id).not.toBe(first.paper_id);
    expect(await h.library.listPapers()).toHaveLength(2);

    const attachUpload = await h.stage(textBytes("collision attach body"), "attach.pdf");
    const attached = await h.library.importPaper({
      upload_id: attachUpload,
      metadata: { doi: "10.1/y" },
      mode: "attach",
      existing_paper_id: first.paper_id,
    });
    expect(attached.imported_as).toBe("attachment");
    expect(attached.paper.paper_id).toBe(first.paper_id);
    expect(attached.paper.attachments).toHaveLength(2);
    expect(await h.library.listPapers()).toHaveLength(2);
  });

  it("attaches with mode attach when no DOI is supplied", async () => {
    const paper = await importPaper(h, textBytes("attach no doi base"), "base.pdf");

    const upload = await h.stage(textBytes("attach no doi body"), "supplement.pdf");
    const attached = await h.library.importPaper({
      upload_id: upload,
      mode: "attach",
      existing_paper_id: paper.paper_id,
    });

    expect(attached.imported_as).toBe("attachment");
    expect(attached.paper.paper_id).toBe(paper.paper_id);
    expect(attached.paper.attachments).toHaveLength(2);
  });

  it("attaches with mode attach when the DOI matches no existing paper", async () => {
    const paper = await importPaper(h, textBytes("attach unknown doi base"), "base.pdf");

    const upload = await h.stage(textBytes("attach unknown doi body"), "supplement.pdf");
    const attached = await h.library.importPaper({
      upload_id: upload,
      metadata: { doi: "10.9/never-seen" },
      mode: "attach",
      existing_paper_id: paper.paper_id,
    });

    expect(attached.imported_as).toBe("attachment");
    expect(attached.paper.paper_id).toBe(paper.paper_id);
    expect(attached.paper.attachments).toHaveLength(2);
  });

  it("creates a new paper with mode new despite a DOI collision", async () => {
    const first = await importPaper(h, textBytes("mode new collision base"), "base.pdf", {
      doi: "10.1/z",
    });

    const upload = await h.stage(textBytes("mode new collision body"), "new.pdf");
    const created = await h.library.importPaper({
      upload_id: upload,
      metadata: { doi: "10.1/z" },
      mode: "new",
    });

    expect(created.imported_as).toBe("new_paper");
    expect(created.paper.paper_id).not.toBe(first.paper_id);
    expect(await h.library.listPapers()).toHaveLength(2);
  });

  it("rejects mode attach without an existing_paper_id", async () => {
    const upload = await h.stage(textBytes("missing existing id body"), "missing.pdf");

    await expect(
      h.library.importPaper({ upload_id: upload, mode: "attach" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects byte-identical content anywhere in the library", async () => {
    const shared = textBytes("byte identical payload");
    const first = await importPaper(h, shared, "one.pdf");
    const firstAttachment = first.attachments[0]!;

    const secondUpload = await h.stage(new Uint8Array(shared), "two.pdf");
    await expect(h.library.importPaper({ upload_id: secondUpload })).rejects.toMatchObject({
      code: "DUPLICATE_HASH",
      details: {
        paper_id: first.paper_id,
        attachment_id: firstAttachment.attachment_id,
      },
    });
  });
});
