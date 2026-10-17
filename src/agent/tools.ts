import { AppError } from "../domain/errors.js";
import type { LibraryService } from "../application/library-service.js";
import type { NoteService, NoteView } from "../application/note-service.js";
import type { ReadingService } from "../application/reading-service.js";
import type { ReconciliationService } from "../application/reconciliation-service.js";
import { APPROVED_TOOL_NAMES } from "./system-prompt.js";

export interface AgentToolContext {
  library: LibraryService;
  notes: NoteService;
  reading: ReadingService;
  reconciliation: ReconciliationService;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be a non-empty string.`, {
      field: key,
    });
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be a string.`, { field: key });
  }
  return value;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be a number.`, { field: key });
  }
  return value;
}

function optionalObjectArg(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be an object.`, { field: key });
  }
  return value as Record<string, unknown>;
}

function optionalStringArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be an array of strings.`, {
      field: key,
    });
  }
  return value as string[];
}

export function createPaperTools(): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: "import_paper",
      description:
        "Import a staged PDF upload as a new Paper (Paper ID, Primary Attachment, Catalog record, and Paper Note). On a matching DOI, choose mode 'new' or 'attach' with existing_paper_id.",
      parameters: objectSchema(
        {
          upload_id: { type: "string", description: "Staged upload ID from the browser upload." },
          metadata: { type: "object", description: "Optional Paper Metadata fields to set." },
          mode: { type: "string", enum: ["new", "attach"] },
          existing_paper_id: { type: "string" },
          expected_revision: { type: "number" },
        },
        ["upload_id"],
      ),
      handler: async (args, ctx) =>
        ctx.library.importPaper({
          upload_id: requireStringArg(args, "upload_id"),
          metadata: optionalObjectArg(args, "metadata"),
          mode: optionalStringArg(args, "mode") as "new" | "attach" | undefined,
          existing_paper_id: optionalStringArg(args, "existing_paper_id"),
          expected_revision: optionalNumberArg(args, "expected_revision"),
        }),
    },
    {
      name: "add_attachment",
      description: "Add a staged PDF upload as a supplementary Attachment to an existing Paper.",
      parameters: objectSchema(
        {
          upload_id: { type: "string" },
          paper_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          expected_revision: { type: "number" },
        },
        ["upload_id", "paper_id"],
      ),
      handler: async (args, ctx) =>
        ctx.library.addAttachment({
          upload_id: requireStringArg(args, "upload_id"),
          paper_id: requireStringArg(args, "paper_id"),
          title: optionalStringArg(args, "title"),
          description: optionalStringArg(args, "description"),
          expected_revision: optionalNumberArg(args, "expected_revision"),
        }),
    },
    {
      name: "list_papers",
      description: "List compact summaries of all Papers in the Library.",
      parameters: objectSchema({}),
      handler: async (_args, ctx) => ctx.library.listPapers(),
    },
    {
      name: "get_paper",
      description: "Get full metadata, Attachment details, and catalog_revision for revision-checked edits.",
      parameters: objectSchema({ paper_id: { type: "string" } }, ["paper_id"]),
      handler: async (args, ctx) => ctx.library.getPaper(requireStringArg(args, "paper_id")),
    },
    {
      name: "update_paper_metadata",
      description: "Patch editable Paper Metadata fields. Requires expected_revision from get_paper. Identity and storage locations are immutable.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          patch: { type: "object" },
          expected_revision: { type: "number" },
        },
        ["paper_id", "patch", "expected_revision"],
      ),
      handler: async (args, ctx) =>
        ctx.library.updatePaperMetadata(
          requireStringArg(args, "paper_id"),
          optionalObjectArg(args, "patch") ?? {},
          optionalNumberArg(args, "expected_revision"),
        ),
    },
    {
      name: "update_attachment_metadata",
      description: "Patch an Attachment's editable title or description.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          attachment_id: { type: "string" },
          patch: { type: "object" },
          expected_revision: { type: "number" },
        },
        ["paper_id", "attachment_id", "patch", "expected_revision"],
      ),
      handler: async (args, ctx) =>
        ctx.library.updateAttachmentMetadata(
          requireStringArg(args, "paper_id"),
          requireStringArg(args, "attachment_id"),
          optionalObjectArg(args, "patch") ?? {},
          optionalNumberArg(args, "expected_revision"),
        ),
    },
    {
      name: "set_primary_attachment",
      description: "Promote an Attachment to the Paper's Primary Attachment without deleting the former primary.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          attachment_id: { type: "string" },
          expected_revision: { type: "number" },
        },
        ["paper_id", "attachment_id", "expected_revision"],
      ),
      handler: async (args, ctx) =>
        ctx.library.setPrimaryAttachment(
          requireStringArg(args, "paper_id"),
          requireStringArg(args, "attachment_id"),
          optionalNumberArg(args, "expected_revision"),
        ),
    },
    {
      name: "read_paper",
      description:
        "Read bounded, page-aware text from a Paper's Attachment (defaults to the Primary Attachment and all pages). Returns page numbers for citations and continuation guidance when truncated.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          attachment_id: { type: "string" },
          pages: { type: "array", items: { type: "number" } },
        },
        ["paper_id"],
      ),
      handler: async (args, ctx) =>
        ctx.reading.readPaper({
          paper_id: requireStringArg(args, "paper_id"),
          attachment_id: optionalStringArg(args, "attachment_id"),
          pages: optionalNumberArrayArg(args, "pages"),
        }),
    },
    {
      name: "search_paper",
      description:
        "Literal case-insensitive search across a Paper's Attachments. Returns Attachment identity, PDF page, and a bounded snippet.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          query: { type: "string" },
          attachment_id: { type: "string" },
          max_results: { type: "number" },
        },
        ["paper_id", "query"],
      ),
      handler: async (args, ctx) =>
        ctx.reading.searchPaper({
          paper_id: requireStringArg(args, "paper_id"),
          query: requireStringArg(args, "query"),
          attachment_id: optionalStringArg(args, "attachment_id"),
          max_results: optionalNumberArg(args, "max_results"),
        }),
    },
    {
      name: "read_note",
      description: "Read the Paper Note body and its current revision.",
      parameters: objectSchema({ paper_id: { type: "string" } }, ["paper_id"]),
      handler: async (args, ctx): Promise<NoteView> => ctx.notes.readNote(requireStringArg(args, "paper_id")),
    },
    {
      name: "edit_note",
      description:
        "Edit a Paper Note body by replace, append, or replace_exact. Requires the current revision; managed frontmatter cannot be changed.",
      parameters: objectSchema(
        {
          paper_id: { type: "string" },
          mode: { type: "string", enum: ["replace", "append", "replace_exact"] },
          content: { type: "string" },
          exact: { type: "string" },
          expected_revision: { type: "string" },
        },
        ["paper_id", "mode", "content", "expected_revision"],
      ),
      handler: async (args, ctx) =>
        ctx.notes.editNote({
          paper_id: requireStringArg(args, "paper_id"),
          mode: requireStringArg(args, "mode") as "replace" | "append" | "replace_exact",
          content: optionalStringArg(args, "content") ?? "",
          exact: optionalStringArg(args, "exact"),
          expected_revision: requireStringArg(args, "expected_revision"),
        }),
    },
    {
      name: "reconcile_library",
      description:
        "Inspect Library consistency. Report-only by default; set repair to fix known-safe states and deep to recompute hashes.",
      parameters: objectSchema({
        repair: { type: "boolean" },
        deep: { type: "boolean" },
      }),
      handler: async (args, ctx) =>
        ctx.reconciliation.reconcile({
          repair: args.repair === true,
          deep: args.deep === true,
        }),
    },
  ];
  return tools;
}

function optionalNumberArrayArg(args: Record<string, unknown>, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new AppError("INVALID_INPUT", `Tool argument "${key}" must be an array of numbers.`, {
      field: key,
    });
  }
  return value as number[];
}

export async function executeTool(
  tools: AgentTool[],
  name: string,
  rawArguments: string,
  ctx: AgentToolContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: AppError }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      error: new AppError("INVALID_INPUT", `Unknown tool "${name}".`, { tool: name }),
    };
  }
  let parsed: Record<string, unknown>;
  if (rawArguments.trim() === "") {
    parsed = {};
  } else {
    try {
      const value = JSON.parse(rawArguments) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("arguments must be an object");
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        error: new AppError("INVALID_INPUT", `Tool "${name}" received invalid JSON arguments.`, {
          tool: name,
          detail: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  try {
    return { ok: true, result: await tool.handler(parsed, ctx) };
  } catch (error) {
    if (error instanceof AppError) return { ok: false, error };
    return {
      ok: false,
      error: new AppError("INTERNAL", `Tool "${name}" failed unexpectedly.`, {
        tool: name,
        detail: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

export { APPROVED_TOOL_NAMES };
