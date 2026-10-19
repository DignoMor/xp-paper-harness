import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaperDetail } from "../src/domain/paper.js";
import type { PdfExtraction, PdfPage, PdfReadOptions } from "../src/application/ports.js";
import { ReadingService } from "../src/application/reading-service.js";
import type { TestHarness } from "./helpers/harness.js";
import { FakePdfReader, createTestHarness, textBytes } from "./helpers/harness.js";

class OptionAwarePdfReader extends FakePdfReader {
  async extract(bytes: Uint8Array, options?: PdfReadOptions): Promise<PdfExtraction> {
    const base = await super.extract(bytes, options);
    return applyReadOptions(base, options);
  }
}

function applyReadOptions(base: PdfExtraction, options?: PdfReadOptions): PdfExtraction {
  if (!options) return base;

  let pages = base.pages;
  if (options.pages) {
    const wanted = [...new Set(options.pages)].sort((a, b) => a - b);
    pages = wanted
      .map((page) => pages.find((candidate) => candidate.page === page))
      .filter((page): page is PdfPage => page !== undefined);
  }

  let truncated = base.truncated;
  let continuation = base.continuation;

  if (options.maxPages !== undefined && pages.length > options.maxPages) {
    pages = pages.slice(0, options.maxPages);
    truncated = { ...truncated, pages: true };
    continuation = { next_page: (pages[pages.length - 1]?.page ?? 0) + 1 };
  }

  if (options.maxChars !== undefined) {
    let used = 0;
    const kept: PdfPage[] = [];
    for (const page of pages) {
      if (used + page.text.length > options.maxChars) {
        truncated = { ...truncated, chars: true };
        continuation = { next_page: page.page };
        break;
      }
      used += page.text.length;
      kept.push(page);
    }
    pages = kept;
  }

  return { ...base, pages, truncated, continuation };
}

let harness: TestHarness;
let pdf: OptionAwarePdfReader;

beforeEach(async () => {
  pdf = new OptionAwarePdfReader();
  harness = await createTestHarness({ pdf });
});

afterEach(async () => {
  await harness.cleanup();
});

async function importFixture(
  raw: string,
  extraction: Partial<PdfExtraction>,
  options: { title?: string; filename?: string } = {},
): Promise<PaperDetail> {
  const bytes = textBytes(raw);
  pdf.register(bytes, extraction);
  const uploadId = await harness.stage(bytes, options.filename ?? "fixture.pdf");
  const metadata = options.title === undefined ? undefined : { title: options.title };
  const { paper } = await harness.library.importPaper({ upload_id: uploadId, metadata });
  return paper;
}

async function addAttachmentFixture(
  raw: string,
  extraction: Partial<PdfExtraction>,
  paperId: string,
  title: string,
  filename = "supplement.pdf",
): Promise<PaperDetail["attachments"][number]> {
  const bytes = textBytes(raw);
  pdf.register(bytes, extraction);
  const uploadId = await harness.stage(bytes, filename);
  const detail = await harness.library.addAttachment({
    upload_id: uploadId,
    paper_id: paperId,
    title,
  });
  const attachment = detail.attachments.find((candidate) => candidate.title === title);
  if (!attachment) throw new Error(`Attachment "${title}" was not registered.`);
  return attachment;
}

const READING_PAGES: PdfPage[] = [
  { page: 1, text: "Alpha phenomenon introduces the method." },
  { page: 2, text: "Beta phenomenon refines the model." },
  { page: 3, text: "Gamma phenomenon concludes." },
];

