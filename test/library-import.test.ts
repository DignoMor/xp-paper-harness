import { readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, textBytes, type TestHarness } from "./helpers/harness.js";
import { uuidv7 } from "../src/domain/ids.js";

describe("Library import (ticket #5)", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createTestHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("imports a valid staged PDF as a complete Paper aggregate", async () => {
    const bytes = textBytes("primary document body");
    const upload = await h.stage(bytes, "My_First-Paper.pdf");

    const result = await h.library.importPaper({ upload_id: upload });

    expect(result.imported_as).toBe("new_paper");
    expect(result.paper.paper_id).toMatch(/^ppr_/);
    expect(result.paper.attachments).toHaveLength(1);
    expect(result.paper.attachments[0]?.attachment_id).toMatch(/^att_/);
    expect(result.paper.attachments.filter((attachment) => attachment.primary)).toHaveLength(1);
    expect(result.paper.primary_attachment_id).toBe(result.paper.attachments[0]?.attachment_id);

    const catalog = await h.catalog.load();
    expect(catalog.schema_version).toBe(1);
    expect(catalog.revision).toBe(1);
    expect(catalog.papers[result.paper.paper_id]).toBeDefined();

    expect(result.note.managed.paper_id).toBe(result.paper.paper_id);
    expect(result.note.managed.title).toBe(result.paper.metadata.title);
    expect(result.note.body.trimStart().startsWith("# Notes")).toBe(true);
  });

  it("retains the original filename and derives a title from the filename", async () => {
    const bytes = textBytes("filename fallback bytes");
    const upload = await h.stage(bytes, "my_paper-draft.pdf");

    const result = await h.library.importPaper({ upload_id: upload });

    const attachment = result.paper.attachments[0]!;
    expect(attachment.original_filename).toBe("my_paper-draft.pdf");
    expect(result.paper.metadata.title).toBe("my paper draft");
  });

  it("uses an embedded title when no title is supplied", async () => {
    const bytes = textBytes("embedded title bytes");
    h.pdf.register(bytes, { embedded_title: "  Embedded Title  " });
    const upload = await h.stage(bytes, "untitled.pdf");

    const result = await h.library.importPaper({ upload_id: upload });

    expect(result.paper.metadata.title).toBe("Embedded Title");
  });

  it("applies input metadata and does not let an embedded title override it", async () => {
    const bytes = textBytes("metadata input bytes");
    h.pdf.register(bytes, { embedded_title: "Embedded Title" });
    const upload = await h.stage(bytes, "metadata.pdf");

    const result = await h.library.importPaper({
      upload_id: upload,
      metadata: {
        item_type: "conferencePaper",
        title: "Supplied Title",
        creators: [{ creator_type: "author", last_name: "Doe" }],
        doi: "doi:10.1/x",
        tags: ["tag-a", "tag-b"],
      },
    });

    expect(result.paper.metadata.title).toBe("Supplied Title");
    expect(result.paper.metadata.item_type).toBe("conferencePaper");
    expect(result.paper.metadata.doi).toBe("doi:10.1/x");
    expect(result.paper.metadata.creators).toHaveLength(1);
    expect(result.paper.metadata.tags).toEqual(["tag-a", "tag-b"]);
  });

  it("consumes the upload and stores the bytes under the ID-derived path", async () => {
    const bytes = textBytes("stored bytes payload");
    const upload = await h.stage(bytes, "stored.pdf");

    const result = await h.library.importPaper({ upload_id: upload });

    expect(await h.uploads.get(upload as never)).toBeNull();
    const attachment = result.paper.attachments[0]!;
    const stored = new Uint8Array(
      await readFile(h.paths.attachmentFile(result.paper.paper_id, attachment.attachment_id)),
    );
    expect(Buffer.from(stored).equals(Buffer.from(bytes))).toBe(true);
    expect(attachment.storage_path).toBe(
      `papers/${result.paper.paper_id}/attachments/${attachment.attachment_id}.pdf`,
    );
  });

  it("lists compact summaries and returns full detail for a paper", async () => {
    const bytes = textBytes("summary bytes");
    const upload = await h.stage(bytes, "summary.pdf");
    const { paper } = await h.library.importPaper({ upload_id: upload });

    const summaries = await h.library.listPapers();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    expect(summary.paper_id).toBe(paper.paper_id);
    expect(summary.title).toBe(paper.metadata.title);
    expect(summary.attachment_count).toBe(1);
    expect("attachments" in summary).toBe(false);

    const detail = await h.library.getPaper(paper.paper_id);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments.filter((attachment) => attachment.primary)).toHaveLength(1);
    expect(detail.primary_attachment_id).toBe(detail.attachments[0]!.attachment_id);
  });

  it("fails closed on malformed catalog JSON and leaves the file byte-identical", async () => {
    const file = h.paths.catalogFile();
    await writeFile(file, "{ this is not valid json", "utf8");
    const before = await readFile(file, "utf8");

    await expect(h.library.listPapers()).rejects.toMatchObject({ code: "CORRUPT_CATALOG" });
    await expect(h.library.getPaper(`ppr_${uuidv7()}`)).rejects.toMatchObject({
      code: "CORRUPT_CATALOG",
    });

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("fails closed on an unknown schema version and leaves the file byte-identical", async () => {
    const file = h.paths.catalogFile();
    await writeFile(
      file,
      `${JSON.stringify({ schema_version: 2, revision: 0, papers: {} }, null, 2)}\n`,
      "utf8",
    );
    const before = await readFile(file, "utf8");

    await expect(h.library.listPapers()).rejects.toMatchObject({ code: "UNKNOWN_SCHEMA" });
    await expect(h.library.getPaper(`ppr_${uuidv7()}`)).rejects.toMatchObject({
      code: "UNKNOWN_SCHEMA",
    });

    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("rejects invalid and expired upload ids and invalid paper ids", async () => {
    await expect(h.library.importPaper({ upload_id: "not-an-upload" })).rejects.toMatchObject({
      code: "INVALID_UPLOAD",
    });
    await expect(
      h.library.importPaper({ upload_id: `upl_${uuidv7()}` }),
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    await expect(h.library.getPaper("not-a-paper")).rejects.toMatchObject({
      code: "INVALID_ID",
    });
  });

  it("registers non-ok extractions and still lists the paper", async () => {
    for (const status of ["encrypted", "corrupt", "unreadable"] as const) {
      const bytes = textBytes(`extraction fixture ${status}`);
      h.pdf.register(bytes, {
        status,
        page_count: null,
        pages: [],
        error: `failed: ${status}`,
      });
      const upload = await h.stage(bytes, `${status}.pdf`);

      const result = await h.library.importPaper({ upload_id: upload });
      const attachment = result.paper.attachments[0]!;
      expect(attachment.extraction_status).toBe(status);
      expect(attachment.extraction_error).toBe(`failed: ${status}`);
    }

    const summaries = await h.library.listPapers();
    expect(summaries).toHaveLength(3);
  });
});
