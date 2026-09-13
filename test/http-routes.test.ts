import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, type Composition } from "../src/composition.js";
import { createWebServer, type WebServer } from "../src/web/server.js";
import { FakeLlmProvider } from "../src/llm/fake-provider.js";
import { FakePdfReader } from "./helpers/harness.js";
import type { Env } from "../src/config.js";

let dir = "";
let composition!: Composition;
let web!: WebServer;
let port = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-harness-http-routes-"));
  const env: Env = {
    PAPER_HARNESS_DATA_ROOT: dir,
    LLM_PROVIDER: "fake",
    PAPER_HARNESS_PORT: "0",
  };
  const provider = new FakeLlmProvider({ handler: () => ({ text: "ok" }) });
  const started = await compose({ env, pdf: new FakePdfReader(), llm: provider });
  const services = started.services;
  composition = started;
  web = createWebServer({
    config: services.config,
    paths: services.paths,
    uploads: services.uploads,
    library: services.library,
    notes: services.noteService,
    conversations: services.conversations,
    agent: services.agent,
    llmName: provider.name,
    llmModel: provider.defaultModel,
  });
  port = await web.listen();
});

afterAll(async () => {
  try {
    if (web) await web.close();
  } catch {
    // ignore teardown errors
  }
  try {
    if (composition) await composition.dispose();
  } catch {
    // ignore teardown errors
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

function request(path: string, method: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { method });
}

describe("HTTP route methods", () => {
  it("returns 405 with METHOD_NOT_ALLOWED for unsupported methods on known paths", async () => {
    const postPapers = await request("/api/papers", "POST");
    expect(postPapers.status).toBe(405);
    expect((await postPapers.json()).error.code).toBe("METHOD_NOT_ALLOWED");

    const deletePapers = await request("/api/papers", "DELETE");
    expect(deletePapers.status).toBe(405);
    expect((await deletePapers.json()).error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("returns 404 with NOT_FOUND for an unknown /api path", async () => {
    const res = await request("/api/nope", "GET");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });
});
