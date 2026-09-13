import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { AppError } from "./errors.js";
import type { PaperId } from "./ids.js";

export interface ManagedFrontmatter {
  paper_id: PaperId;
  title: string;
  doi?: string;
}

export interface ParsedNote {
  managed: ManagedFrontmatter;
  body: string;
  revision: string;
  raw: string;
}

export function noteRevision(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

export function serializeNote(managed: ManagedFrontmatter, body: string): string {
  const frontmatter: Record<string, string> = {
    paper_id: managed.paper_id,
    title: managed.title,
  };
  if (managed.doi) frontmatter.doi = managed.doi;
  const yamlText = yaml.dump(frontmatter, { lineWidth: 120, noRefs: true }).trimEnd();
  return `---\n${yamlText}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function parseNote(raw: string): ParsedNote {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(?:\r?\n)?/.exec(raw);
  if (!match) {
    throw new AppError(
      "CORRUPT_CATALOG",
      "Paper Note is missing managed frontmatter.",
      { reason: "missing_frontmatter" },
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(match[1]!);
  } catch (error) {
    throw new AppError("CORRUPT_CATALOG", "Paper Note frontmatter is not valid YAML.", {
      reason: "invalid_yaml",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("CORRUPT_CATALOG", "Paper Note frontmatter must be a mapping.", {});
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "paper_id" && key !== "title" && key !== "doi") {
      throw new AppError(
        "CORRUPT_CATALOG",
        `Paper Note frontmatter contains an unsupported field "${key}".`,
        { reason: "unknown_frontmatter_field", field: key },
      );
    }
  }
  const paperId = record.paper_id;
  const title = record.title;
  if (typeof paperId !== "string" || typeof title !== "string") {
    throw new AppError(
      "CORRUPT_CATALOG",
      "Paper Note frontmatter must contain paper_id and title.",
      {},
    );
  }
  const managed: ManagedFrontmatter = { paper_id: paperId as PaperId, title };
  if (typeof record.doi === "string" && record.doi !== "") managed.doi = record.doi;
  const body = raw.slice(match[0].length);
  return { managed, body, revision: noteRevision(body), raw };
}
