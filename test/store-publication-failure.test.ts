import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { createTestHarness, textBytes, type TestHarness } from './helpers/harness.js';
const fault = vi.hoisted(() => ({ destination: '', retainPdfs: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (path: string, options: any) => {
    if (fault.retainPdfs && path.endsWith('.pdf')) throw new Error('injected rollback failure');
    return actual.rm(path, options);
  }, rename: async (from: string, to: string) => {
    if (to === fault.destination) throw Object.assign(new Error('injected publication failure'), { code: 'EIO' });
    return actual.rename(from, to);
  } };
});
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { fault.destination = ''; fault.retainPdfs = false; await h.cleanup(); });
it('preserves the previous Catalog and leaves no atomic partial when publication fails', async () => {
  const { paper } = await h.library.importPaper({ upload_id: await h.stage(textBytes('first')) });
  const before = await readFile(h.paths.catalogFile(), 'utf8');
  fault.destination = h.paths.catalogFile();
  await expect(h.library.updatePaperMetadata(paper.paper_id, { title: 'lost' }, await h.library.getCatalogRevision())).rejects.toThrow('publication failure');
  expect(await readFile(h.paths.catalogFile(), 'utf8')).toBe(before);
  expect((await readdir(h.dir)).filter(name => name.startsWith('.tmp-'))).toEqual([]);
});
it('preserves the previous note body/revision and leaves no atomic partial when publication fails', async () => {
  const { paper } = await h.library.importPaper({ upload_id: await h.stage(textBytes('first')) });
  const before = await h.noteService.readNote(paper.paper_id);
  fault.destination = h.paths.noteFile(paper.paper_id);
  await expect(h.noteService.editNote({ paper_id: paper.paper_id, mode: 'replace', content: 'lost', expected_revision: before.revision })).rejects.toThrow('publication failure');
  expect(await h.noteService.readNote(paper.paper_id)).toEqual(before);
  expect((await readdir(h.paths.notesDir())).filter(name => name.startsWith('.tmp-'))).toEqual([]);
});
it('rolls back new files on Catalog publication failure without altering existing Library data', async () => {
  const { paper } = await h.library.importPaper({ upload_id: await h.stage(textBytes('first')) });
  const before = await readFile(h.paths.catalogFile(), 'utf8');
  const note = await h.noteService.readNote(paper.paper_id);
  const upload_id = await h.stage(textBytes('second'));
  fault.destination = h.paths.catalogFile();
  await expect(h.library.importPaper({ upload_id })).rejects.toThrow('publication failure');
  expect(await readFile(h.paths.catalogFile(), 'utf8')).toBe(before);
  expect(await h.noteService.readNote(paper.paper_id)).toEqual(note);
  expect(await h.uploads.get(upload_id as never)).not.toBeNull();
  expect((await h.reconciliation.reconcile()).issues).toEqual([]);
});

it('reports deterministic orphans when rollback cannot remove an already published Attachment', async () => {
  const upload_id = await h.stage(textBytes('rollback failure'));
  fault.destination = h.paths.catalogFile();
  fault.retainPdfs = true;
  await expect(h.library.importPaper({ upload_id })).rejects.toThrow('publication failure');
  const report = await h.reconciliation.reconcile({ repair: true });
  expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['CATALOG_MISSING', 'ORPHAN_PDF']));
  expect(report.repaired).toEqual([]);
  expect(await h.uploads.get(upload_id as never)).not.toBeNull();
});
