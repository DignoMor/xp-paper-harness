import { AppError, invalidInput } from "./errors.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalidInput(`${label} must be an object.`, { field: label });
  }
  return value;
}

export function requireString(value: unknown, label: string, opts: { max?: number; min?: number; allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string") {
    throw invalidInput(`${label} must be a string.`, { field: label });
  }
  const { max = 10000, min = 0, allowEmpty = true } = opts;
  if (!allowEmpty && value.trim() === "") {
    throw invalidInput(`${label} must not be empty.`, { field: label });
  }
  if (value.length < min) {
    throw invalidInput(`${label} is too short.`, { field: label, min });
  }
  if (value.length > max) {
    throw invalidInput(`${label} is too long.`, { field: label, max });
  }
  return value;
}

export function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${label} must be a non-negative integer.`, { field: label });
  }
  return value;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalidInput(`${label} must be an array.`, { field: label });
  }
  return value;
}

export function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new AppError("UNKNOWN_FIELD", `${label} contains an unknown field "${key}".`, {
        field: key,
        allowed,
        scope: label,
      });
    }
  }
}

export function assertImmutableAbsent(
  obj: Record<string, unknown>,
  immutable: readonly string[],
  label: string,
): void {
  for (const key of immutable) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new AppError(
        "IMMUTABLE_FIELD",
        `${label} cannot change "${key}".`,
        { field: key, scope: label },
      );
    }
  }
}
