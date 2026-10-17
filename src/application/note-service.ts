import { AppError } from "../domain/errors.js";
import type { PaperId } from "../domain/ids.js";
import { isPaperId } from "../domain/ids.js";
import type { ParsedNote } from "../domain/note.js";
import type { CatalogStore, Clock, NoteStore } from "./ports.js";

export type NoteEditMode = "replace" | "append" | "replace_exact";

export interface EditNoteInput {
  paper_id: string;
  mode: NoteEditMode;
  content: string;
  exact?: string;
  expected_revision: string;
}

export interface NoteServiceDeps {
  catalog: CatalogStore;
  notes: NoteStore;
  clock: Clock;
}

export interface NoteView {
  paper_id: PaperId;
  title: string;
  doi: string | null;
  body: string;
  revision: string;
  raw: string;
}

export class NoteService {
  constructor(private readonly deps: NoteServiceDeps) {}

  async readNote(paperIdRaw: string): Promise<NoteView> {
    const paperId = this.requirePaperId(paperIdRaw);
    const note = await this.deps.notes.read(paperId);
    if (!note) {
      throw new AppError("NOT_FOUND", `Paper Note for ${paperId} was not found.`, {
        paper_id: paperId,
      });
    }
    return toView(note);
  }

  async editNote(input: EditNoteInput): Promise<NoteView> {
    const paperId = this.requirePaperId(input.paper_id);
    if (typeof input.expected_revision !== "string" || input.expected_revision === "") {
      throw new AppError("INVALID_INPUT", "expected_revision is required.", {
        field: "expected_revision",
      });
    }
    if (typeof input.content !== "string") {
      throw new AppError("INVALID_INPUT", "content must be a string.", { field: "content" });
    }
    const note = await this.deps.notes.read(paperId);
    if (!note) {
      throw new AppError("NOT_FOUND", `Paper Note for ${paperId} was not found.`, {
        paper_id: paperId,
      });
    }
    if (note.revision !== input.expected_revision) {
      throw new AppError(
        "STALE_REVISION",
        "The Paper Note revision is stale; reread the note and retry.",
        { expected_revision: input.expected_revision, current_revision: note.revision },
      );
    }
    const nextBody = applyEdit(note.body, input);
    const written = await this.deps.notes.write(paperId, note.managed, nextBody, note.raw);
    return toView(written);
  }

  private requirePaperId(value: string): PaperId {
    if (!isPaperId(value)) {
      throw new AppError("INVALID_ID", `"${value}" is not a valid Paper ID.`, { paper_id: value });
    }
    return value;
  }
}

export function applyEdit(body: string, input: Pick<EditNoteInput, "mode" | "content" | "exact">): string {
  switch (input.mode) {
    case "replace":
      return input.content;
    case "append": {
      const separator = body.endsWith("\n") || body === "" ? "" : "\n";
      return `${body}${separator}${input.content}`;
    }
    case "replace_exact": {
      if (input.exact === undefined || input.exact === "") {
        throw new AppError("INVALID_INPUT", "exact is required for replace_exact mode.", {
          field: "exact",
        });
      }
      const first = body.indexOf(input.exact);
      if (first === -1) {
        throw new AppError("CONFLICT", "The exact text to replace was not found in the note.", {});
      }
      const second = body.indexOf(input.exact, first + input.exact.length);
      if (second !== -1) {
        throw new AppError(
          "CONFLICT",
          "The exact text to replace appears more than once; the edit is ambiguous.",
          {},
        );
      }
      return `${body.slice(0, first)}${input.content}${body.slice(first + input.exact.length)}`;
    }
    default:
      throw new AppError("INVALID_INPUT", `Unknown note edit mode "${String(input.mode)}".`, {
        field: "mode",
      });
  }
}

function toView(note: ParsedNote): NoteView {
  return {
    paper_id: note.managed.paper_id,
    title: note.managed.title,
    doi: note.managed.doi ?? null,
    body: note.body,
    revision: note.revision,
    raw: note.raw,
  };
}
