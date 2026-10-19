import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHarness, textBytes, type TestHarness } from './helpers/harness.js';
import { PdfjsReader } from '../src/infrastructure/pdf/pdfjs-reader.js';
import { buildTextPdf } from './fixtures/pdf.js';
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { await h.cleanup(); });
it('extracts bibliographic metadata through the real PDF reader port', async () => {
  const result = await new PdfjsReader().extract(buildTextPdf(undefined, { Subject: "Study abstract", Keywords: "physics; methods", DOI: "10.1/fixture", PublicationTitle: "Fixture Journal", Date: "2025" }));
  expect(result).toMatchObject({ metadata: { title: 'Fixture Title', creators: [{ creator_type: 'author', name: 'Paper Harness Fixture' }], abstract_note: 'Study abstract', tags: ['physics', 'methods'], doi: '10.1/fixture', publication_title: 'Fixture Journal', date: '2025' } });
});
it('fills only empty metadata fields, including blank strings and empty lists', async () => {
  h.pdf.setDefault({ embedded_title: 'Extracted title', metadata: { title: 'Extracted title', creators: [{ creator_type: 'author', name: 'Embedded author' }], abstract_note: 'Embedded abstract', date: '2025', doi: '10.1/extracted', tags: ['extracted'], publication_title: 'Journal' } });
  const upload_id = await h.stage(textBytes('extracted'));
  const { paper } = await h.library.importPaper({ upload_id, metadata: { title: 'Chosen title', creators: [], abstract_note: '   ', date: '2026', tags: ['chosen'] } });
  expect(paper.metadata).toMatchObject({ title: 'Chosen title', creators: [{ creator_type: 'author', name: 'Embedded author' }], abstract_note: 'Embedded abstract', date: '2026', doi: '10.1/extracted', tags: ['chosen'], publication_title: 'Journal' });
});
