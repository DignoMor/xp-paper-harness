import { isAbsolute } from "node:path";
import { AppError } from "./domain/errors.js";

export interface LlmEnvConfig {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  sessionHeader?: string;
}

export interface AppConfig {
  dataRoot: string;
  host: string;
  port: number;
  llm: LlmEnvConfig;
  pdf: { maxBytes: number; maxPages: number; maxChars: number };
  upload: { maxBytes: number; ttlMs: number };
  jsonBodyMaxBytes: number;
  logLevel: string;
}

export type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError("INVALID_INPUT", `Environment variable ${key} must be a non-negative number.`, {
      env: key,
    });
  }
  return Math.trunc(value);
}

export function loadConfig(env: Env = process.env): AppConfig {
  const rawRoot = env.PAPER_HARNESS_DATA_ROOT;
  if (!rawRoot || rawRoot.trim() === "") {
    throw new AppError(
      "INVALID_INPUT",
      "PAPER_HARNESS_DATA_ROOT must be set to an absolute external data directory.",
      { env: "PAPER_HARNESS_DATA_ROOT" },
    );
  }
  if (!isAbsolute(rawRoot)) {
    throw new AppError(
      "INVALID_INPUT",
      "PAPER_HARNESS_DATA_ROOT must be an absolute path.",
      { env: "PAPER_HARNESS_DATA_ROOT" },
    );
  }
  const dataRoot = rawRoot;
  return {
    dataRoot,
    host: env.PAPER_HARNESS_HOST ?? "0.0.0.0",
    port: intEnv(env, "PAPER_HARNESS_PORT", 8787),
    llm: {
      provider: env.LLM_PROVIDER ?? "opencode-go",
      apiKey: env.OPENCODE_GO_API_KEY,
      baseUrl: env.OPENCODE_GO_BASE_URL,
      model: env.OPENCODE_GO_MODEL ?? "deepseek-v4.1-flash",
      sessionHeader: env.OPENCODE_GO_SESSION_HEADER,
    },
    pdf: {
      maxBytes: intEnv(env, "PDF_MAX_BYTES", 10 * 1024 * 1024),
      maxPages: intEnv(env, "PDF_MAX_PAGES", 50),
      maxChars: intEnv(env, "PDF_MAX_CHARS", 200_000),
    },
    upload: {
      maxBytes: intEnv(env, "UPLOAD_MAX_BYTES", 100 * 1024 * 1024),
      ttlMs: intEnv(env, "UPLOAD_TTL_HOURS", 24) * 60 * 60 * 1000,
    },
    jsonBodyMaxBytes: intEnv(env, "JSON_BODY_MAX_BYTES", 1024 * 1024),
    logLevel: env.PAPER_HARNESS_LOG_LEVEL ?? "info",
  };
}
