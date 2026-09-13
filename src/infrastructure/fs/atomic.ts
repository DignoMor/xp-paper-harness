import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function atomicWriteFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    await writeFile(tmp, data);
    const handle = await open(tmp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removeIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true, recursive: true }).catch(() => {});
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256String(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}