describe("ReadingService.readPaper", () => {
  it("defaults to the primary Attachment and returns every page with grounding fields", async () => {
    const paper = await importFixture(
      "reading-basic",
      { pages: READING_PAGES, page_count: 3 },
      { title: "Foundations of Testing", filename: "foundations.pdf" },
    );

    const result = await harness.reading.readPaper({ paper_id: paper.paper_id });

    expect(result.paper_id).toBe(paper.paper_id);
    expect(result.paper_title).toBe("Foundations of Testing");
    expect(result.attachment_id).toBe(paper.primary_attachment_id);
    expect(result.attachment_title).toBe("foundations.pdf");
    expect(result.page_count).toBe(3);
    expect(result.status).toBe("ok");
    expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(result.pages.map((page) => page.text)).toEqual(READING_PAGES.map((page) => page.text));
    expect(result.truncated).toEqual({ bytes: false, pages: false, chars: false });
    expect(result.continuation).toBeNull();
    expect(result.error).toBeNull();
  });

  it("uses the embedded title when no metadata title was provided", async () => {
    const paper = await importFixture(
      "reading-embedded",
      { pages: [{ page: 1, text: "Only page" }], page_count: 1, embedded_title: "Embedded Grounding" },
      { filename: "anonymous.pdf" },
    );
    const result = await harness.reading.readPaper({
      paper_id: paper.paper_id,
      attachment_id: paper.primary_attachment_id,
    });
    expect(result.paper_title).toBe("Embedded Grounding");
    expect(result.attachment_title).toBe("anonymous.pdf");
  });

  it("returns only the requested pages", async () => {
    const paper = await importFixture(
      "reading-pages",
      { pages: READING_PAGES, page_count: 3 },
      { title: "Page Selection" },
    );

    const result = await harness.reading.readPaper({ paper_id: paper.paper_id, pages: [2] });

    expect(result.pages.map((page) => page.page)).toEqual([2]);
    expect(result.pages[0]?.text).toBe("Beta phenomenon refines the model.");
    expect(result.page_count).toBe(3);
  });

  it("follows the primary Attachment after promotion", async () => {
    const paper = await importFixture(
      "reading-primary-a",
      { pages: [{ page: 1, text: "primary text" }], page_count: 1 },
      { title: "Two Attachments", filename: "first.pdf" },
    );
    const second = await addAttachmentFixture(
      "reading-primary-b",
      { pages: [{ page: 1, text: "supplement text" }], page_count: 1 },
      paper.paper_id,
      "Supplement",
    );

    await harness.library.setPrimaryAttachment(paper.paper_id, second.attachment_id, await harness.library.getCatalogRevision());
    const result = await harness.reading.readPaper({ paper_id: paper.paper_id });

    expect(result.attachment_id).toBe(second.attachment_id);
    expect(result.attachment_title).toBe("Supplement");
    expect(result.pages[0]?.text).toBe("supplement text");
  });

  it("surfaces page-boundary truncation and continuation from the reader", async () => {
    const paper = await importFixture(
      "reading-truncated",
      {
        pages: [
          { page: 1, text: "First page" },
          { page: 2, text: "Second page" },
        ],
        page_count: 5,
        truncated: { bytes: false, pages: true, chars: false },
        continuation: { next_page: 3 },
      },
      { title: "Long Document" },
    );

    const result = await harness.reading.readPaper({ paper_id: paper.paper_id });

    expect(result.page_count).toBe(5);
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.truncated.pages).toBe(true);
    expect(result.continuation).toEqual({ next_page: 3 });
  });

  it("honors explicit service limits over the reader options", async () => {
    const paper = await importFixture(
      "reading-limits",
      { pages: READING_PAGES, page_count: 3 },
      { title: "Limit Driven" },
    );

    const focused = new ReadingService({
      catalog: harness.catalog,
      pdf,
      library: harness.library,
      limits: { maxBytes: 10 * 1024 * 1024, maxPages: 1, maxChars: 200_000 },
    });

    const result = await focused.readPaper({ paper_id: paper.paper_id });

    expect(result.pages.map((page) => page.page)).toEqual([1]);
    expect(result.truncated.pages).toBe(true);
    expect(result.continuation).toEqual({ next_page: 2 });
  });

  it("returns unreadable extraction statuses instead of throwing and keeps the Paper registered", async () => {
    const cases = [
      { status: "encrypted", pages: [], error: "Password required" },
      { status: "corrupt", pages: [], error: "Malformed PDF" },
      { status: "image_only", pages: [{ page: 1, text: "" }], error: null },
    ] as const;

    for (const testCase of cases) {
      const paper = await importFixture(
        `reading-${testCase.status}`,
        {
          status: testCase.status,
          pages: [...testCase.pages],
          error: testCase.error,
          embedded_title: null,
        },
        { title: `Unreadable ${testCase.status}` },
      );

      const result = await harness.reading.readPaper({ paper_id: paper.paper_id });
      expect(result.status).toBe(testCase.status);
      if (testCase.error === null) {
        expect(result.error).toBeNull();
      } else {
        expect(result.error).toBeTruthy();
      }

      const stillRegistered = await harness.library.getPaper(paper.paper_id);
      expect(stillRegistered.paper_id).toBe(paper.paper_id);
      expect(stillRegistered.attachments).toHaveLength(1);
    }
  });
});

