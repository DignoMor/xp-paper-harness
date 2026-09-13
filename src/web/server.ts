import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, isAppError } from "../domain/errors.js";
import { newUploadId } from "../domain/ids.js";
import type { AppConfig } from "../config.js";
import type { DataPaths, UploadStore } from "../application/ports.js";
import type { LibraryService } from "../application/library-service.js";
import type { NoteService } from "../application/note-service.js";
import type { ConversationStore } from "../conversations/conversation-store.js";
import type { AgentEvent, PaperAgent } from "../agent/paper-agent.js";

export interface WebServerDeps {
  config: AppConfig;
  paths: DataPaths;
  uploads: UploadStore;
  library: LibraryService;
  notes: NoteService;
  conversations: ConversationStore;
  agent: PaperAgent;
  llmName: string;
  llmModel: string;
}

export interface WebServer {
  server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createWebServer(deps: WebServerDeps): WebServer {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const appError = isAppError(error)
        ? error
        : new AppError("INTERNAL", "An unexpected error occurred.", {
            detail: error instanceof Error ? error.message : String(error),
          });
      sendJson(res, appError.httpStatus, appError.toJSON());
    });
  });
  return {
    server,
    listen: () =>
      new Promise<number>((resolvePromise) => {
        server.listen(deps.config.port, deps.config.host, () => {
          const address = server.address();
          resolvePromise(typeof address === "object" && address ? address.port : deps.config.port);
        });
      }),
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (path === "/api/health") {
    if (method !== "GET") throw methodNotAllowed(method, path);
    sendJson(res, 200, { status: "ok", provider: deps.llmName, model: deps.llmModel });
    return;
  }
  if (path === "/api/config") {
    if (method !== "GET") throw methodNotAllowed(method, path);
    sendJson(res, 200, {
      provider: deps.llmName,
      model: deps.llmModel,
      provider_disclosure:
        "Relevant Paper content and Paper Notes may be sent to the configured LLM provider when you chat with the Paper Agent.",
    });
    return;
  }

  if (path === "/api/conversations") {
    if (method === "POST") {
      const body = asObject(await readJson(req, deps.config.jsonBodyMaxBytes));
      const title = body.title === undefined ? undefined : asString(body.title, "title");
      const conversation = await deps.conversations.create(title);
      sendJson(res, 201, conversation.meta);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, await deps.conversations.list());
      return;
    }
    throw methodNotAllowed(method, path);
  }

  const conversationMatch = /^\/api\/conversations\/([^/]+)$/.exec(path);
  if (conversationMatch) {
    const id = decodeURIComponent(conversationMatch[1]!);
    if (method === "GET") {
      const conversation = await deps.conversations.get(id);
      sendJson(res, 200, { meta: conversation.meta, messages: conversation.messages });
      return;
    }
    if (method === "PATCH") {
      const body = asObject(await readJson(req, deps.config.jsonBodyMaxBytes));
      const title = asString(body.title, "title");
      sendJson(res, 200, await deps.conversations.rename(id, title));
      return;
    }
    throw methodNotAllowed(method, path);
  }

  const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
  if (messagesMatch) {
    if (method !== "POST") throw methodNotAllowed(method, path);
    const id = decodeURIComponent(messagesMatch[1]!);
    await streamAgent(req, res, deps, { conversationId: id });
    return;
  }
  if (path === "/api/messages") {
    if (method !== "POST") throw methodNotAllowed(method, path);
    await streamAgent(req, res, deps, {});
    return;
  }

  if (path === "/api/uploads") {
    if (method !== "POST") throw methodNotAllowed(method, path);
    await handleUpload(req, res, deps);
    return;
  }

  if (path === "/api/papers") {
    if (method !== "GET") throw methodNotAllowed(method, path);
    sendJson(res, 200, await deps.library.listPapers());
    return;
  }
  const paperMatch = /^\/api\/papers\/([^/]+)$/.exec(path);
  if (paperMatch) {
    if (method !== "GET") throw methodNotAllowed(method, path);
    sendJson(res, 200, await deps.library.getPaper(decodeURIComponent(paperMatch[1]!)));
    return;
  }
  const fileMatch = /^\/api\/papers\/([^/]+)\/attachments\/([^/]+)\/file$/.exec(path);
  if (fileMatch) {
    if (method !== "GET") throw methodNotAllowed(method, path);
    const bytes = await deps.library.readAttachmentBytes(
      decodeURIComponent(fileMatch[1]!),
      decodeURIComponent(fileMatch[2]!),
    );
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": "inline",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=60",
    });
    res.end(Buffer.from(bytes));
    return;
  }
  const noteMatch = /^\/api\/papers\/([^/]+)\/note$/.exec(path);
  if (noteMatch) {
    if (method !== "GET") throw methodNotAllowed(method, path);
    const view = await deps.notes.readNote(decodeURIComponent(noteMatch[1]!));
    if (url.searchParams.get("format") === "raw") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(view.raw);
      return;
    }
    sendJson(res, 200, view);
    return;
  }

  if (path.startsWith("/api/")) {
    throw new AppError("NOT_FOUND", `No route for ${path}.`, { path });
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(res, path);
    return;
  }
  throw methodNotAllowed(method, path);
}

