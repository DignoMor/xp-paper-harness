export type AppErrorCode =
  | "INVALID_INPUT"
  | "INVALID_ID"
  | "NOT_FOUND"
  | "STALE_REVISION"
  | "CONFLICT"
  | "UNKNOWN_FIELD"
  | "IMMUTABLE_FIELD"
  | "DUPLICATE_HASH"
  | "DOI_COLLISION"
  | "INVALID_UPLOAD"
  | "UPLOAD_EXPIRED"
  | "UNSUPPORTED_EXTRACTION"
  | "OVERSIZED"
  | "CORRUPT_CATALOG"
  | "UNKNOWN_SCHEMA"
  | "PROVIDER_FAILURE"
  | "METHOD_NOT_ALLOWED"
  | "INTERNAL";

const HTTP_STATUS: Record<AppErrorCode, number> = {
  INVALID_INPUT: 400,
  INVALID_ID: 400,
  NOT_FOUND: 404,
  STALE_REVISION: 409,
  CONFLICT: 409,
  UNKNOWN_FIELD: 400,
  IMMUTABLE_FIELD: 400,
  DUPLICATE_HASH: 409,
  DOI_COLLISION: 409,
  INVALID_UPLOAD: 400,
  UPLOAD_EXPIRED: 410,
  UNSUPPORTED_EXTRACTION: 422,
  OVERSIZED: 413,
  CORRUPT_CATALOG: 500,
  UNKNOWN_SCHEMA: 500,
  PROVIDER_FAILURE: 502,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL: 500,
};

export interface AppErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: AppErrorDetails;
  readonly httpStatus: number;

  constructor(code: AppErrorCode, message: string, details: AppErrorDetails = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS[code];
  }

  toJSON(): {
    error: { code: AppErrorCode; message: string; details: AppErrorDetails };
  } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function invalidInput(message: string, details?: AppErrorDetails): AppError {
  return new AppError("INVALID_INPUT", message, details);
}

export function notFound(message: string, details?: AppErrorDetails): AppError {
  return new AppError("NOT_FOUND", message, details);
}

export function staleRevision(
  expected: number,
  actual: number,
): AppError {
  return new AppError(
    "STALE_REVISION",
    "The catalog revision is stale; reload and retry.",
    { expected_revision: expected, current_revision: actual },
  );
}
