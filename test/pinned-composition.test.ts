import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVED_TOOL_NAMES } from "../src/agent/system-prompt.js";
import type { PaperAgent } from "../src/agent/paper-agent.js";
import { compose } from "../src/composition.js";
import { FakeLlmProvider } from "../src/llm/fake-provider.js";
import { FakePdfReader } from "./helpers/harness.js";

const LOCK_PATH = fileURLToPath(new URL("../package-lock.json", import.meta.url));
const COMPOSITION_SOURCE = fileURLToPath(
  new URL("../src/composition.ts", import.meta.url),
);

const PINNED_PACKAGES = {
  cordis: "4.0.0-rc.10",
  "pdfjs-dist": "4.10.38",
  "js-yaml": "4.3.2",
  marked: "15.0.12",
} as const;

const FORBIDDEN_PACKAGES = ["@deepseek/dsh", "dsh-pdf", "opencode-go"] as const;

const REQUIRED_SERVICES = [
  "config",
  "paths",
  "catalog",
  "notes",
  "uploads",
  "pdf",
  "llm",
  "library",
  "noteService",
  "reading",
  "reconciliation",
  "conversations",
  "agent",
] as const;

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, { version?: unknown } | undefined>;
}

async function readLockfile(): Promise<Lockfile> {
  return JSON.parse(await readFile(LOCK_PATH, "utf8")) as Lockfile;
}

async function withComposition(
  overrides: Parameters<typeof compose>[0],
  body: (composition: Awaited<ReturnType<typeof compose>>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "paper-harness-compose-"));
  const composition = await compose({
    ...overrides,
    env: {
      PAPER_HARNESS_DATA_ROOT: dir,
      LLM_PROVIDER: "fake",
      ...overrides?.env,
    },
  });
  try {
    await body(composition);
  } finally {
    await composition.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("pinned composition", () => {
  it("resolves every required service and disposes cleanly", async () => {
    await withComposition({}, async (composition) => {
      for (const name of REQUIRED_SERVICES) {
        expect(composition.ctx.get(name), `service ${name}`).toBeDefined();
      }

      const llm = composition.ctx.get("llm") as { name?: string };
      expect(llm.name).toBe("fake");

      const agent = composition.ctx.get("agent") as PaperAgent;
      expect(agent.tools.map((tool) => tool.name).sort()).toEqual(
        [...APPROVED_TOOL_NAMES].sort(),
      );
    });
  });

  it("pins the required dependency versions to break on a silent upgrade", async () => {
    const lock = await readLockfile();
    expect(lock.lockfileVersion).toBe(3);

    for (const [name, expected] of Object.entries(PINNED_PACKAGES)) {
      const entry = lock.packages?.[`node_modules/${name}`];
      expect(entry, `locked entry for ${name}`).toBeDefined();
      expect(typeof entry?.version, `version for ${name}`).toBe("string");
      expect(entry?.version).toBe(expected);
    }
  });

  it("does not depend on unavailable or forbidden packages", async () => {
    const lock = await readLockfile();
    const lockedNames = Object.keys(lock.packages ?? {});

    for (const forbidden of FORBIDDEN_PACKAGES) {
      const present = lockedNames.some(
        (name) => name === forbidden || name.endsWith(`/${forbidden}`),
      );
      expect(present, `lockfile must not contain ${forbidden}`).toBe(false);
    }

    const source = await readFile(COMPOSITION_SOURCE, "utf8");
    for (const forbidden of FORBIDDEN_PACKAGES) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("lets the pdf and llm seams be overridden by injection", async () => {
    const pdf = new FakePdfReader();
    const llm = new FakeLlmProvider({ script: [{ text: "injected" }] });

    await withComposition({ pdf, llm }, async (composition) => {
      expect(composition.ctx.get("pdf")).toBe(pdf);
      expect(composition.ctx.get("llm")).toBe(llm);
      expect(composition.ctx.get("llm")).not.toBe(undefined);
    });
  });
});
