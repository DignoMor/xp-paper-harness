import { randomBytes } from "node:crypto";

export type PaperId = string & { readonly __brand: "PaperId" };
export type AttachmentId = string & { readonly __brand: "AttachmentId" };
export type UploadId = string & { readonly __brand: "UploadId" };

const UUIDV7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

export interface IdGenerator {
  paperId(): PaperId;
  attachmentId(): AttachmentId;
  uploadId(): UploadId;
}

export const defaultIdGenerator: IdGenerator = {
  paperId: () => `ppr_${uuidv7()}` as PaperId,
  attachmentId: () => `att_${uuidv7()}` as AttachmentId,
  uploadId: () => `upl_${uuidv7()}` as UploadId,
};

export function newPaperId(): PaperId {
  return defaultIdGenerator.paperId();
}

export function newAttachmentId(): AttachmentId {
  return defaultIdGenerator.attachmentId();
}

export function newUploadId(): UploadId {
  return defaultIdGenerator.uploadId();
}

export function isPaperId(value: unknown): value is PaperId {
  return (
    typeof value === "string" &&
    value.startsWith("ppr_") &&
    UUIDV7_RE.test(value.slice(4))
  );
}

export function isAttachmentId(value: unknown): value is AttachmentId {
  return (
    typeof value === "string" &&
    value.startsWith("att_") &&
    UUIDV7_RE.test(value.slice(4))
  );
}

export function isUploadId(value: unknown): value is UploadId {
  return (
    typeof value === "string" &&
    value.startsWith("upl_") &&
    UUIDV7_RE.test(value.slice(4))
  );
}
