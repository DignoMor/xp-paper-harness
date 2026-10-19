import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestHarness } from "./helpers/harness.js";
import { createTestHarness, textBytes } from "./helpers/harness.js";
import type { AttachmentId, PaperId } from "../src/domain/ids.js";
import { uuidv7 } from "../src/domain/ids.js";
import { parseNote, serializeNote } from "../src/domain/note.js";

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

interface Fixture {
  paperId: PaperId;
  attachmentId: AttachmentId;
  title: string;
}

async function importPaper(title = "Fixture Paper"): Promise<Fixture> {
  const uploadId = await harness.stage(textBytes(`pdf:${title}`));
  const { paper } = await harness.library.importPaper({
    upload_id: uploadId,
    metadata: { title },
  });
  return { paperId: paper.paper_id, attachmentId: paper.primary_attachment_id, title };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function snapshot(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(full);
      } else {
        const info = await stat(full);
        entries.push(`${relative(root, full)}:${info.mtimeMs}:${info.size}`);
      }
    }
  }
  await walk(root);
  return entries.sort();
}

async function corruptNoteFrontmatter(fixture: Fixture, title: string, body: string): Promise<void> {
  await writeFile(
    harness.paths.noteFile(fixture.paperId),
    serializeNote({ paper_id: fixture.paperId, title }, body),
  );
}

describe("ReconciliationService report-only mode", () => {
  it("reports a healthy Library cleanly and makes no filesystem changes", async () => {
    const fixture = await importPaper();
    const before = await snapshot(harness.dir);

    const report = await harness.reconciliation.reconcile();

    const after = await snapshot(harness.dir);
    expect(report.mode).toBe("report_only");
    expect(report.deep).toBe(false);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.repaired).toEqual([]);
    expect(report.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(report.catalog_revision).toBe(await harness.library.getCatalogRevision());
    expect(typeof report.generated_at).toBe("string");
    expect(after).toEqual(before);
    expect(await pathExists(harness.paths.noteFile(fixture.paperId))).toBe(true);
  });

  it("flags a missing Paper Note as repairable without recreating it", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.noteFile(fixture.paperId));

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "NOTE_MISSING");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({
      severity: "error",
      repairable: true,
      paper_id: fixture.paperId,
    });
    expect(await pathExists(harness.paths.noteFile(fixture.paperId))).toBe(false);
  });

  it("flags stale managed frontmatter as repairable and leaves the file untouched", async () => {
    const fixture = await importPaper("Catalog Title");
    await corruptNoteFrontmatter(fixture, "Wrong Title", "# Body\n\nKeep me intact");

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "NOTE_FRONTMATTER_STALE");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({
      severity: "warning",
      repairable: true,
      paper_id: fixture.paperId,
    });
    const parsed = parseNote(await readFile(harness.paths.noteFile(fixture.paperId), "utf8"));
    expect(parsed.managed.title).toBe("Wrong Title");
  });

  it("flags invalid frontmatter (missing block) as repairable", async () => {
    const fixture = await importPaper();
    await writeFile(harness.paths.noteFile(fixture.paperId), "This note has no frontmatter.\n");

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "NOTE_FRONTMATTER_INVALID");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({
      severity: "error",
      repairable: true,
      paper_id: fixture.paperId,
    });
  });

  it("flags invalid frontmatter (bad YAML) as repairable", async () => {
    const fixture = await importPaper();
    const broken = `---\npaper_id: [unterminated\ntitle: Broken\n---\n\nbody\n`;
    await writeFile(harness.paths.noteFile(fixture.paperId), broken);

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "NOTE_FRONTMATTER_INVALID");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({ severity: "error", repairable: true, paper_id: fixture.paperId });
  });

  it("flags an unknown frontmatter key as repairable and leaves the file untouched", async () => {
    const fixture = await importPaper("Extra Key Paper");
    await writeFile(
      harness.paths.noteFile(fixture.paperId),
      `---\npaper_id: ${fixture.paperId}\ntitle: Extra Key Paper\nextra: nope\n---\n\n# Notes\n`,
    );

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "NOTE_FRONTMATTER_INVALID");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({ severity: "error", repairable: true, paper_id: fixture.paperId });
    expect(issue!.detail).toContain("unsupported");
    expect(await readFile(harness.paths.noteFile(fixture.paperId), "utf8")).toContain("extra: nope");
  });

  it("flags a missing Attachment file as non-repairable", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId));

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "ATTACHMENT_FILE_MISSING");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({
      severity: "error",
      repairable: false,
      paper_id: fixture.paperId,
      attachment_id: fixture.attachmentId,
    });
  });

  it("flags an orphan PDF and an orphan Note", async () => {
    const fixture = await importPaper();
    const strayAttachmentId = `att_${uuidv7()}` as AttachmentId;
    await writeFile(
      join(harness.paths.attachmentsDir(fixture.paperId), `${strayAttachmentId}.pdf`),
      textBytes("stray bytes"),
    );
    const orphanPaperId = `ppr_${uuidv7()}` as PaperId;
    await writeFile(
      harness.paths.noteFile(orphanPaperId),
      serializeNote({ paper_id: orphanPaperId, title: "Orphan" }, "# orphan"),
    );

    const report = await harness.reconciliation.reconcile();

    const orphanPdf = report.issues.find((candidate) => candidate.code === "ORPHAN_PDF");
    expect(orphanPdf).toBeDefined();
    expect(orphanPdf).toMatchObject({
      severity: "warning",
      repairable: false,
      paper_id: fixture.paperId,
      attachment_id: strayAttachmentId,
    });

    const orphanNote = report.issues.find((candidate) => candidate.code === "ORPHAN_NOTE");
    expect(orphanNote).toBeDefined();
    expect(orphanNote).toMatchObject({
      severity: "warning",
      repairable: false,
      paper_id: orphanPaperId,
    });
  });

  it("does not flag a hash mismatch unless deep mode is requested", async () => {
    const fixture = await importPaper();
    const record = await harness.library.getPaperRecord(fixture.paperId);
    const expected = record.attachments[fixture.attachmentId]!.sha256;
    await writeFile(
      harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId),
      textBytes("corrupted attachment bytes"),
    );

    const shallow = await harness.reconciliation.reconcile();
    expect(shallow.deep).toBe(false);
    expect(shallow.issues.some((issue) => issue.code === "ATTACHMENT_HASH_MISMATCH")).toBe(false);

    const deep = await harness.reconciliation.reconcile({ deep: true });
    expect(deep.deep).toBe(true);
    const issue = deep.issues.find((candidate) => candidate.code === "ATTACHMENT_HASH_MISMATCH");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({
      severity: "error",
      repairable: false,
      paper_id: fixture.paperId,
      attachment_id: fixture.attachmentId,
    });
    expect(issue!.detail).toContain(expected);
    expect(issue!.detail).toMatch(/actual [0-9a-f]{64}/);
  });
});

