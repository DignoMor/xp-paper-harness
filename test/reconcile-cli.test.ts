import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReconcileCli } from "../src/cli/reconcile.js";
import { uuidv7 } from "../src/domain/ids.js";
import type { AttachmentId, PaperId } from "../src/domain/ids.js";
import type { TestHarness } from "./helpers/harness.js";
import { createTestHarness, textBytes } from "./helpers/harness.js";

let harness: TestHarness;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  harness = await createTestHarness();
  env = { PAPER_HARNESS_DATA_ROOT: harness.dir, LLM_PROVIDER: "fake" };
});

afterEach(async () => {
  await harness.cleanup();
});

interface Fixture {
  paperId: PaperId;
  attachmentId: AttachmentId;
}

async function importPaper(title = "Cli Fixture"): Promise<Fixture> {
  const uploadId = await harness.stage(textBytes(`cli-pdf:${title}`));
  const { paper } = await harness.library.importPaper({
    upload_id: uploadId,
    metadata: { title },
  });
  return { paperId: paper.paper_id, attachmentId: paper.primary_attachment_id };
}

async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, stdout: output };
  } finally {
    process.stdout.write = original;
  }
}

describe("runReconcileCli", () => {
  it("returns 0 and a valid report for a healthy Library in --json mode", async () => {
    await importPaper();

    const { result: code, stdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json"], env),
    );

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.mode).toBe("report_only");
    expect(report.deep).toBe(false);
    expect(report.summary.errors).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.catalog_revision).toBe(await harness.library.getCatalogRevision());
  });

  it("returns 2 for an injected error, then repairs a missing Note with --repair", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.noteFile(fixture.paperId));

    const { result: failingCode, stdout: failingStdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json"], env),
    );
    expect(failingCode).toBe(2);
    const failingReport = JSON.parse(failingStdout);
    expect(failingReport.issues.some((issue: { code: string }) => issue.code === "NOTE_MISSING")).toBe(
      true,
    );
    expect(existsSync(harness.paths.noteFile(fixture.paperId))).toBe(false);

    const { result: repairCode, stdout: repairStdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json", "--repair"], env),
    );
    expect(repairCode).toBe(0);
    expect(existsSync(harness.paths.noteFile(fixture.paperId))).toBe(true);
    const repairReport = JSON.parse(repairStdout);
    expect(repairReport.mode).toBe("repair");
    expect(
      repairReport.repaired.some((issue: { code: string }) => issue.code === "NOTE_MISSING"),
    ).toBe(true);

    const { result: healthyCode, stdout: healthyStdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json"], env),
    );
    expect(healthyCode).toBe(0);
    expect(JSON.parse(healthyStdout).summary.errors).toBe(0);
  });

  it("exits 0 after a known-safe --repair", async () => {
    const fixture = await importPaper();
    await rm(harness.paths.noteFile(fixture.paperId));

    const { result: code, stdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json", "--repair"], env),
    );

    expect(existsSync(harness.paths.noteFile(fixture.paperId))).toBe(true);
    expect(JSON.parse(stdout).repaired).toHaveLength(1);
    expect(code).toBe(0);
  });

  it("reflects --deep and reports a corrupted Attachment hash", async () => {
    const fixture = await importPaper();
    const record = await harness.library.getPaperRecord(fixture.paperId);
    const expected = record.attachments[fixture.attachmentId]!.sha256;
    await writeFile(
      harness.paths.attachmentFile(fixture.paperId, fixture.attachmentId),
      textBytes("corrupted cli bytes"),
    );

    const { result: shallowCode, stdout: shallowStdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json"], env),
    );
    expect(shallowCode).toBe(0);
    expect(
      JSON.parse(shallowStdout).issues.some(
        (issue: { code: string }) => issue.code === "ATTACHMENT_HASH_MISMATCH",
      ),
    ).toBe(false);

    const { result: deepCode, stdout: deepStdout } = await captureStdout(() =>
      runReconcileCli(["--data-root", harness.dir, "--json", "--deep"], env),
    );
    expect(deepCode).toBe(2);
    const report = JSON.parse(deepStdout);
    expect(report.deep).toBe(true);
    const issue = report.issues.find(
      (candidate: { code: string }) => candidate.code === "ATTACHMENT_HASH_MISMATCH",
    );
    expect(issue).toBeDefined();
    expect(issue.detail).toContain(expected);
  });

  it("returns 0 and prints usage for --help without touching the data root", async () => {
    const untouchedRoot = join(tmpdir(), `paper-harness-help-${uuidv7()}`);

    const { result: code, stdout } = await captureStdout(() =>
      runReconcileCli(["--help", "--data-root", untouchedRoot], env),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--repair");
    expect(existsSync(untouchedRoot)).toBe(false);
  });

  it("rejects an unknown argument", async () => {
    await expect(runReconcileCli(["--bogus"], env)).rejects.toThrow(/Unknown argument/);
  });

  it("uses PAPER_HARNESS_DATA_ROOT from env when --data-root is omitted", async () => {
    await importPaper();

    const { result: code, stdout } = await captureStdout(() =>
      runReconcileCli(["--json"], env),
    );

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.catalog_revision).toBe(await harness.library.getCatalogRevision());
    expect(report.catalog_revision).toBeGreaterThan(0);
  });
});
