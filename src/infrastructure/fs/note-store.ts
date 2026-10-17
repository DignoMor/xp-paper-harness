import { AppError } from "../../domain/errors.js";
import { withFileLock } from "./lock.js";
import { readFile, readdir } from "node:fs/promises";
import { extname } from "node:path";
import { parseNote, serializeNote, type ManagedFrontmatter, type ParsedNote } from "../../domain/note.js";
import { isPaperId, type PaperId } from "../../domain/ids.js";
import type { DataPaths, NoteStore } from "../../application/ports.js";
import { atomicWriteFile, ensureDir, removeIfExists } from "./atomic.js";
import { isNotFound } from "./errors.js";

export class FileSystemNoteStore implements NoteStore {
  constructor(private readonly paths: DataPaths) {}

  private async readRawFile(paperId: PaperId): Promise<string | null> {
    try {
      return await readFile(this.paths.noteFile(paperId), "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(paperId: PaperId): Promise<ParsedNote | null> {
    const raw = await this.readRawFile(paperId);
    if (raw === null) return null;
    return parseNote(raw);
  }

  async exists(paperId: PaperId): Promise<boolean> {
    return (await this.readRawFile(paperId)) !== null;
  }

  async write(
    paperId: PaperId,
    managed: ManagedFrontmatter,
    body: string,
    expectedRaw: string | null,
  ): Promise<ParsedNote> {
    return withFileLock(this.paths.noteFile(paperId), async () => {
      const current = await this.readRawFile(paperId);
      if (current !== expectedRaw) {
        throw new AppError("STALE_REVISION", "The Paper Note changed; reread it and retry.", {});
      }
      await ensureDir(this.paths.notesDir());
      const raw = serializeNote({ ...managed, paper_id: paperId }, body);
      await atomicWriteFile(this.paths.noteFile(paperId), raw);
      return parseNote(raw);
    });
  }

  async listPaperIds(): Promise<PaperId[]> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.notesDir());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const ids: PaperId[] = [];
    for (const entry of entries) {
      if (extname(entry) !== ".md") continue;
      const candidate = entry.slice(0, -3);
      if (isPaperId(candidate)) ids.push(candidate);
    }
    return ids;
  }

  async remove(paperId: PaperId): Promise<void> {
    await removeIfExists(this.paths.noteFile(paperId));
  }
}