describe("ReconciliationService repair mode", () => {
  it("recreates a missing Paper Note and lists it under repaired", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.noteFile(fixture.paperId));

    const report = await harness.reconciliation.reconcile({ repair: true });

    expect(report.mode).toBe("repair");
    expect(report.repaired.some((issue) => issue.code === "NOTE_MISSING")).toBe(true);
    expect(await pathExists(harness.paths.noteFile(fixture.paperId))).toBe(true);
    const parsed = parseNote(await readFile(harness.paths.noteFile(fixture.paperId), "utf8"));
    expect(parsed.managed.paper_id).toBe(fixture.paperId);
    expect(parsed.managed.title).toBe(fixture.title);
    expect(report.repaired.find((issue) => issue.code === "NOTE_MISSING")).toMatchObject({
      paper_id: fixture.paperId,
      repairable: true,
    });
  });

  it("normalizes stale frontmatter back to the catalog title while preserving the body", async () => {
    const fixture = await importPaper("Catalog Title");
    await corruptNoteFrontmatter(fixture, "Wrong Title", "# Body\n\nKeep me intact");

    const report = await harness.reconciliation.reconcile({ repair: true });

    expect(report.repaired.some((issue) => issue.code === "NOTE_FRONTMATTER_STALE")).toBe(true);
    const parsed = parseNote(await readFile(harness.paths.noteFile(fixture.paperId), "utf8"));
    expect(parsed.managed.paper_id).toBe(fixture.paperId);
    expect(parsed.managed.title).toBe("Catalog Title");
    expect(parsed.body).toContain("Keep me intact");
  });

  it("rewrites valid managed frontmatter for an invalid note", async () => {
    const fixture = await importPaper("Repaired Title");
    await writeFile(harness.paths.noteFile(fixture.paperId), "no frontmatter at all\n");

    const report = await harness.reconciliation.reconcile({ repair: true });

    expect(report.repaired.some((issue) => issue.code === "NOTE_FRONTMATTER_INVALID")).toBe(true);
    const parsed = parseNote(await readFile(harness.paths.noteFile(fixture.paperId), "utf8"));
    expect(parsed.managed.paper_id).toBe(fixture.paperId);
    expect(parsed.managed.title).toBe("Repaired Title");
  });

  it("repairs an unknown frontmatter key back to the canonical three keys", async () => {
    const fixture = await importPaper("Extra Key Paper");
    const revision = await harness.library.getCatalogRevision();
    await harness.library.updatePaperMetadata(fixture.paperId, { doi: "10.1234/canonical" }, revision);
    await writeFile(
      harness.paths.noteFile(fixture.paperId),
      `---\npaper_id: ${fixture.paperId}\ntitle: Stale Title\ndoi: 10.1234/extra\nextra: nope\n---\n\n# Notes\n`,
    );

    const report = await harness.reconciliation.reconcile({ repair: true });

    expect(report.repaired.some((issue) => issue.code === "NOTE_FRONTMATTER_INVALID")).toBe(true);
    const raw = await readFile(harness.paths.noteFile(fixture.paperId), "utf8");
    const parsed = parseNote(raw);
    expect(Object.keys(parsed.managed)).toEqual(["paper_id", "title", "doi"]);
    expect(parsed.managed.paper_id).toBe(fixture.paperId);
    expect(parsed.managed.title).toBe("Extra Key Paper");
    expect(parsed.managed.doi).toBe("10.1234/canonical");
    expect(raw).not.toContain("extra");
  });

  it("does not recreate a missing Attachment file", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId));

    const report = await harness.reconciliation.reconcile({ repair: true });

    expect(report.repaired.some((issue) => issue.code === "ATTACHMENT_FILE_MISSING")).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ATTACHMENT_FILE_MISSING")).toBe(true);
    expect(report.issues.find((issue) => issue.code === "ATTACHMENT_FILE_MISSING")).toMatchObject({
      repairable: false,
      attachment_id: fixture.attachmentId,
    });
    expect(await pathExists(harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId))).toBe(
      false,
    );
  });
});

