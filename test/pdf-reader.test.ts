import { describe, expect, it } from "vitest";
import { PdfjsReader, createPdfjsReader } from "../src/infrastructure/pdf/pdfjs-reader.js";
import {
  FIXTURE_PAGE_TEXTS,
  FIXTURE_TITLE,
  buildTextFreePdf,
  buildTextPdf,
} from "./fixtures/pdf.js";

const reader = createPdfjsReader();

describe("PdfjsReader", () => {
  it("is exposed as both a class and a factory", () => {
    expect(new PdfjsReader()).toBeInstanceOf(PdfjsReader);
    expect(reader.extract).toBeTypeOf("function");
  });

  it("reads the page count and embedded title", async () => {
    const result = await reader.extract(buildTextPdf());

    expect(result.status).toBe("ok");
    expect(result.page_count).toBe(3);
    expect(result.embedded_title).toBe(FIXTURE_TITLE);
    expect(result.error).toBeNull();
    expect(result.truncated).toEqual({ bytes: false, pages: false, chars: false });
    expect(result.continuation).toBeNull();
  });

  it("returns all pages in order by default", async () => {
    const result = await reader.extract(buildTextPdf());

    expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(result.pages.map((page) => page.text)).toEqual([...FIXTURE_PAGE_TEXTS]);
  });

  it("extracts only explicitly requested pages", async () => {
    const result = await reader.extract(buildTextPdf(), { pages: [2] });

    expect(result.page_count).toBe(3);
    expect(result.pages.map((page) => page.page)).toEqual([2]);
    expect(result.pages[0]?.text).toContain("Page Two Bravo");
  });

  it("dedupes, sorts, and ignores out-of-range page requests", async () => {
    const result = await reader.extract(buildTextPdf(), { pages: [3, 1, 3, 0, 99] });

    expect(result.pages.map((page) => page.page)).toEqual([1, 3]);
  });

  it("truncates at a page boundary when maxPages is exceeded", async () => {
    const result = await reader.extract(buildTextPdf(), { maxPages: 2 });

    expect(result.status).toBe("ok");
    expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(result.truncated.pages).toBe(true);
    expect(result.truncated.chars).toBe(false);
    expect(result.continuation).toEqual({ next_page: 3 });
  });

  it("truncates at a page boundary when maxChars is exceeded", async () => {
    const result = await reader.extract(buildTextPdf(), { maxChars: 20 });

    expect(result.pages.map((page) => page.page)).toEqual([1]);
    expect(result.pages[0]?.text).toBe("Page One Alpha");
    expect(result.truncated.chars).toBe(true);
    expect(result.truncated.pages).toBe(false);
    expect(result.continuation).toEqual({ next_page: 2 });
  });

  it("returns oversized without throwing when bytes exceed maxBytes", async () => {
    const result = await reader.extract(buildTextPdf(), { maxBytes: 32 });

    expect(result.status).toBe("oversized");
    expect(result.page_count).toBeNull();
    expect(result.pages).toEqual([]);
    expect(result.truncated).toEqual({ bytes: true, pages: false, chars: false });
    expect(result.continuation).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("returns corrupt without throwing for invalid bytes", async () => {
    const junk = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);

    const result = await reader.extract(junk);

    expect(result.status).toBe("corrupt");
    expect(result.page_count).toBeNull();
    expect(result.pages).toEqual([]);
    expect(result.truncated).toEqual({ bytes: false, pages: false, chars: false });
    expect(result.error).toBeTruthy();
  });

  it("reports image_only when no extractable text is present", async () => {
    const result = await reader.extract(buildTextFreePdf());

    expect(result.status).toBe("image_only");
    expect(result.page_count).toBe(1);
    expect(result.pages).toEqual([{ page: 1, text: "" }]);
    expect(result.embedded_title).toBeNull();
    expect(result.error).toBeNull();
  });
});