describe("ReadingService.searchPaper", () => {
  async function buildSearchPaper(): Promise<{
    paper: PaperDetail;
    primary: PaperDetail["attachments"][number];
    supplement: PaperDetail["attachments"][number];
  }> {
    const paper = await importFixture(
      "search-primary",
      {
        pages: [
          { page: 1, text: "Alpha phenomenon introduces the method with a literal a.b token." },
          { page: 2, text: "Beta phenomenon refines the model." },
        ],
        page_count: 2,
      },
      { title: "Searchable Paper", filename: "searchable.pdf" },
    );
    const supplement = await addAttachmentFixture(
      "search-supplement",
      {
        pages: [
          { page: 1, text: "Another alpha mention appears here." },
          { page: 2, text: "ALPHA uppercase and axb but not the literal token." },
        ],
        page_count: 2,
      },
      paper.paper_id,
      "Supplement",
    );
    const primary = paper.attachments.find(
      (candidate) => candidate.attachment_id === paper.primary_attachment_id,
    );
    if (!primary) throw new Error("Primary attachment missing.");
    return { paper, primary, supplement };
  }

  it("searches literally and case-insensitively across all attachments with grounding fields", async () => {
    const { paper, primary, supplement } = await buildSearchPaper();

    const result = await harness.reading.searchPaper({ paper_id: paper.paper_id, query: "alpha" });

    expect(result.query).toBe("alpha");
    expect(result.scanned_attachments).toBe(2);
    expect(result.results).toHaveLength(3);
    expect(new Set(result.results.map((hit) => hit.attachment_id))).toEqual(
      new Set([primary.attachment_id, supplement.attachment_id]),
    );

    for (const hit of result.results) {
      expect(hit.paper_id).toBe(paper.paper_id);
      expect(hit.paper_title).toBe("Searchable Paper");
      expect(typeof hit.attachment_title).toBe("string");
      expect(hit.snippet.toLowerCase()).toContain("alpha");
      expect(Number.isInteger(hit.page)).toBe(true);
      expect(hit.page).toBeGreaterThanOrEqual(1);
    }

    const upper = await harness.reading.searchPaper({ paper_id: paper.paper_id, query: "ALPHA" });
    expect(upper.results).toHaveLength(3);
  });

  it("treats the query as a literal string, not a regular expression", async () => {
    const { paper } = await buildSearchPaper();
    const result = await harness.reading.searchPaper({ paper_id: paper.paper_id, query: "a.b" });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.snippet).toContain("a.b");
  });

  it("narrows to a single attachment when attachment_id is supplied", async () => {
    const { paper, supplement } = await buildSearchPaper();

    const result = await harness.reading.searchPaper({
      paper_id: paper.paper_id,
      query: "alpha",
      attachment_id: supplement.attachment_id,
    });

    expect(result.scanned_attachments).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((hit) => hit.attachment_id === supplement.attachment_id)).toBe(true);
  });

  it("respects max_results", async () => {
    const { paper } = await buildSearchPaper();
    const result = await harness.reading.searchPaper({
      paper_id: paper.paper_id,
      query: "alpha",
      max_results: 1,
    });
    expect(result.results).toHaveLength(1);
  });

  it("bounds the snippet around a match in a long page", async () => {
    const pageText = `${"x".repeat(300)} needle ${"y".repeat(300)}`;
    const paper = await importFixture(
      "search-snippet",
      { pages: [{ page: 1, text: pageText }], page_count: 1 },
      { title: "Snippet Bound" },
    );

    const result = await harness.reading.searchPaper({ paper_id: paper.paper_id, query: "needle" });

    expect(result.results).toHaveLength(1);
    const snippet = result.results[0]?.snippet ?? "";
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBeLessThan(200);
  });

  it("returns no fabricated pages when the text does not exist", async () => {
    const { paper } = await buildSearchPaper();
    const result = await harness.reading.searchPaper({
      paper_id: paper.paper_id,
      query: "nonexistent-token-xyz",
    });
    expect(result.results).toEqual([]);
    expect(result.scanned_attachments).toBe(2);
  });
});
