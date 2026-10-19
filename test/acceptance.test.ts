/**
 * Paper Harness v1 — primary end-to-end acceptance test (ticket #11).
 *
 * This test exercises ONLY the public HTTP/SSE contract (via a real
 * `createWebServer` bound to an ephemeral port) and the command interface
 * (`runReconcileCli`). Application services are never called directly; the
 * sole exception is constructing and injecting the deterministic fakes
 * (`FakePdfReader`, `FakeLlmProvider`) through `compose`.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose, type Composition } from "../src/composition.js";
import { createWebServer, type WebServer } from "../src/web/server.js";
import { FakeLlmProvider, type FakeHandler } from "../src/llm/fake-provider.js";
import { runReconcileCli } from "../src/cli/reconcile.js";
import { FakePdfReader, textBytes } from "./helpers/harness.js";
import type { Env } from "../src/config.js";
import type { PdfExtraction } from "../src/application/ports.js";

const FAKE_API_KEY = "sk-fake-acceptance-secret-9f3a2b7c";

const PDF_ONE_BYTES = textBytes("PDF-ONE");
const PDF_TWO_BYTES = textBytes("PDF-TWO");

const PDF_ONE_EXTRACTION: Partial<PdfExtraction> = {
  status: "ok",
  embedded_title: null,
  pages: [{ page: 1, text: "import body text" }],
};

const PDF_TWO_EXTRACTION: Partial<PdfExtraction> = {
  status: "ok",
  embedded_title: null,
  pages: [
    { page: 1, text: "alpha unique passage" },
    { page: 2, text: "beta unique passage" },
  ],
};

let dir = "";
let env: Env = {};
let composition!: Composition;
let web!: WebServer;
let port = 0;

const responseLog: string[] = [];

interface SseEvent {
  event: string;
  data: any;
}

interface HandlerState {
  catalogRevision?: number;
  paperId?: string;
  primaryAttachmentId?: string;
  addedAttachmentId?: string;
  noteStage?: "read" | "edit";
}

function baseUrl(): string {
  return `http://127.0.0.1:${port}`;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null ? (value as Record<string, any>) : {};
}

function parseToolContent(content: string): Record<string, any> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function lastMessage(messages: { role: string }[]): { role: string; name?: string; content?: string } | undefined {
  return messages.length > 0 ? (messages[messages.length - 1] as any) : undefined;
}

function lastUserMessage(
  messages: { role: string; content: string }[],
): { role: string; content: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "user") return message;
  }
  return undefined;
}

function captureToolState(state: HandlerState, name: string, result: Record<string, any>): void {
  const revision = result.catalog_revision ?? asRecord(result.paper).catalog_revision;
  if (typeof revision === "number") state.catalogRevision = revision;
  if (name === "import_paper") {
    const paper = asRecord(result.paper);
    if (typeof paper.paper_id === "string") state.paperId = paper.paper_id;
    if (typeof paper.primary_attachment_id === "string") {
      state.primaryAttachmentId = paper.primary_attachment_id;
    }
    return;
  }
  if (name === "add_attachment") {
    if (typeof result.paper_id === "string") state.paperId = result.paper_id;
    const attachments = Array.isArray(result.attachments) ? result.attachments : [];
    const added = attachments.find(
      (attachment: any) => attachment.attachment_id !== state.primaryAttachmentId,
    );
    if (added && typeof added.attachment_id === "string") {
      state.addedAttachmentId = added.attachment_id;
    }
    return;
  }
  if (name === "set_primary_attachment" && typeof result.paper_id === "string") {
    state.paperId = result.paper_id;
  }
}

function finalText(name: string, result: Record<string, any>): string {
  if (name === "read_paper") {
    const pages = Array.isArray(result.pages) ? result.pages : [];
    const page = pages[0];
    if (page) {
      return `Paper "${result.paper_title}", Attachment "${result.attachment_title}", p. ${page.page}: ${page.text}`;
    }
  }
  if (name === "search_paper") {
    const results = Array.isArray(result.results) ? result.results : [];
    const hit = results[0];
    if (hit) {
      return `Paper "${hit.paper_title}", Attachment "${hit.attachment_title}", p. ${hit.page}: ${hit.snippet}`;
    }
    return "No search results.";
  }
  if (name === "import_paper") {
    return `Imported Paper "${asRecord(asRecord(result.paper).metadata).title}".`;
  }
  if (name === "update_paper_metadata") {
    return `Renamed Paper to "${asRecord(result.metadata).title}".`;
  }
  if (name === "edit_note") {
    return `Note edited to revision ${result.revision}.`;
  }
  return "Done.";
}

function createMainHandler(state: HandlerState): FakeHandler {
  return (request) => {
    const last = lastMessage(request.messages);

    if (last && last.role === "tool") {
      const result = parseToolContent(last.content ?? "");
      const name = last.name ?? "";
      captureToolState(state, name, result);

      if (name === "read_note" && state.noteStage === "read") {
        state.noteStage = "edit";
        return {
          tool_calls: [
            {
              name: "edit_note",
              arguments: {
                paper_id: state.paperId,
                mode: "append",
                content: "Appended by acceptance test.",
                expected_revision: String(result.revision ?? ""),
              },
            },
          ],
        };
      }
      if (name === "edit_note") state.noteStage = undefined;
      return { text: finalText(name, result) };
    }

    const user = lastUserMessage(request.messages as { role: string; content: string }[]);
    const content = user?.content ?? "";
    const prompt = content.toLowerCase();
    const uploadId = /upload_id=([A-Za-z0-9_-]+)/.exec(content)?.[1];

    if (prompt.includes("import")) {
      return { tool_calls: [{ name: "import_paper", arguments: { upload_id: uploadId } }] };
    }
    if (prompt.includes("add attachment")) {
      return {
        tool_calls: [
          {
            name: "add_attachment",
            arguments: {
              upload_id: uploadId,
              paper_id: state.paperId,
              title: "Supplementary Materials",
            },
          },
        ],
      };
    }
    if (prompt.includes("promote")) {
      return {
        tool_calls: [
          {
            name: "set_primary_attachment",
            arguments: { paper_id: state.paperId, attachment_id: state.addedAttachmentId, expected_revision: state.catalogRevision },
          },
        ],
      };
    }
    if (prompt.includes("search")) {
      return {
        tool_calls: [{ name: "search_paper", arguments: { paper_id: state.paperId, query: "beta" } }],
      };
    }
    if (prompt.includes("read")) {
      return { tool_calls: [{ name: "read_paper", arguments: { paper_id: state.paperId } }] };
    }
    if (prompt.includes("metadata")) {
      return {
        tool_calls: [
          {
            name: "update_paper_metadata",
            arguments: {
              paper_id: state.paperId,
              patch: { title: "Renamed: Attention Is All You Need" },
              expected_revision: state.catalogRevision,
            },
          },
        ],
      };
    }
    if (prompt.includes("note")) {
      state.noteStage = "read";
      return { tool_calls: [{ name: "read_note", arguments: { paper_id: state.paperId } }] };
    }
    return { text: "No operation requested." };
  };
}

async function startBackend(pdfReader: FakePdfReader, provider: FakeLlmProvider) {
  const started = await compose({ env, pdf: pdfReader, llm: provider });
  const services = started.services;
  const server = createWebServer({
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
  const boundPort = await server.listen();
  return { comp: started, server, port: boundPort };
}

async function makeMainBackend() {
  const pdfReader = new FakePdfReader();
  pdfReader.register(PDF_ONE_BYTES, PDF_ONE_EXTRACTION);
  pdfReader.register(PDF_TWO_BYTES, PDF_TWO_EXTRACTION);
  const state: HandlerState = {};
  const provider = new FakeLlmProvider({ handler: createMainHandler(state) });
  return startBackend(pdfReader, provider);
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl()}${path}`);
  const text = await res.text();
  responseLog.push(text);
  return { status: res.status, body: parseJson(text) };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  responseLog.push(text);
  return { status: res.status, body: parseJson(text) };
}

async function patchJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  responseLog.push(text);
  return { status: res.status, body: parseJson(text) };
}

function parseSse(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const frame of raw.split("\n\n")) {
    if (frame.trim() === "") continue;
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    events.push({ event: eventName, data: parseJson(dataLines.join("\n")) });
  }
  return events;
}

async function readSse(
  path: string,
  body: unknown,
): Promise<{ status: number; events: SseEvent[]; raw: string }> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  responseLog.push(raw);
  return { status: res.status, events: parseSse(raw), raw };
}

async function uploadPdf(
  bytes: Uint8Array,
  filename: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl()}/api/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-original-filename": encodeURIComponent(filename),
    },
    body: bytes,
  });
  const text = await res.text();
  responseLog.push(text);
  return { status: res.status, body: parseJson(text) };
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, stdout: output };
  } finally {
    process.stdout.write = original;
  }
}

function textEvents(events: SseEvent[]): string {
  return events
    .filter((event) => event.event === "text")
    .map((event) => String(event.data?.delta ?? ""))
    .join("");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-harness-acceptance-"));
  env = {
    PAPER_HARNESS_DATA_ROOT: dir,
    LLM_PROVIDER: "fake",
    PAPER_HARNESS_PORT: "0",
    JSON_BODY_MAX_BYTES: "1024",
    OPENCODE_GO_API_KEY: FAKE_API_KEY,
  };

  const firstPdf = new FakePdfReader();
  const firstLlm = new FakeLlmProvider({ handler: () => ({ text: "first provider reply" }) });
  const started = await startBackend(firstPdf, firstLlm);
  composition = started.comp;
  web = started.server;
  port = started.port;
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

describe("Paper Harness v1 acceptance (ticket #11)", () => {
  it(
    "covers the full public HTTP/SSE + reconciliation workflow",
    async () => {
      // ---- Step 1: health and config -------------------------------------
      const health = await getJson("/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: "ok", provider: "fake" });

      const config = await getJson("/api/config");
      expect(config.status).toBe(200);
      expect(config.body.provider).toBe("fake");
      expect(typeof config.body.provider_disclosure).toBe("string");
      expect(config.body.provider_disclosure.length).toBeGreaterThan(0);

      // ---- Step 2: conversations, rename, list, restart persistence ------
      const created = await postJson("/api/conversations", { title: "Acceptance Conversation" });
      expect(created.status).toBe(201);
      const conversationId = created.body.conversation_id as string;
      expect(conversationId).toMatch(/^cnv_/);

      const renamed = await patchJson(`/api/conversations/${conversationId}`, {
        title: "Renamed Acceptance Conversation",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.title).toBe("Renamed Acceptance Conversation");

      const listed = await getJson("/api/conversations");
      expect(listed.status).toBe(200);
      const summary = (listed.body as any[]).find((entry) => entry.conversation_id === conversationId);
      expect(summary?.title).toBe("Renamed Acceptance Conversation");

      const hello = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "hello there",
      });
      expect(hello.status).toBe(200);
      expect(hello.events.at(-1)?.event).toBe("done");

      // Restart the backend against the same data directory with fresh fakes.
      await web.close();
      await composition.dispose();
      const restarted = await makeMainBackend();
      composition = restarted.comp;
      web = restarted.server;
      port = restarted.port;

      const persisted = await getJson(`/api/conversations/${conversationId}`);
      expect(persisted.status).toBe(200);
      expect(persisted.body.meta.title).toBe("Renamed Acceptance Conversation");
      expect(Array.isArray(persisted.body.messages)).toBe(true);
      expect(persisted.body.messages.length).toBeGreaterThanOrEqual(2);
      expect(
        persisted.body.messages.some(
          (message: any) => message.role === "user" && message.content.includes("hello there"),
        ),
      ).toBe(true);

      // ---- Step 3: upload + import ---------------------------------------
      const uploadOne = await uploadPdf(PDF_ONE_BYTES, "Attention Is All You Need.pdf");
      expect(uploadOne.status).toBe(201);
      expect(typeof uploadOne.body.upload_id).toBe("string");

      const importTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "import this",
        upload_id: uploadOne.body.upload_id,
      });
      expect(importTurn.status).toBe(200);
      expect(importTurn.events.some((event) => event.event === "done")).toBe(true);
      const importResult = importTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "import_paper",
      );
      expect(importResult?.data.ok).toBe(true);
      expect(importResult?.data.result.imported_as).toBe("new_paper");

      const papers = await getJson("/api/papers");
      expect(papers.status).toBe(200);
      expect(papers.body).toHaveLength(1);
      const paperId = papers.body[0].paper_id as string;
      expect(papers.body[0].title).toBe("Attention Is All You Need");

      const detail = await getJson(`/api/papers/${paperId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.attachments).toHaveLength(1);
      expect(detail.body.attachments[0]).toMatchObject({
        primary: true,
        original_filename: "Attention Is All You Need.pdf",
      });
      expect(detail.body.attachments.filter((attachment: any) => attachment.primary)).toHaveLength(1);

      // ---- Step 4: add a supplementary attachment and promote it ---------
      const uploadTwo = await uploadPdf(PDF_TWO_BYTES, "Supplementary Materials.pdf");
      expect(uploadTwo.status).toBe(201);

      const addTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "add attachment to paper",
        upload_id: uploadTwo.body.upload_id,
      });
      const addResult = addTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "add_attachment",
      );
      expect(addResult?.data.ok).toBe(true);
      expect(addTurn.events.some((event) => event.event === "done")).toBe(true);

      const afterAdd = await getJson(`/api/papers/${paperId}`);
      expect(afterAdd.body.attachments).toHaveLength(2);
      const formerPrimaryId = afterAdd.body.attachments.find((a: any) => a.primary)?.attachment_id;
      const addedId = afterAdd.body.attachments.find((a: any) => !a.primary)?.attachment_id;
      expect(addedId).toMatch(/^att_/);

      const promoteTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "promote attachment to primary",
      });
      const promoteResult = promoteTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "set_primary_attachment",
      );
      expect(promoteResult?.data.ok).toBe(true);

      const afterPromote = await getJson(`/api/papers/${paperId}`);
      expect(afterPromote.body.attachments).toHaveLength(2);
      expect(afterPromote.body.primary_attachment_id).toBe(addedId);
      expect(afterPromote.body.attachments.find((a: any) => a.primary)?.attachment_id).toBe(addedId);
      const formerPrimary = afterPromote.body.attachments.find(
        (a: any) => a.attachment_id === formerPrimaryId,
      );
      expect(formerPrimary).toBeDefined();
      expect(formerPrimary.primary).toBe(false);

      // ---- Step 5: read/search with citations ----------------------------
      const readTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "read paper pages",
      });
      const readResult = readTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "read_paper",
      );
      expect(readResult?.data.ok).toBe(true);
      const readPayload = readResult?.data.result;
      expect(readPayload.attachment_title).toBe("Supplementary Materials");
      expect(Array.isArray(readPayload.pages)).toBe(true);
      expect(readPayload.pages[0]).toMatchObject({ page: 1 });
      expect(readPayload.pages[0].text).toContain("alpha unique");
      const readAnswer = textEvents(readTurn.events);
      expect(readAnswer).toContain("p. 1");
      expect(readAnswer).toContain("Supplementary Materials");

      const searchTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "search paper for beta",
      });
      const searchResult = searchTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "search_paper",
      );
      expect(searchResult?.data.ok).toBe(true);
      const searchPayload = searchResult?.data.result;
      expect(searchPayload.results.length).toBeGreaterThanOrEqual(1);
      expect(searchPayload.results[0]).toMatchObject({
        attachment_title: "Supplementary Materials",
        page: 2,
      });
      expect(String(searchPayload.results[0].snippet).toLowerCase()).toContain("beta");
      expect(textEvents(searchTurn.events)).toContain("p. 2");

      // ---- Step 6: metadata + note ---------------------------------------
      const metadataTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "update metadata title",
      });
      const metadataResult = metadataTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "update_paper_metadata",
      );
      expect(metadataResult?.data.ok).toBe(true);

      const afterMetadata = await getJson(`/api/papers/${paperId}`);
      expect(afterMetadata.body.metadata.title).toBe("Renamed: Attention Is All You Need");

      const noteTurn = await readSse(`/api/conversations/${conversationId}/messages`, {
        prompt: "edit note append",
      });
      expect(
        noteTurn.events.filter(
          (event) => event.event === "tool_result" && event.data?.name === "read_note",
        ),
      ).toHaveLength(1);
      const editNoteResult = noteTurn.events.find(
        (event) => event.event === "tool_result" && event.data?.name === "edit_note",
      );
      expect(editNoteResult?.data.ok).toBe(true);
      expect(noteTurn.events.some((event) => event.event === "done")).toBe(true);

      const noteView = await getJson(`/api/papers/${paperId}/note`);
      expect(noteView.status).toBe(200);
      expect(typeof noteView.body.body).toBe("string");
      expect(typeof noteView.body.revision).toBe("string");
      expect(noteView.body.body).toContain("Appended by acceptance test.");

      const rawRes = await fetch(`${baseUrl()}/api/papers/${paperId}/note?format=raw`);
      const rawText = await rawRes.text();
      responseLog.push(rawText);
      expect(rawRes.status).toBe(200);
      expect(rawText.startsWith("---")).toBe(true);
      expect(rawText).toContain("paper_id:");
      expect(rawText).toContain("Renamed: Attention Is All You Need");

      // No human-facing note mutation route is exposed in v1.
      const patchNote = await fetch(`${baseUrl()}/api/papers/${paperId}/note`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "should never land" }),
      });
      responseLog.push(await patchNote.text());
      expect([404, 405]).toContain(patchNote.status);

      // ---- Step 7: reconciliation through the command interface ----------
      const initialReport = await captureStdout(() =>
        runReconcileCli(["--data-root", dir, "--json"], env),
      );
      expect(initialReport.result).toBe(0);
      const report = JSON.parse(initialReport.stdout);
      expect(report.mode).toBe("report_only");
      expect(report.deep).toBe(false);
      expect(report.summary.errors).toBe(0);
      expect(report.catalog_revision).toBeGreaterThan(0);

      const notePath = join(dir, "notes", `${paperId}.md`);
      expect(existsSync(notePath)).toBe(true);
      await rm(notePath);

      const missingReport = await captureStdout(() =>
        runReconcileCli(["--data-root", dir, "--json"], env),
      );
      expect(missingReport.result).toBe(2);
      const missing = JSON.parse(missingReport.stdout);
      expect(missing.issues.some((issue: any) => issue.code === "NOTE_MISSING")).toBe(true);
      expect(missing.summary.errors).toBeGreaterThanOrEqual(1);

      const repairReport = await captureStdout(() =>
        runReconcileCli(["--data-root", dir, "--json", "--repair"], env),
      );
      const repaired = JSON.parse(repairReport.stdout);
      expect(repaired.mode).toBe("repair");
      expect(repaired.summary.repaired).toBeGreaterThanOrEqual(1);
      expect(repaired.repaired.some((issue: any) => issue.code === "NOTE_MISSING")).toBe(true);
      expect(existsSync(notePath)).toBe(true);
      expect(repairReport.result).toBe(0);

      const deepReport = await captureStdout(() =>
        runReconcileCli(["--data-root", dir, "--json", "--deep"], env),
      );
      expect(deepReport.result).toBe(0);
      const deep = JSON.parse(deepReport.stdout);
      expect(deep.deep).toBe(true);
      expect(deep.summary.errors).toBe(0);

      // ---- Step 8: safety and containment --------------------------------
      const cwd = resolve(process.cwd());
      expect(resolve(composition.services.config.dataRoot)).toBe(resolve(dir));
      expect(dir.startsWith(cwd)).toBe(false);

      const files = await walk(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(resolve(file).startsWith(resolve(dir))).toBe(true);
        expect(resolve(file).startsWith(cwd)).toBe(false);
      }
      expect(files.some((file) => file.endsWith("catalog.json"))).toBe(true);
      expect(files.some((file) => file.includes("notes") && file.endsWith(".md"))).toBe(true);
      expect(files.some((file) => file.endsWith(".pdf"))).toBe(true);
      expect(files.some((file) => file.endsWith(".jsonl"))).toBe(true);

      for (const file of files) {
        const contents = await readFile(file, "utf8");
        expect(contents).not.toContain(FAKE_API_KEY);
      }

      const badUpload = await fetch(`${baseUrl()}/api/uploads`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "this is not a pdf",
      });
      responseLog.push(await badUpload.text());
      expect(badUpload.status).toBe(400);

      const oversized = await postJson("/api/conversations", { title: "x".repeat(4000) });
      expect(oversized.status).toBe(413);

      const unknown = await getJson("/api/does-not-exist");
      expect(unknown.status).toBe(404);

      const unsupported = await fetch(`${baseUrl()}/api/papers`, { method: "DELETE" });
      responseLog.push(await unsupported.text());
      expect(unsupported.status).toBe(405);

      expect(responseLog.join("\n")).not.toContain(FAKE_API_KEY);
    },
    60_000,
  );
});
