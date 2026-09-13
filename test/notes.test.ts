import { chmod, readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TestHarness } from "./helpers/harness.js";
import { createTestHarness, textBytes } from "./helpers/harness.js";
import { newPaperId } from "../src/domain/ids.js";
import { noteRevision, parseNote } from "../src/domain/note.js";

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

async function importPaper(
  raw: string,
  options: { title?: string; doi?: string; filename?: string } = {},
): Promise<string> {
  const bytes = textBytes(raw);
  harness.pdf.register(bytes, { pages: [{ page: 1, text: raw }], embedded_title: null });
  const uploadId = await harness.stage(bytes, options.filename ?? "note-fixture.pdf");
  const metadata: Record<string, unknown> = { title: options.title ?? "Note Fixture" };
  if (options.doi !== undefined) metadata.doi = options.doi;
  const { paper } = await harness.library.importPaper({ upload_id: uploadId, metadata });
  return paper.paper_id;
}

function bodyOf(note: { body: string }): string {
  return note.body.replace(/^\n+/, "");
}

describe("NoteService.readNote", () => {
  it("returns the body, revision, title, doi, and raw note for a fresh Paper", async () => {
    const paperId = await importPaper("note-fresh");
    const note = await harness.noteService.readNote(paperId);

    expect(note.paper_id).toBe(paperId);
    expect(note.title).toBe("Note Fixture");
    expect(note.doi).toBeNull();
    expect(typeof note.body).toBe("string");
    expect(note.body).toContain("# Notes");
    expect(note.revision).toBe(noteRevision(note.body));
    expect(note.raw.startsWith("---\n")).toBe(true);
  });

  it("carries the Paper DOI when one was provided", async () => {
    const paperId = await importPaper("note-doi", { doi: "10.1234/AbC" });
    const note = await harness.noteService.readNote(paperId);
    expect(note.doi).toBe("10.1234/AbC");
    expect(note.raw).toContain("doi: 10.1234/AbC");
  });

  it("keeps the revision stable across repeated reads and changes it when the body changes", async () => {
    const paperId = await importPaper("note-revision");
    const first = await harness.noteService.readNote(paperId);
    const second = await harness.noteService.readNote(paperId);
    expect(second.revision).toBe(first.revision);
    expect(second.body).toBe(first.body);

    const edited = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: "A completely different body.",
      expected_revision: first.revision,
    });
    expect(edited.revision).not.toBe(first.revision);
    expect(bodyOf(edited)).toBe("A completely different body.");
    expect(edited.revision).toBe(noteRevision(edited.body));

    const third = await harness.noteService.readNote(paperId);
    expect(third.revision).toBe(edited.revision);
    expect(bodyOf(third)).toBe("A completely different body.");
  });

  it("throws NOT_FOUND for a Paper without a note", async () => {
    await expect(harness.noteService.readNote(newPaperId())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("NoteService.editNote modes", () => {
  it("replace swaps the whole body", async () => {
    const paperId = await importPaper("note-replace");
    const before = await harness.noteService.readNote(paperId);

    const after = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: "Replaced body",
      expected_revision: before.revision,
    });

    expect(bodyOf(after)).toBe("Replaced body");
    expect(bodyOf(await harness.noteService.readNote(paperId))).toBe("Replaced body");
  });

  it("append adds to the end of the existing body", async () => {
    const paperId = await importPaper("note-append");
    const before = await harness.noteService.readNote(paperId);

    const after = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "append",
      content: "Appended line",
      expected_revision: before.revision,
    });

    expect(after.body.startsWith(before.body)).toBe(true);
    expect(after.body.endsWith("Appended line")).toBe(true);
  });

  it("replace_exact replaces a unique substring", async () => {
    const paperId = await importPaper("note-replace-exact");
    const base = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: "alpha beta gamma",
      expected_revision: (await harness.noteService.readNote(paperId)).revision,
    });

    const after = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace_exact",
      exact: "beta",
      content: "BETA",
      expected_revision: base.revision,
    });

    expect(bodyOf(after)).toBe("alpha BETA gamma");
  });

  it("requires the current expected_revision for every mode", async () => {
    const paperId = await importPaper("note-requires-revision");
    const revision = (await harness.noteService.readNote(paperId)).revision;

    for (const mode of ["replace", "append"] as const) {
      await expect(
        harness.noteService.editNote({
          paper_id: paperId,
          mode,
          content: "x",
          expected_revision: "",
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "replace_exact",
        exact: "x",
        content: "y",
        expected_revision: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const unchanged = await harness.noteService.readNote(paperId);
    expect(unchanged.revision).toBe(revision);
  });
});

describe("NoteService.editNote concurrency safety", () => {
  it("rejects a stale expected_revision with the current revision and leaves the note unchanged", async () => {
    const paperId = await importPaper("note-stale");
    const original = await harness.noteService.readNote(paperId);

    await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: "first edit",
      expected_revision: original.revision,
    });
    const current = await harness.noteService.readNote(paperId);

    let captured: { code?: string; details?: Record<string, unknown> } | undefined;
    try {
      await harness.noteService.editNote({
        paper_id: paperId,
        mode: "replace",
        content: "second edit",
        expected_revision: original.revision,
      });
    } catch (error) {
      captured = error as { code?: string; details?: Record<string, unknown> };
    }

    expect(captured?.code).toBe("STALE_REVISION");
    expect(captured?.details?.expected_revision).toBe(original.revision);
    expect(captured?.details?.current_revision).toBe(current.revision);

    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "append",
        content: "stale append",
        expected_revision: original.revision,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "replace_exact",
        exact: "first",
        content: "FIRST",
        expected_revision: original.revision,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    const after = await harness.noteService.readNote(paperId);
    expect(bodyOf(after)).toBe("first edit");
    expect(after.revision).toBe(current.revision);
  });

  it("rejects replace_exact when the exact text is absent or ambiguous and leaves the note unchanged", async () => {
    const paperId = await importPaper("note-conflict");
    const base = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: "alpha beta alpha",
      expected_revision: (await harness.noteService.readNote(paperId)).revision,
    });

    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "replace_exact",
        exact: "absent-token",
        content: "anything",
        expected_revision: base.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "replace_exact",
        exact: "alpha",
        content: "ALPHA",
        expected_revision: base.revision,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const after = await harness.noteService.readNote(paperId);
    expect(bodyOf(after)).toBe("alpha beta alpha");
    expect(after.revision).toBe(base.revision);
  });
});

