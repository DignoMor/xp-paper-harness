import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, readdir, utimes, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createTestHarness, textBytes, type TestHarness } from './helpers/harness.js';
import { uuidv7 } from '../src/domain/ids.js';
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { await h.cleanup(); });
it('expires complete, metadata-less, malformed, and partial uploads while preserving recent uploads', async () => {
  const recent = await h.stage(textBytes('recent'));
  const expired = await h.stage(textBytes('expired'));
  const root = h.paths.uploadsDir();
  const meta = join(root, `${expired}.meta.json`);
  const parsed = JSON.parse(await readFile(meta, 'utf8'));
  parsed.staged_at = new Date(0).toISOString();
  await writeFile(meta, JSON.stringify(parsed));
  const oldFiles = [`upl_${uuidv7()}.pdf`, `upl_${uuidv7()}.meta.json`, '.upload-0123456789abcdef.part'];
  for (const name of oldFiles) {
    const path = join(root, name);
    await writeFile(path, 'invalid metadata or abandoned bytes');
    await utimes(path, new Date(0), new Date(0));
  }
  await h.uploads.purgeExpired(24 * 3600_000);
  expect((await readdir(root)).sort()).toEqual([`${recent}.meta.json`, `${recent}.pdf`].sort());
});
it('cleans an interrupted upload and leaves no staged data', async () => {
  async function* broken() { yield Buffer.from('partial'); throw new Error('/private/secret'); }
  await expect(h.uploads.stage(`upl_${uuidv7()}`, Readable.from(broken()), { originalFilename: 'paper.pdf', mediaType: 'application/pdf', maxBytes: 1000 })).rejects.toMatchObject({ code: 'INVALID_UPLOAD' });
  expect(await readdir(h.paths.uploadsDir())).toEqual([]);
});
it('rolls back PDF publication if upload metadata publication fails', async () => {
  const id = `upl_${uuidv7()}` as const;
  await mkdir(join(h.paths.uploadsDir(), `${id}.meta.json`), { recursive: true });
  await expect(h.uploads.stage(id, Readable.from(['pdf']), { originalFilename: 'paper.pdf', mediaType: 'application/pdf', maxBytes: 1000 })).rejects.toThrow();
  expect((await readdir(h.paths.uploadsDir())).filter(name => name.endsWith('.pdf') || name.startsWith('.tmp-') || name.endsWith('.part'))).toEqual([]);
});
it('cleans crash-left atomic staging without removing published files or following symlinks', async () => {
  const { cleanupAtomicTemps } = await import('../src/infrastructure/fs/atomic.js');
  await mkdir(h.paths.notesDir(), { recursive: true });
  const temp = join(h.paths.notesDir(), '.tmp-0123456789abcdef');
  const published = join(h.paths.notesDir(), 'preserved.md');
  await writeFile(temp, 'partial');
  await writeFile(published, 'precious');
  expect(await cleanupAtomicTemps(h.dir)).toBe(1);
  expect(await readFile(published, 'utf8')).toBe('precious');
  expect(await readdir(h.paths.notesDir())).toEqual(['preserved.md']);
});
