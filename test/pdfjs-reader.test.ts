import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PdfjsReader } from "../src/infrastructure/pdf/pdfjs-reader.js";

function minimalPdf(text: string): Uint8Array {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objects[3] =
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  objects[4] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = pdf.length;
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

describe("PdfjsReader", () => {
  it("extracts text without detaching the caller's buffer", async () => {
    const bytes = minimalPdf("Detach probe");
    const originalLength = bytes.byteLength;
    const reader = new PdfjsReader();

    const extraction = await reader.extract(bytes, { maxPages: 1, maxChars: 5000 });

    expect(extraction.status).toBe("ok");
    expect(extraction.pages[0]?.text).toContain("Detach probe");
    expect(bytes.byteLength).toBe(originalLength);
    expect(bytes.buffer.byteLength).toBe(originalLength);

    const dir = await mkdtemp(join(tmpdir(), "pdfjs-reader-"));
    try {
      const file = join(dir, "copy.pdf");
      await writeFile(file, bytes);
      expect((await stat(file)).size).toBe(originalLength);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