describe("NoteService managed frontmatter protection", () => {
  it("cannot be changed through body edits and tolerates YAML-looking bodies", async () => {
    const paperId = await importPaper("note-frontmatter", {
      title: "Managed Title",
      doi: "10.9999/managed",
    });
    const original = await harness.noteService.readNote(paperId);
    const originalManaged = parseNote(original.raw).managed;

    const hostileBody = "---\npaper_id: ppr_evil\ntitle: Hijacked\n---\n\n# Hijack attempt";
    const edited = await harness.noteService.editNote({
      paper_id: paperId,
      mode: "replace",
      content: hostileBody,
      expected_revision: original.revision,
    });

    expect(edited.raw).toContain("paper_id");
    expect(edited.raw).toContain("Managed Title");
    const parsed = parseNote(edited.raw);
    expect(parsed.managed).toEqual(originalManaged);
    expect(parsed.managed.paper_id).toBe(paperId);
    expect(parsed.managed.title).toBe("Managed Title");
    expect(parsed.managed.doi).toBe("10.9999/managed");
    expect(parsed.body).toContain("# Hijack attempt");
  });

  it("stores no attachment paths in the imported note frontmatter", async () => {
    const paperId = await importPaper("note-no-attachments");
    const note = await harness.noteService.readNote(paperId);
    expect(note.raw).not.toContain("storage_path");
    expect(note.raw).not.toContain("att_");
  });
});

describe("NoteService atomic writes", () => {
  it("rejects an unknown mode before writing and leaves the previous note intact", async () => {
    const paperId = await importPaper("note-bad-mode");
    const before = await harness.noteService.readNote(paperId);

    await expect(
      harness.noteService.editNote({
        paper_id: paperId,
        mode: "bogus" as never,
        content: "should not land",
        expected_revision: before.revision,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const after = await harness.noteService.readNote(paperId);
    expect(after.body).toBe(before.body);
    expect(after.revision).toBe(before.revision);
  });

  const canEnforcePermissions = process.getuid?.() !== 0;

  it.skipIf(!canEnforcePermissions)(
    "preserves the previous note and leaves no temp files when the write fails",
    async () => {
      const paperId = await importPaper("note-write-failure");
      const before = await harness.noteService.readNote(paperId);
      const notesDir = harness.paths.notesDir();

      await chmod(notesDir, 0o555);
      try {
        await expect(
          harness.noteService.editNote({
            paper_id: paperId,
            mode: "replace",
            content: "this write must fail",
            expected_revision: before.revision,
          }),
        ).rejects.toBeInstanceOf(Error);
      } finally {
        await chmod(notesDir, 0o755);
      }

      const after = await harness.noteService.readNote(paperId);
      expect(after.body).toBe(before.body);
      expect(after.revision).toBe(before.revision);

      const entries = await readdir(notesDir);
      expect(entries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
    },
  );
});
