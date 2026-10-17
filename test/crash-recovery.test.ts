import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHarness, textBytes, type TestHarness } from './helpers/harness.js';
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { await h.cleanup(); });
const composeUrl = new URL('../src/composition.ts', import.meta.url).href;
it.each(['attachment', 'note', 'catalog'] as const)('reopens a Library after SIGKILL following %s publication', async phase => {
  const upload_id = await h.stage(textBytes(`crash-${phase}`));
  const script = `
    import { compose } from ${JSON.stringify(composeUrl)};
    const { services: s } = await compose({ env: { PAPER_HARNESS_DATA_ROOT: process.argv[1], LLM_PROVIDER: 'fake' },
      pdf: { extract: async () => ({ status: 'ok', page_count: 1, pages: [], embedded_title: null,
        truncated: { bytes: false, pages: false, chars: false }, continuation: null, error: null }) } });
    const crash = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };
    if (process.argv[3] === 'attachment') s.notes.write = crash;
    if (process.argv[3] === 'note') s.catalog.save = crash;
    if (process.argv[3] === 'catalog') s.uploads.remove = crash;
    await s.library.importPaper({ upload_id: process.argv[2] });
  `;
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, h.dir, upload_id, phase])).rejects.toMatchObject({ signal: 'SIGKILL' });
  const report = await h.reconciliation.reconcile({ deep: true });
  const codes = report.issues.map(issue => issue.code);
  if (phase === 'catalog') {
    expect(report.issues).toEqual([]);
    expect(await h.library.listPapers()).toHaveLength(1);
    const paper = (await h.library.listPapers())[0]!;
    expect((await h.noteService.readNote(paper.paper_id)).body).toBe('# Notes\n');
  } else {
    expect(codes).toContain('ORPHAN_PDF');
    expect(codes.includes('ORPHAN_NOTE')).toBe(phase === 'note');
    const repair = await h.reconciliation.reconcile({ repair: true });
    expect(repair.repaired).toEqual([]);
  }
  // Copy semantics preserve the source in all interrupted phases, including a
  // committed import whose staged upload cleanup did not run.
  expect(await h.uploads.get(upload_id as never)).not.toBeNull();
});
