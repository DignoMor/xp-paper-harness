import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestHarness, textBytes, type TestHarness } from './helpers/harness.js';
import { FileSystemCatalogStore } from '../src/infrastructure/fs/catalog-store.js';
import { FileSystemNoteStore } from '../src/infrastructure/fs/note-store.js';
import { NoteService } from '../src/application/note-service.js';
import { systemClock } from '../src/application/ports.js';
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { vi.restoreAllMocks(); await h.cleanup(); });
async function paper() { return (await h.library.importPaper({ upload_id: await h.stage(textBytes('fixture')) })).paper; }
it('allows only one concurrent edit at a note revision, even across store instances', async () => {
  const p = await paper();
  const n = await h.noteService.readNote(p.paper_id);
  const second = new NoteService({ catalog: h.catalog, notes: new FileSystemNoteStore(h.paths), clock: systemClock });
  const results = await Promise.allSettled([h.noteService, second].map((service, i) => service.editNote({ paper_id: p.paper_id, mode: 'append', content: `edit ${i}`, expected_revision: n.revision })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_REVISION' } });
});
it('serializes Catalog transactions across store instances', async () => {
  const second = new FileSystemCatalogStore(h.paths);
  await Promise.all([h.catalog, second].map(store => store.transact(async current => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { catalog: { ...current, revision: current.revision + 1 }, result: null };
  })));
  expect((await h.catalog.load()).revision).toBe(2);
});
it('rejects a stale direct Catalog save', async () => {
  const initial = await h.catalog.load();
  await h.catalog.save({ ...initial, revision: 1 });
  await expect(h.catalog.save({ ...initial, revision: 1 })).rejects.toMatchObject({ code: 'STALE_REVISION' });
});
it.each(['plain body\n', '---\ntitle: [broken\n---\n\nprecious body\n', '---\nunclosed\nprecious body\n'])('repair preserves malformed note contents: %s', async raw => {
  const p = await paper();
  await writeFile(h.paths.noteFile(p.paper_id), raw);
  await h.reconciliation.reconcile({ repair: true });
  expect(await readFile(h.paths.noteFile(p.paper_id), 'utf8')).toContain(raw.includes('---\n\n') ? 'precious body\n' : raw);
});
it('reports stored path mismatches and nested orphans with arbitrary names', async () => {
  const p = await paper();
  const catalog = await h.catalog.load();
  catalog.papers[p.paper_id]!.attachments[p.primary_attachment_id]!.storage_path = 'papers/wrong.pdf';
  await h.catalog.save({ ...catalog, revision: catalog.revision + 1 });
  await mkdir(join(h.paths.papersDir(), 'legacy', 'nested'), { recursive: true });
  await writeFile(join(h.paths.papersDir(), 'legacy', 'nested', 'lost.PDF'), 'orphan');
  await writeFile(join(h.paths.notesDir(), 'legacy.md'), 'orphan note');
  const report = await h.reconciliation.reconcile();
  expect(report.issues.map(i => i.code)).toEqual(expect.arrayContaining(['ATTACHMENT_PATH_MISMATCH', 'ORPHAN_PDF', 'ORPHAN_NOTE']));
});
it.each(['note', 'catalog'])('rolls back a failed %s publication and retains the upload', async phase => {
  const upload = await h.stage(textBytes('failed import'));
  const fail = vi.spyOn(phase === 'note' ? h.noteStore : h.catalog, phase === 'note' ? 'write' : 'save').mockRejectedValueOnce(new Error('injected store failure'));
  await expect(h.library.importPaper({ upload_id: upload })).rejects.toThrow('injected');
  fail.mockRestore();
  expect(await h.library.listPapers()).toEqual([]);
  expect(await h.uploads.get(upload as never)).not.toBeNull();
  expect((await h.reconciliation.reconcile()).issues.filter(i => i.code.startsWith('ORPHAN'))).toEqual([]);
});
it('detects files left by a crash before Catalog publication, even without a Catalog', async () => {
  await mkdir(h.paths.papersDir(), { recursive: true });
  await mkdir(h.paths.notesDir(), { recursive: true });
  await writeFile(join(h.paths.papersDir(), 'crashed.pdf'), 'published');
  await writeFile(join(h.paths.notesDir(), 'crashed.md'), 'published');
  expect((await h.reconciliation.reconcile()).issues.map(i => i.code)).toEqual(expect.arrayContaining(['ORPHAN_PDF', 'ORPHAN_NOTE']));
});
it('requires revisions for metadata and primary changes and exposes the revision in detail', async () => {
  const p = await paper();
  const detail = await h.library.getPaper(p.paper_id);
  expect(detail).toHaveProperty('catalog_revision', 1);
  await expect(h.library.updatePaperMetadata(p.paper_id, { title: 'unsafe' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(h.library.updateAttachmentMetadata(p.paper_id, p.primary_attachment_id, { title: 'unsafe' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(h.library.setPrimaryAttachment(p.paper_id, p.primary_attachment_id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('concurrent imports cannot register the same bytes twice', async () => {
  const uploads = await Promise.all([h.stage(textBytes('duplicate')), h.stage(textBytes('duplicate'))]);
  const results = await Promise.allSettled(uploads.map(upload_id => h.library.importPaper({ upload_id })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'DUPLICATE_HASH' } });
});
it('rejects one of two Catalog metadata edits sharing an expected revision', async () => {
  const p = await paper();
  const revision = await h.library.getCatalogRevision();
  const outcomes = await Promise.allSettled(['first', 'second'].map(title => h.library.updatePaperMetadata(p.paper_id, { title }, revision)));
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'STALE_REVISION' } });
  expect(await h.library.getCatalogRevision()).toBe(revision + 1);
});