describe("ReconciliationService malformed catalog", () => {
  it("reports CATALOG_CORRUPT for invalid JSON without throwing or modifying the file", async () => {
    await importPaper();
    const catalogFile = harness.paths.catalogFile();
    await writeFile(catalogFile, "{ not valid json");
    const before = await readFile(catalogFile);

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "CATALOG_CORRUPT");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({ severity: "error", repairable: false });
    expect(report.catalog_revision).toBeNull();
    expect(report.summary.errors).toBe(1);
    expect((await readFile(catalogFile)).equals(before)).toBe(true);
  });

  it("reports CATALOG_SCHEMA_UNKNOWN for an unsupported schema version", async () => {
    await importPaper();
    const catalogFile = harness.paths.catalogFile();
    await writeFile(
      catalogFile,
      JSON.stringify({ schema_version: 999, revision: 4, papers: {} }),
    );
    const before = await readFile(catalogFile);

    const report = await harness.reconciliation.reconcile();

    const issue = report.issues.find((candidate) => candidate.code === "CATALOG_SCHEMA_UNKNOWN");
    expect(issue).toBeDefined();
    expect(issue).toMatchObject({ severity: "error", repairable: false });
    expect(report.catalog_revision).toBeNull();
    expect((await readFile(catalogFile)).equals(before)).toBe(true);
  });
});

describe("ReconciliationService report shape", () => {
  it("always populates issue fields and keeps summary counts consistent", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.noteFile(fixture.paperId));
    await rm(harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId));

    const report = await harness.reconciliation.reconcile();

    expect(report.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of report.issues) {
      expect(["error", "warning", "info"]).toContain(issue.severity);
      expect(typeof issue.code).toBe("string");
      expect(issue.code.length).toBeGreaterThan(0);
      expect(typeof issue.message).toBe("string");
      expect(issue.message.length).toBeGreaterThan(0);
      expect(typeof issue.repairable).toBe("boolean");
    }
    expect(report.issues.find((issue) => issue.code === "NOTE_MISSING")?.paper_id).toBe(
      fixture.paperId,
    );
    const missingAttachment = report.issues.find(
      (issue) => issue.code === "ATTACHMENT_FILE_MISSING",
    );
    expect(missingAttachment?.paper_id).toBe(fixture.paperId);
    expect(missingAttachment?.attachment_id).toBe(fixture.attachmentId);
    expect(report.summary.errors).toBe(
      report.issues.filter((issue) => issue.severity === "error").length,
    );
    expect(report.summary.warnings).toBe(
      report.issues.filter((issue) => issue.severity === "warning").length,
    );
    expect(report.summary.infos).toBe(
      report.issues.filter((issue) => issue.severity === "info").length,
    );
    expect(report.summary.repaired).toBe(report.repaired.length);
  });
});
