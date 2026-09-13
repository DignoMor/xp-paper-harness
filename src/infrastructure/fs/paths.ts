import { join } from "node:path";
import type { AttachmentId, PaperId } from "../../domain/ids.js";
import type { DataPaths } from "../../application/ports.js";

export class FileSystemDataPaths implements DataPaths {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  catalogFile(): string {
    return join(this.root, "catalog.json");
  }

  papersDir(): string {
    return join(this.root, "papers");
  }

  attachmentsDir(paperId: PaperId): string {
    return join(this.papersDir(), paperId, "attachments");
  }

  attachmentFile(paperId: PaperId, attachmentId: AttachmentId): string {
    return join(this.attachmentsDir(paperId), `${attachmentId}.pdf`);
  }

  notesDir(): string {
    return join(this.root, "notes");
  }

  noteFile(paperId: PaperId): string {
    return join(this.notesDir(), `${paperId}.md`);
  }

  sessionsDir(): string {
    return join(this.root, "sessions");
  }

  sessionFile(conversationId: string): string {
    return join(this.sessionsDir(), `${conversationId}.jsonl`);
  }

  uploadsDir(): string {
    return join(this.root, "uploads");
  }

  tmpDir(): string {
    return join(this.root, "tmp");
  }
}
