import { Buffer } from "node:buffer";

export const FIXTURE_TITLE = "Fixture Title";
export const FIXTURE_PAGE_TEXTS = [
  "Page One Alpha",
  "Page Two Bravo",
  "Page Three Charlie",
] as const;

interface PdfObject {
  number: number;
  body: string;
}

function encode(value: string): Buffer {
  return Buffer.from(value, "latin1");
}

function assemble(objects: PdfObject[], trailer: string): Uint8Array {
  const ordered = [...objects].sort((a, b) => a.number - b.number);
  const parts: Buffer[] = [encode("%PDF-1.4\n")];
  let offset = parts[0]!.length;
  const offsets = new Map<number, number>();

  for (const object of ordered) {
    offsets.set(object.number, offset);
    const chunk = encode(`${object.number} 0 obj\n${object.body}\nendobj\n`);
    parts.push(chunk);
    offset += chunk.length;
  }

  const maxNumber = ordered.reduce((max, object) => Math.max(max, object.number), 0);
  const xrefOffset = offset;
  const xref: string[] = [`xref\n0 ${maxNumber + 1}\n`, "0000000000 65535 f \n"];
  for (let number = 1; number <= maxNumber; number += 1) {
    const objectOffset = offsets.get(number) ?? 0;
    xref.push(`${String(objectOffset).padStart(10, "0")} 00000 n \n`);
  }
  xref.push(`trailer\n${trailer}\nstartxref\n${xrefOffset}\n%%EOF\n`);
  parts.push(encode(xref.join("")));

  return new Uint8Array(Buffer.concat(parts));
}

function textContentStream(text: string): string {
  return `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
}

function drawingContentStream(): string {
  return "0.2 0.4 0.8 rg\n72 72 200 300 re f\n";
}

export function buildTextPdf(pageTexts: readonly string[] = FIXTURE_PAGE_TEXTS, info: Record<string, string> = {}): Uint8Array {
  const objects: PdfObject[] = [];
  const firstPageObject = 3;
  const firstContentObject = 4;
  const kidRefs: string[] = [];

  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageNumber = firstPageObject + index * 2;
    const contentNumber = firstContentObject + index * 2;
    kidRefs.push(`${pageNumber} 0 R`);
    objects.push({
      number: pageNumber,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Contents ${contentNumber} 0 R /Resources << /Font << /F1 9 0 R >> >> >>`,
    });
    const stream = textContentStream(pageTexts[index] ?? "");
    objects.push({
      number: contentNumber,
      body: `<< /Length ${encode(stream).length} >>\nstream\n${stream}endstream`,
    });
  }

  const fontObject = firstPageObject + pageTexts.length * 2;
  const infoObject = fontObject + 1;
  objects.push({ number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });
  objects.push({
    number: 2,
    body: `<< /Type /Pages /Kids [${kidRefs.join(" ")}] /Count ${pageTexts.length} >>`,
  });
  objects.push({
    number: fontObject,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  objects.push({
    number: infoObject,
    body: `<< ${Object.entries({ Title: FIXTURE_TITLE, Author: "Paper Harness Fixture", ...info }).map(([key, value]) => `/${key} (${value.replace(/[\\()]/g, "\\$&")})`).join(" ")} >>`,
  });

  return assemble(
    objects,
    `<< /Size ${infoObject + 1} /Root 1 0 R /Info ${infoObject} 0 R >>`,
  );
}

export function buildTextFreePdf(): Uint8Array {
  const stream = drawingContentStream();
  const objects: PdfObject[] = [
    { number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      number: 3,
      body:
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Contents 4 0 R /Resources << >> >>",
    },
    {
      number: 4,
      body: `<< /Length ${encode(stream).length} >>\nstream\n${stream}endstream`,
    },
  ];
  return assemble(objects, "<< /Size 5 /Root 1 0 R >>");
}
