import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { AppError, isAppError } from "../domain/errors.js";
import { emptyCatalog, parseCatalog, type Catalog } from "../domain/catalog.js";
import { isAttachmentId, isPaperId } from "../domain/ids.js";
import { parseNote } from "../domain/note.js";
import type { AttachmentRecord, PaperRecord } from "../domain/paper.js";
import type { CatalogStore, Clock, DataPaths, NoteStore } from "./ports.js";
import { sha256Hex } from "../infrastructure/fs/atomic.js";

export type IssueSeverity = "error" | "warning" | "info";

export interface ReconciliationIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  paper_id?: string;
  attachment_id?: string;
  repairable: boolean;
  detail?: string;
}

export interface ReconciliationReport {
  generated_at: string;
  mode: "report_only" | "repair";
  deep: boolean;
  catalog_revision: number | null;
  issues: ReconciliationIssue[];
  repaired: ReconciliationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    repaired: number;
  };
}

export interface ReconciliationOptions {
  repair?: boolean;
  deep?: boolean;
}

export interface ReconciliationServiceDeps {
  paths: DataPaths;
  catalog: CatalogStore;
  notes: NoteStore;
  clock: Clock;
}

export class ReconciliationService {
  constructor(private readonly deps: ReconciliationServiceDeps) {}

