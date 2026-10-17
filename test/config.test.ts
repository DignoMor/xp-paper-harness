import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/domain/errors.js";

function expectInvalidInput(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("INVALID_INPUT");
    expect(appError.details).toMatchObject({ env: "PAPER_HARNESS_DATA_ROOT" });
    return appError;
  }
  throw new Error("Expected loadConfig to throw");
}

describe("loadConfig", () => {
  it("rejects a missing PAPER_HARNESS_DATA_ROOT", () => {
    expectInvalidInput(() => loadConfig({}));
  });

  it("rejects an empty PAPER_HARNESS_DATA_ROOT", () => {
    expectInvalidInput(() => loadConfig({ PAPER_HARNESS_DATA_ROOT: "   " }));
  });

  it("rejects a relative PAPER_HARNESS_DATA_ROOT", () => {
    expectInvalidInput(() => loadConfig({ PAPER_HARNESS_DATA_ROOT: "data" }));
  });

  it("accepts an absolute PAPER_HARNESS_DATA_ROOT unchanged", () => {
    const dataRoot = join(tmpdir(), "paper-harness-config");
    const config = loadConfig({ PAPER_HARNESS_DATA_ROOT: dataRoot });
    expect(config.dataRoot).toBe(dataRoot);
  });

  it("applies documented defaults", () => {
    const config = loadConfig({ PAPER_HARNESS_DATA_ROOT: join(tmpdir(), "paper-harness-config") });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe("info");
    expect(config.llm.provider).toBe("opencode-go");
    expect(config.llm.model).toBe("deepseek-v4.1-flash");
    expect(config.pdf.maxBytes).toBe(10 * 1024 * 1024);
    expect(config.pdf.maxPages).toBe(50);
    expect(config.pdf.maxChars).toBe(200_000);
    expect(config.upload.maxBytes).toBe(100 * 1024 * 1024);
    expect(config.upload.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(config.jsonBodyMaxBytes).toBe(1024 * 1024);
  });
});
