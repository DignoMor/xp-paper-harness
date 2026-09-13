import { createWriteStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { join } from "node:path";
import { AppError } from "../../domain/errors.js";
import { isUploadId, type UploadId } from "../../domain/ids.js";
import type { DataPaths, StagedUpload, UploadStore } from "../../application/ports.js";
import { atomicWriteFile, ensureDir, removeIfExists } from "./atomic.js";
import { randomBytes } from "node:crypto";

interface UploadMeta {
  upload_id: UploadId;
  original_filename: string;
  media_type: string;
  byte_size: number;
  staged_at: string;
}

export class FileSystemUploadStore implements UploadStore {
  constructor(
    private readonly paths: DataPaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private dataFile(uploadId: UploadId): string {
    return join(this.paths.uploadsDir(), `${uploadId}.pdf`);
  }

  private metaFile(uploadId: UploadId): string {
    return join(this.paths.uploadsDir(), `${uploadId}.meta.json`);
  }

  async stage(
    uploadId: UploadId,
    source: Readable,
    opts: { originalFilename: string; mediaType: string; maxBytes: number },
  ): Promise<StagedUpload> {
    await ensureDir(this.paths.uploadsDir());
    const tmpPath = join(
      this.paths.uploadsDir(),
      `.upload-${randomBytes(8).toString("hex")}.part`,
    );
    let byteSize = 0;
    const limiter = new Transform({
      transform: (chunk: Buffer, _enc, callback) => {
        byteSize += chunk.length;
        if (byteSize > opts.maxBytes) {
          callback(
            new AppError("OVERSIZED", "The uploaded PDF exceeds the configured size limit.", {
              max_bytes: opts.maxBytes,
            }),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    const stagedAt = this.now().toISOString();
    try {
      await pipeline(source, limiter, createWriteStream(tmpPath));
    } catch (error) {
      await removeIfExists(tmpPath);
      if (error instanceof AppError) throw error;
      throw new AppError("INVALID_UPLOAD", "The upload stream failed before completion.", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (byteSize === 0) {
      await removeIfExists(tmpPath);
      throw new AppError("INVALID_UPLOAD", "The uploaded PDF is empty.", {});
    }
    await ensureDir(this.paths.uploadsDir());
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, this.dataFile(uploadId));
    const meta: UploadMeta = {
      upload_id: uploadId,
      original_filename: opts.originalFilename,
      media_type: opts.mediaType,
      byte_size: byteSize,
      staged_at: stagedAt,
    };
    await atomicWriteFile(this.metaFile(uploadId), `${JSON.stringify(meta, null, 2)}\n`);
    return { ...meta, path: this.dataFile(uploadId) };
  }

  async get(uploadId: UploadId): Promise<StagedUpload | null> {
    const meta = await this.readMeta(uploadId);
    if (!meta) return null;
    try {
      const info = await stat(this.dataFile(uploadId));
      return { ...meta, byte_size: info.size, path: this.dataFile(uploadId) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readBytes(uploadId: UploadId): Promise<Uint8Array | null> {
    const upload = await this.get(uploadId);
    if (!upload) return null;
    return new Uint8Array(await readFile(this.dataFile(uploadId)));
  }

  async remove(uploadId: UploadId): Promise<void> {
    await Promise.all([
      removeIfExists(this.dataFile(uploadId)),
      removeIfExists(this.metaFile(uploadId)),
    ]);
  }

  async list(): Promise<StagedUpload[]> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.uploadsDir());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const uploads: StagedUpload[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      const candidate = entry.slice(0, -".meta.json".length);
      if (!isUploadId(candidate)) continue;
      const upload = await this.get(candidate);
      if (upload) uploads.push(upload);
    }
    return uploads;
  }

  async purgeExpired(maxAgeMs: number): Promise<number> {
    const cutoff = this.now().getTime() - maxAgeMs;
    const uploads = await this.list();
    let purged = 0;
    for (const upload of uploads) {
      const stagedAt = Date.parse(upload.staged_at);
      if (Number.isNaN(stagedAt) || stagedAt < cutoff) {
        await this.remove(upload.upload_id);
        purged += 1;
      }
    }
    return purged;
  }

  private async readMeta(uploadId: UploadId): Promise<UploadMeta | null> {
    try {
      const raw = await readFile(this.metaFile(uploadId), "utf8");
      return JSON.parse(raw) as UploadMeta;
    } catch (error) {
      if (isNotFound(error)) return null;
      return null;
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