  async reconcile(options: ReconciliationOptions = {}): Promise<ReconciliationReport> {
    const repair = options.repair === true;
    const deep = options.deep === true;
    const issues: ReconciliationIssue[] = [];
    const repaired: ReconciliationIssue[] = [];

    const raw = await this.deps.catalog.readRaw();
    if (raw === null) {
      issues.push({
        severity: "warning",
        code: "CATALOG_MISSING",
        message: "No catalog exists yet; the Library is empty.",
        repairable: false,
      });
      await this.checkOrphans(emptyCatalog(), issues);
      return this.finish({ issues, repaired, repair, deep, revision: null });
    }

    let catalog: Catalog;
    try {
      catalog = parseCatalog(JSON.parse(raw) as unknown);
    } catch (error) {
      issues.push({
        severity: "error",
        code: isAppError(error) && error.code === "UNKNOWN_SCHEMA" ? "CATALOG_SCHEMA_UNKNOWN" : "CATALOG_CORRUPT",
        message: "The catalog could not be read and was left untouched.",
        repairable: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return this.finish({ issues, repaired, repair, deep, revision: null });
    }

    for (const paper of Object.values(catalog.papers)) {
      await this.checkPaper(paper, { repair, deep, issues, repaired });
    }

    await this.checkOrphans(catalog, issues);

    return this.finish({ issues, repaired, repair, deep, revision: catalog.revision });
  }

  private async checkPaper(
    paper: PaperRecord,
    ctx: {
      repair: boolean;
      deep: boolean;
      issues: ReconciliationIssue[];
      repaired: ReconciliationIssue[];
    },
  ): Promise<void> {
    const paperId = paper.paper_id;
    for (const attachment of Object.values(paper.attachments)) {
      await this.checkAttachmentFile(paperId, attachment, ctx);
    }
    await this.checkNote(paper, ctx);
  }

  private async checkAttachmentFile(
    paperId: string,
    attachment: AttachmentRecord,
    ctx: { deep: boolean; issues: ReconciliationIssue[] },
  ): Promise<void> {
    const filePath = this.deps.paths.attachmentFile(
      paperId as never,
      attachment.attachment_id,
    );
    if (attachment.storage_path !== `papers/${paperId}/attachments/${attachment.attachment_id}.pdf`) {
      ctx.issues.push({ severity: "error", code: "ATTACHMENT_PATH_MISMATCH",
        message: "Stored Attachment location differs from its ID-derived location.",
        paper_id: paperId, attachment_id: attachment.attachment_id, repairable: false });
    }
    let exists = true;
    try {
      exists = (await stat(filePath)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      ctx.issues.push({
        severity: "error",
        code: "ATTACHMENT_FILE_MISSING",
        message: `Attachment file for "${attachment.title}" is missing.`,
        paper_id: paperId,
        attachment_id: attachment.attachment_id,
        repairable: false,
      });
      return;
    }
    if (ctx.deep) {
      try {
        const bytes = new Uint8Array(await readFile(filePath));
        const actual = sha256Hex(bytes);
        if (actual !== attachment.sha256) {
          ctx.issues.push({
            severity: "error",
            code: "ATTACHMENT_HASH_MISMATCH",
            message: `Attachment "${attachment.title}" content hash does not match the catalog.`,
            paper_id: paperId,
            attachment_id: attachment.attachment_id,
            repairable: false,
            detail: `expected ${attachment.sha256}, actual ${actual}`,
          });
        }
      } catch (error) {
        ctx.issues.push({
          severity: "error",
          code: "ATTACHMENT_UNREADABLE",
          message: `Attachment "${attachment.title}" could not be read for deep verification.`,
          paper_id: paperId,
          attachment_id: attachment.attachment_id,
          repairable: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async checkNote(
    paper: PaperRecord,
    ctx: {
      repair: boolean;
      issues: ReconciliationIssue[];
      repaired: ReconciliationIssue[];
    },
  ): Promise<void> {
    const paperId = paper.paper_id;
    const existingRaw = await this.readNoteRaw(paperId);
    const managed = {
      paper_id: paperId,
      title: paper.metadata.title,
      doi: paper.metadata.doi,
    };
    if (existingRaw === null) {
      const issue: ReconciliationIssue = {
        severity: "error",
        code: "NOTE_MISSING",
        message: `Paper Note for "${paper.metadata.title}" is missing.`,
        paper_id: paperId,
        repairable: true,
      };
      ctx.issues.push(issue);
      if (ctx.repair) {
        await this.deps.notes.write(paperId, managed, "# Notes\n", null);
        ctx.repaired.push(issue);
      }
      return;
    }
    let stale: ReconciliationIssue | null = null;
    try {
      const parsed = parseNote(existingRaw);
      const managedMatches =
        parsed.managed.paper_id === managed.paper_id &&
        parsed.managed.title === managed.title &&
        (parsed.managed.doi ?? undefined) === (managed.doi ?? undefined);
      if (!managedMatches) {
        stale = {
          severity: "warning",
          code: "NOTE_FRONTMATTER_STALE",
          message: `Paper Note frontmatter for "${paper.metadata.title}" does not match the catalog.`,
          paper_id: paperId,
          repairable: true,
        };
      }
    } catch (error) {
      stale = {
        severity: "error",
        code: "NOTE_FRONTMATTER_INVALID",
        message: `Paper Note frontmatter for "${paper.metadata.title}" is invalid.`,
        paper_id: paperId,
        repairable: true,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (stale) {
      ctx.issues.push(stale);
      if (ctx.repair) {
        let body = "# Notes\n";
        try {
          body = parseNote(existingRaw).body;
        } catch {
          // A closed frontmatter block has an unambiguous body even if YAML
          // is invalid. Without a closing delimiter preserve the entire file.
          const block = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n(?:\r?\n)?/.exec(existingRaw);
          body = block ? existingRaw.slice(block[0].length) : existingRaw;
        }
        await this.deps.notes.write(paperId, managed, body, existingRaw);
        ctx.repaired.push(stale);
      }
    }
  }

  private async checkOrphans(catalog: Catalog, issues: ReconciliationIssue[]): Promise<void> {
    const known = new Set<string>();
    for (const paper of Object.values(catalog.papers)) {
      known.add(this.deps.paths.noteFile(paper.paper_id));
      for (const attachment of Object.values(paper.attachments)) {
        known.add(this.deps.paths.attachmentFile(paper.paper_id, attachment.attachment_id));
      }
    }
    const walk = async (dir: string, kind: "note" | "pdf"): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(path, kind); continue; }
        if (!entry.name.toLowerCase().endsWith(kind === "note" ? ".md" : ".pdf") || known.has(path)) continue;
        const paperCandidate = kind === "note" ? entry.name.slice(0, -3) : dir.split(/[\\/]/).at(-2);
        const attachmentCandidate = entry.name.slice(0, -4);
        issues.push({ severity: "warning", code: kind === "note" ? "ORPHAN_NOTE" : "ORPHAN_PDF",
          message: `An unreferenced ${kind === "note" ? "Paper Note" : "PDF"} was found.`,
          detail: relative(this.deps.paths.root, path),
          paper_id: isPaperId(paperCandidate) ? paperCandidate : undefined,
          attachment_id: kind === "pdf" && isAttachmentId(attachmentCandidate) ? attachmentCandidate : undefined,
          repairable: false });
      }
    };
    await walk(this.deps.paths.notesDir(), "note");
    await walk(this.deps.paths.papersDir(), "pdf");
  }

  private async readNoteRaw(paperId: string): Promise<string | null> {
    try {
      return await readFile(this.deps.paths.noteFile(paperId as never), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private finish(input: {
    issues: ReconciliationIssue[];
    repaired: ReconciliationIssue[];
    repair: boolean;
    deep: boolean;
    revision: number | null;
  }): ReconciliationReport {
    const remaining = input.issues.filter((issue) => !input.repaired.includes(issue));
    const summary = {
      errors: remaining.filter((i) => i.severity === "error").length,
      warnings: remaining.filter((i) => i.severity === "warning").length,
      infos: remaining.filter((i) => i.severity === "info").length,
      repaired: input.repaired.length,
    };
    return {
      generated_at: this.deps.clock.isoNow(),
      mode: input.repair ? "repair" : "report_only",
      deep: input.deep,
      catalog_revision: input.revision,
      issues: remaining.sort((a, b) => a.code.localeCompare(b.code)),
      repaired: input.repaired,
      summary,
    };
  }
}

export function hasBlockingIssues(report: ReconciliationReport): boolean {
  return report.summary.errors > 0;
}

export function reconciliationExitCode(report: ReconciliationReport): number {
  return report.summary.errors > 0 ? 2 : 0;
}

export { AppError };
