import type { PaperMetadata } from "../../domain/paper.js";
import { createRequire } from "node:module";
import type {
  PdfExtraction,
  PdfExtractionStatus,
  PdfPage,
  PdfReadOptions,
  PdfReaderPort,
} from "../../application/ports.js";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]>;

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_CHARS = 200_000;

let pdfjsPromise: Promise<PdfJsModule> | null = null;

async function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const require = createRequire(import.meta.url);
      pdfjs.GlobalWorkerOptions.workerSrc = require.resolve(
        "pdfjs-dist/legacy/build/pdf.worker.mjs",
      );
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

function normalizeSelection(pages: number[] | undefined, numPages: number): number[] {
  if (!pages) {
    return Array.from({ length: numPages }, (_, index) => index + 1);
  }
  const selected = new Set<number>();
  for (const page of pages) {
    if (Number.isInteger(page) && page >= 1 && page <= numPages) {
      selected.add(page);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

interface RawTextItem {
  str?: string;
  hasEOL?: boolean;
}

function joinTextItems(items: readonly RawTextItem[]): string {
  let out = "";
  for (const item of items) {
    if (typeof item.str === "string") out += item.str;
    out += item.hasEOL ? "\n" : " ";
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function isEncryptedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const typed = error as { name?: string; message?: string };
  if (typed.name === "PasswordException") return true;
  return /NEED_PASSWORD|INCORRECT_PASSWORD/.test(typed.message ?? "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function baseExtraction(status: PdfExtractionStatus): PdfExtraction {
  return {
    status,
    page_count: null,
    pages: [],
    embedded_title: null,
    truncated: { bytes: false, pages: false, chars: false },
    continuation: null,
    error: null,
  };
}

export class PdfjsReader implements PdfReaderPort {
  async extract(bytes: Uint8Array, options: PdfReadOptions = {}): Promise<PdfExtraction> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

    if (bytes.byteLength > maxBytes) {
      return {
        ...baseExtraction("oversized"),
        truncated: { bytes: true, pages: false, chars: false },
        error: `PDF is ${bytes.byteLength} bytes, exceeding the ${maxBytes} byte limit.`,
      };
    }

    let pdfjs: PdfJsModule;
    try {
      pdfjs = await loadPdfjs();
    } catch (error) {
      return { ...baseExtraction("corrupt"), error: errorMessage(error) };
    }

    let doc: PdfDocument | null = null;
    let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;
    try {
      loadingTask = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: true,
        isEvalSupported: false,
        disableFontFace: true,
        verbosity: 0,
      });
      doc = await loadingTask.promise;
      return await this.extractFromDocument(doc, {
        pages: options.pages,
        maxPages,
        maxChars,
      });
    } catch (error) {
      if (isEncryptedError(error)) {
        return { ...baseExtraction("encrypted"), error: errorMessage(error) };
      }
      return { ...baseExtraction("corrupt"), error: errorMessage(error) };
    } finally {
      const activeDoc = doc;
      const activeTask = loadingTask;
      doc = null;
      loadingTask = null;
      try {
        if (activeDoc) {
          await activeDoc.destroy();
        } else if (activeTask) {
          await activeTask.destroy();
        }
      } catch {
        // Cleanup failures must not mask the extraction result.
      }
    }
  }

  private async extractFromDocument(
    doc: PdfDocument,
    limits: { pages: number[] | undefined; maxPages: number; maxChars: number },
  ): Promise<PdfExtraction> {
    const numPages = doc.numPages;

    let metadata: Partial<PaperMetadata> = {};
    try {
      const embedded = await doc.getMetadata();
      const rawInfo = embedded.info as Record<string, unknown>;
      const info = { ...(rawInfo.Custom as Record<string, unknown> | undefined), ...rawInfo };
      const xmp = embedded.metadata;
      const text = (...values: unknown[]): string | undefined => {
        for (const value of values) {
          if (typeof value === "string" && value.trim()) return value.trim();
          if (Array.isArray(value)) {
            const found = value.find((item): item is string => typeof item === "string" && item.trim() !== "");
            if (found) return found.trim();
          }
        }
        return undefined;
      };
      const fields: Array<[keyof PaperMetadata, string[], string[]]> = [
        ["title", ["dc:title"], ["Title"]],
        ["abstract_note", ["dc:description"], ["Subject"]],
        ["publication_title", ["prism:publicationname"], ["PublicationTitle", "Journal"]],
        ["volume", ["prism:volume"], ["Volume"]],
        ["issue", ["prism:number"], ["Issue"]],
        ["pages", ["prism:pagerange"], ["Pages"]],
        ["date", ["prism:publicationdate", "dc:date"], ["Date"]],
        ["doi", ["prism:doi"], ["DOI"]],
        ["url", ["prism:url"], ["URL"]],
      ];
      for (const [field, xmpNames, infoNames] of fields) {
        const value = text(...xmpNames.map(name => xmp?.get(name)), ...infoNames.map(name => info[name]));
        if (value) Object.assign(metadata, { [field]: value });
      }
      const author = xmp?.get("dc:creator") ?? info.Author;
      const authors = Array.isArray(author) ? author : typeof author === "string" ? author.split(";") : [];
      const names = authors.filter((value): value is string => typeof value === "string" && value.trim() !== "");
      if (names.length) metadata.creators = names.map(name => ({ creator_type: "author", name: name.trim() }));
      const keywords = xmp?.get("dc:subject") ?? info.Keywords;
      const tags = Array.isArray(keywords) ? keywords : typeof keywords === "string" ? keywords.split(/[,;]/) : [];
      const cleanTags = tags.filter((value): value is string => typeof value === "string" && value.trim() !== "").map(value => value.trim());
      if (cleanTags.length) metadata.tags = cleanTags;
    } catch {
      // Metadata is optional; extraction and registration must still succeed.
    }
    const embeddedTitle = metadata.title ?? null;

    const selection = normalizeSelection(limits.pages, numPages);
    const limited = selection.slice(0, Math.max(0, limits.maxPages));
    const pagesTruncated = limited.length < selection.length;

    const extracted: PdfPage[] = [];
    let charCount = 0;
    let charsTruncated = false;
    let charContinuationPage: number | null = null;

    for (const pageNumber of limited) {
      const page = await doc.getPage(pageNumber);
      let text = "";
      try {
        const content = await page.getTextContent();
        text = joinTextItems(content.items as RawTextItem[]);
      } finally {
        page.cleanup();
      }
      if (charCount + text.length > limits.maxChars) {
        charsTruncated = true;
        charContinuationPage = pageNumber;
        break;
      }
      charCount += text.length;
      extracted.push({ page: pageNumber, text });
    }

    let continuation: { next_page: number } | null = null;
    if (charsTruncated && charContinuationPage !== null) {
      continuation = { next_page: charContinuationPage };
    } else if (pagesTruncated) {
      const lastExtracted = extracted[extracted.length - 1]?.page ?? selection[0] ?? 1;
      continuation = { next_page: lastExtracted + 1 };
    }

    const hasText = extracted.some((page) => page.text.trim().length > 0);
    const status: PdfExtractionStatus =
      extracted.length > 0 && !hasText ? "image_only" : "ok";

    return {
      status,
      page_count: numPages,
      pages: extracted,
      embedded_title: embeddedTitle,
      metadata,
      truncated: { bytes: false, pages: pagesTruncated, chars: charsTruncated },
      continuation,
      error: null,
    };
  }
}

export function createPdfjsReader(): PdfReaderPort {
  return new PdfjsReader();
}