function methodNotAllowed(method: string, path: string): AppError {
  return new AppError("METHOD_NOT_ALLOWED", `Method ${method} is not allowed.`, { path });
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebServerDeps,
): Promise<void> {
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    throw new AppError("INVALID_UPLOAD", "Uploads must be application/pdf.", {
      content_type: contentType,
    });
  }
  const headerName = req.headers["x-original-filename"];
  let originalFilename = "upload.pdf";
  if (typeof headerName === "string" && headerName.trim() !== "") {
    try {
      originalFilename = decodeURIComponent(headerName);
    } catch {
      originalFilename = headerName;
    }
  }
  const uploadId = newUploadId();
  const staged = await deps.uploads.stage(uploadId, req, {
    originalFilename,
    mediaType: "application/pdf",
    maxBytes: deps.config.upload.maxBytes,
  });
  sendJson(res, 201, {
    upload_id: staged.upload_id,
    original_filename: staged.original_filename,
    byte_size: staged.byte_size,
  });
}

async function streamAgent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebServerDeps,
  target: { conversationId?: string },
): Promise<void> {
  const body = asObject(await readJson(req, deps.config.jsonBodyMaxBytes));
  const prompt = asString(body.prompt, "prompt");
  const conversationIdRaw = body.conversation_id;
  const conversationId =
    target.conversationId ??
    (conversationIdRaw === undefined ? undefined : asString(conversationIdRaw, "conversation_id"));
  let fullPrompt = prompt;
  if (body.upload_id !== undefined) {
    const uploadId = asString(body.upload_id, "upload_id");
    const upload = await deps.library.requireStagedUpload(uploadId);
    fullPrompt = `${prompt}\n\n[staged upload] upload_id=${upload.upload_id}, original_filename="${upload.original_filename}", byte_size=${upload.byte_size}`;
  }

  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on("close", onClose);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();

  try {
    for await (const event of deps.agent.run({
      prompt: fullPrompt,
      conversation_id: conversationId,
      signal: controller.signal,
    })) {
      writeSse(res, event);
    }
  } catch (error) {
    const appError = isAppError(error)
      ? error
      : new AppError("INTERNAL", "The agent stream failed.", {
          detail: error instanceof Error ? error.message : String(error),
        });
    writeSse(res, { type: "error", code: appError.code, message: appError.message });
  } finally {
    req.off("close", onClose);
    res.end();
  }
}

function writeSse(res: ServerResponse, event: AgentEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const dir = staticDir();
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const normalized = normalize(relative);
  if (normalized.startsWith("..") || normalized.includes("\0")) {
    throw new AppError("NOT_FOUND", "Not found.", { path });
  }
  const full = resolve(dir, normalized);
  if (!full.startsWith(resolve(dir))) {
    throw new AppError("NOT_FOUND", "Not found.", { path });
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, { "content-type": contentTypeFor(full), "cache-control": "no-cache" });
    res.end(data);
  } catch {
    throw new AppError("NOT_FOUND", "Not found.", { path });
  }
}

function staticDir(): string {
  const compiled = fileURLToPath(new URL("./static/", import.meta.url));
  if (existsSync(join(compiled, "index.html"))) return compiled;
  return fileURLToPath(new URL("../../src/web/static/", import.meta.url));
}

function contentTypeFor(file: string): string {
  switch (extname(file)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) {
      throw new AppError("OVERSIZED", "The request body is too large.", { max_bytes: maxBytes });
    }
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError("INVALID_INPUT", "The request body is not valid JSON.", {});
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INVALID_INPUT", "The request body must be a JSON object.", {});
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new AppError("INVALID_INPUT", `Field "${field}" must be a non-empty string.`, { field });
  }
  return value;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}
