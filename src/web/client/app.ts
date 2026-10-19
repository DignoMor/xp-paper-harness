import { sanitizeHtml } from "./sanitize-html.js";
import { marked } from "marked";

interface AppConfig {
  provider: string;
  model: string;
  provider_disclosure: string;
}

interface ConversationMeta {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface ConversationSummary extends ConversationMeta {
  message_count: number;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  created_at: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

interface ConversationRecord {
  meta: ConversationMeta;
  messages: ConversationMessage[];
}

interface Creator {
  creator_type: string;
  first_name?: string;
  last_name?: string;
  name?: string;
}

interface PaperMetadata {
  item_type: string;
  title: string;
  creators: Creator[];
  abstract_note?: string;
  publication_title?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  date?: string;
  doi?: string;
  url?: string;
  tags: string[];
}

interface AttachmentRecord {
  attachment_id: string;
  title: string;
  description: string;
  original_filename: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  imported_at: string;
  page_count: number | null;
  extraction_status: string;
  extraction_error: string | null;
  storage_path: string;
}

interface PaperSummary {
  paper_id: string;
  title: string;
  item_type: string;
  creators: Creator[];
  date: string | null;
  doi: string | null;
  attachment_count: number;
  updated_at: string;
}

interface PaperDetailAttachment extends AttachmentRecord {
  primary: boolean;
}

interface PaperDetail {
  paper_id: string;
  metadata: PaperMetadata;
  created_at: string;
  updated_at: string;
  primary_attachment_id: string;
  attachments: PaperDetailAttachment[];
}

interface NoteView {
  paper_id: string;
  title: string;
  doi: string | null;
  body: string;
  revision: string;
  raw: string;
}

interface UploadResult {
  upload_id: string;
  original_filename: string;
  byte_size: number;
}

type AgentEvent =
  | { type: "conversation"; conversation: ConversationMeta }
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; ok: boolean; result: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done"; conversation_id: string; title: string };

const SELECTION_KEY = "paper-harness.lastConversationId";

const state = {
  conversations: [] as ConversationSummary[],
  selectedConversationId: null as string | null,
  streaming: false,
  abort: null as AbortController | null,
  stagedUpload: null as UploadResult | null,
  papers: [] as PaperSummary[],
  selectedPaperId: null as string | null,
};

let streamingText = "";
let streamingTextEl: HTMLElement | null = null;
const pendingTools = new Map<string, HTMLElement[]>();

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requireEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required element #${id}`);
  return node as T;
}

const els = {
  providerDisclosure: requireEl<HTMLDivElement>("provider-disclosure"),
  conversationList: requireEl<HTMLUListElement>("conversation-list"),
  newConversation: requireEl<HTMLButtonElement>("new-conversation"),
  transcript: requireEl<HTMLDivElement>("transcript"),
  errorBanner: requireEl<HTMLDivElement>("error-banner"),
  composer: requireEl<HTMLFormElement>("composer"),
  composerInput: requireEl<HTMLTextAreaElement>("composer-input"),
  sendButton: requireEl<HTMLButtonElement>("send-button"),
  stopButton: requireEl<HTMLButtonElement>("stop-button"),
  uploadInput: requireEl<HTMLInputElement>("upload-input"),
  uploadChip: requireEl<HTMLDivElement>("upload-chip"),
  papersList: requireEl<HTMLDivElement>("papers-list"),
  paperDetail: requireEl<HTMLDivElement>("paper-detail"),
  refreshPapers: requireEl<HTMLButtonElement>("refresh-papers"),
};

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function errorFromBody(body: unknown): { code: string; message: string } | null {
  if (body && typeof body === "object" && "error" in body) {
    const wrapped = (body as { error?: unknown }).error;
    if (wrapped && typeof wrapped === "object") {
      const code =
        typeof (wrapped as { code?: unknown }).code === "string"
          ? (wrapped as { code: string }).code
          : "ERROR";
      const message =
        typeof (wrapped as { message?: unknown }).message === "string"
          ? (wrapped as { message: string }).message
          : "Request failed.";
      return { code, message };
    }
  }
  return null;
}

async function readError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const text = await res.text();
    if (text !== "") {
      const parsed: unknown = JSON.parse(text);
      const info = errorFromBody(parsed);
      if (info) return info;
    }
  } catch {
    // fall through to the status-based message
  }
  return { code: `HTTP_${res.status}`, message: res.statusText || "Request failed." };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const info = errorFromBody(body) ?? {
      code: `HTTP_${res.status}`,
      message: res.statusText || "Request failed.",
    };
    throw new ApiRequestError(res.status, info.code, info.message);
  }
  return body as T;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return error instanceof Error && error.name === "AbortError";
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof ApiRequestError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "ERROR", message: error.message };
  return { code: "ERROR", message: String(error) };
}

/* ------------------------------------------------------------------ */
/* Selection persistence                                               */
/* ------------------------------------------------------------------ */

function readStoredSelection(): string | null {
  try {
    return window.localStorage.getItem(SELECTION_KEY);
  } catch {
    return null;
  }
}

function persistSelection(id: string | null): void {
  try {
    if (id === null) window.localStorage.removeItem(SELECTION_KEY);
    else window.localStorage.setItem(SELECTION_KEY, id);
  } catch {
    // storage may be unavailable; selection still works for this session
  }
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

void bootstrap();

async function bootstrap(): Promise<void> {
  bindEvents();
  await Promise.all([loadConfig(), loadConversations(), loadPapers()]);
  await restoreConversation();
}

function bindEvents(): void {
  els.newConversation.addEventListener("click", () => {
    void createConversation();
  });
  els.refreshPapers.addEventListener("click", () => {
    void loadPapers();
  });
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  els.composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendPrompt();
    }
  });
  els.stopButton.addEventListener("click", () => {
    state.abort?.abort();
  });
  els.uploadInput.addEventListener("change", () => {
    const file = els.uploadInput.files?.[0];
    els.uploadInput.value = "";
    if (file) void handleUpload(file);
  });
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

async function loadConfig(): Promise<void> {
  try {
    const config = await request<AppConfig>("/api/config");
    els.providerDisclosure.textContent = `${config.provider_disclosure} Provider: ${config.provider} · Model: ${config.model}.`;
  } catch (error) {
    els.providerDisclosure.textContent = "Provider disclosure is unavailable.";
    showError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

async function loadConversations(): Promise<void> {
  try {
    state.conversations = await request<ConversationSummary[]>("/api/conversations");
    renderConversations();
  } catch (error) {
    showError(error);
  }
}

function renderConversations(): void {
  els.conversationList.replaceChildren();
  if (state.conversations.length === 0) {
    els.conversationList.append(el("li", "empty-hint", "No conversations yet."));
    return;
  }
  for (const conversation of state.conversations) {
    const item = el("li", "conversation-item");
    if (conversation.conversation_id === state.selectedConversationId) {
      item.classList.add("selected");
    }
    item.dataset.id = conversation.conversation_id;

    const main = el("div", "conversation-main");
    const title = el("span", "conversation-title-text", conversation.title);
    title.title = conversation.title;
    const count = conversation.message_count;
    main.append(title, el("span", "conversation-meta", `${count} message${count === 1 ? "" : "s"}`));

    const rename = el("button", "btn-icon conversation-rename", "Rename");
    rename.type = "button";
    rename.addEventListener("click", (event) => {
      event.stopPropagation();
      startRename(conversation, title);
    });

    item.append(main, rename);
    item.addEventListener("click", () => {
      void selectConversation(conversation.conversation_id);
    });
    els.conversationList.append(item);
  }
}

function startRename(conversation: ConversationSummary, titleEl: HTMLElement): void {
  if (state.streaming) return;
  const input = el("input", "rename-input");
  input.value = conversation.title;
  titleEl.replaceChildren(input);
  input.focus();
  input.select();

  let finished = false;
  const commit = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (next === "" || next === conversation.title) {
      renderConversations();
      return;
    }
    try {
      const meta = await request<ConversationMeta>(
        `/api/conversations/${encodeURIComponent(conversation.conversation_id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: next }),
        },
      );
      const target = state.conversations.find(
        (entry) => entry.conversation_id === meta.conversation_id,
      );
      if (target) target.title = meta.title;
      renderConversations();
    } catch (error) {
      showError(error);
      renderConversations();
    }
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      finished = true;
      renderConversations();
    }
  });
  input.addEventListener("blur", () => {
    void commit();
  });
}

async function createConversation(): Promise<void> {
  if (state.streaming) return;
  try {
    const meta = await request<ConversationMeta>("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    state.conversations.unshift({ ...meta, message_count: 0 });
    state.selectedConversationId = meta.conversation_id;
    persistSelection(meta.conversation_id);
    renderConversations();
    els.transcript.replaceChildren();
    clearError();
    els.composerInput.focus();
  } catch (error) {
    showError(error);
  }
}

async function restoreConversation(): Promise<void> {
  const stored = readStoredSelection();
  if (stored !== null && state.conversations.some((c) => c.conversation_id === stored)) {
    await selectConversation(stored);
    return;
  }
  if (stored !== null) persistSelection(null);
  const first = state.conversations[0];
  if (first) {
    await selectConversation(first.conversation_id);
    return;
  }
  await createConversation();
}

async function selectConversation(id: string): Promise<void> {
  if (state.streaming) return;
  state.selectedConversationId = id;
  persistSelection(id);
  renderConversations();
  els.transcript.replaceChildren();
  clearError();
  try {
    const record = await request<ConversationRecord>(
      `/api/conversations/${encodeURIComponent(id)}`,
    );
    renderHistory(record.messages);
    els.composerInput.focus();
  } catch (error) {
    showError(error);
    if (error instanceof ApiRequestError && error.status === 404) {
      state.conversations = state.conversations.filter((c) => c.conversation_id !== id);
      if (state.selectedConversationId === id) {
        state.selectedConversationId = null;
        persistSelection(null);
      }
      await restoreConversation();
    }
  }
}

function renderHistory(messages: ConversationMessage[]): void {
  els.transcript.replaceChildren();
  if (messages.length === 0) {
    els.transcript.append(el("p", "empty-hint", "Send a message to start the conversation."));
    return;
  }
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      appendMessage("user", message.content);
    } else if (message.role === "assistant") {
      const row = appendMessage("assistant", message.content);
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          row.append(createToolActivity(call.name, call.arguments, null));
        }
      }
    } else if (message.role === "tool") {
      appendMessage("tool", message.content, message.name);
    }
  }
  scrollTranscriptToBottom();
}

function appendMessage(
  role: "user" | "assistant" | "tool",
  content: string,
  toolName?: string,
): HTMLElement {
  const row = el("div", `message message-${role}`);
  const label = role === "tool" ? `tool · ${toolName ?? "result"}` : role;
  row.append(el("div", "message-role", label));
  const body = el("div", "message-content");
  const display = role === "user" ? stripUploadAnnotation(content) : content;
  if (display !== "") body.textContent = display;
  row.append(body);
  els.transcript.append(row);
  scrollTranscriptToBottom();
  return row;
}

function appendAssistantNotice(text: string): void {
  const row = el("div", "message message-assistant");
  row.append(el("div", "message-role", "assistant"), el("div", "message-content", text));
  els.transcript.append(row);
  scrollTranscriptToBottom();
}

function ensureStreamingTextEl(): HTMLElement {
  if (streamingTextEl) return streamingTextEl;
  const row = appendMessage("assistant", "");
  const content = row.querySelector<HTMLElement>(".message-content");
  if (!content) throw new Error("Failed to create transcript element.");
  streamingTextEl = content;
  return content;
}

function createToolActivity(name: string, args: string, resolved: boolean | null): HTMLElement {
  const node = el("div", "tool-activity");
  node.append(el("span", "tool-name", name));
  if (args !== "") node.append(el("code", "tool-args", truncate(args, 140)));
  if (resolved === null) node.classList.add("pending");
  else node.classList.add(resolved ? "ok" : "failed");
  return node;
}

function recordToolCall(name: string, args: string): void {
  const node = createToolActivity(name, args, null);
  node.querySelector(".tool-name")!.textContent = `${name}…`;
  els.transcript.append(node);
  const list = pendingTools.get(name) ?? [];
  list.push(node);
  pendingTools.set(name, list);
  scrollTranscriptToBottom();
}

function recordToolResult(name: string, ok: boolean): void {
  const node = pendingTools.get(name)?.shift();
  const target = node ?? createToolActivity(name, "", ok);
  target.classList.remove("pending");
  target.classList.add(ok ? "ok" : "failed");
  const label = target.querySelector(".tool-name");
  if (label) label.textContent = `${name} ${ok ? "done" : "failed"}`;
  if (!node) els.transcript.append(target);
  scrollTranscriptToBottom();
}

function updateConversationTitle(id: string, title: string): void {
  const target = state.conversations.find((c) => c.conversation_id === id);
  if (target) target.title = title;
  renderConversations();
}

function scrollTranscriptToBottom(): void {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

async function sendPrompt(): Promise<void> {
  if (state.streaming) return;
  const conversationId = state.selectedConversationId;
  if (!conversationId) {
    showError(new Error("No conversation is selected."));
    return;
  }
  const prompt = els.composerInput.value.trim();
  if (prompt === "") return;

  const upload = state.stagedUpload;
  clearError();
  els.composerInput.value = "";
  appendMessage(
    "user",
    upload ? `${prompt}\n\n[staged upload] ${upload.original_filename}` : prompt,
  );

  setStreaming(true);
  streamingText = "";
  streamingTextEl = null;
  pendingTools.clear();
  const controller = new AbortController();
  state.abort = controller;

  try {
    const body: Record<string, unknown> = { prompt };
    if (upload) body.upload_id = upload.upload_id;
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const info = await readError(res);
      throw new ApiRequestError(res.status, info.code, info.message);
    }
    if (!res.body) throw new Error("The server did not return a stream.");
    await consumeSse(res.body, handleAgentEvent);
  } catch (error) {
    if (isAbortError(error)) {
      appendAssistantNotice("Streaming stopped.");
    } else {
      showError(error);
    }
  } finally {
    setStreaming(false);
    state.abort = null;
    if (state.stagedUpload) clearStagedUpload();
    await loadConversations();
  }
}

function setStreaming(streaming: boolean): void {
  state.streaming = streaming;
  els.sendButton.disabled = streaming;
  els.newConversation.disabled = streaming;
  els.stopButton.classList.toggle("hidden", !streaming);
  els.sendButton.classList.toggle("hidden", streaming);
}

function handleAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case "conversation": {
      if (state.selectedConversationId === null) {
        state.selectedConversationId = event.conversation.conversation_id;
        persistSelection(event.conversation.conversation_id);
      }
      updateConversationTitle(event.conversation.conversation_id, event.conversation.title);
      break;
    }
    case "text": {
      const target = ensureStreamingTextEl();
      streamingText += event.delta;
      target.textContent = streamingText;
      scrollTranscriptToBottom();
      break;
    }
    case "tool_call": {
      recordToolCall(event.name, event.arguments);
      break;
    }
    case "tool_result": {
      recordToolResult(event.name, event.ok);
      break;
    }
    case "error": {
      showError(new ApiRequestError(0, event.code, event.message));
      break;
    }
    case "done": {
      updateConversationTitle(event.conversation_id, event.title);
      break;
    }
  }
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = (): void => {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseChunk(chunk);
      if (event) onEvent(event);
      index = buffer.indexOf("\n\n");
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      flush();
    }
    buffer += decoder.decode();
    flush();
    if (buffer.trim() !== "") {
      const event = parseSseChunk(buffer);
      if (event) onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseChunk(chunk: string): AgentEvent | null {
  let data = "";
  for (const line of chunk.split("\n")) {
    const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (clean.startsWith("data:")) data += clean.slice(5).trimStart();
  }
  if (data === "") return null;
  try {
    return JSON.parse(data) as AgentEvent;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

async function handleUpload(file: File): Promise<void> {
  clearError();
  try {
    const res = await fetch("/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "application/pdf",
        "x-original-filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!res.ok) {
      const info = await readError(res);
      throw new ApiRequestError(res.status, info.code, info.message);
    }
    const result = (await res.json()) as UploadResult;
    setStagedUpload(result);
  } catch (error) {
    showError(error);
  }
}

function setStagedUpload(upload: UploadResult): void {
  state.stagedUpload = upload;
  els.uploadChip.replaceChildren();
  els.uploadChip.classList.remove("hidden");
  els.uploadChip.append(
    el("span", "upload-chip-label", `${upload.original_filename} (${formatBytes(upload.byte_size)})`),
  );
  const remove = el("button", "btn-icon", "Remove");
  remove.type = "button";
  remove.addEventListener("click", () => {
    clearStagedUpload();
  });
  els.uploadChip.append(remove);
  els.composerInput.focus();
}

function clearStagedUpload(): void {
  state.stagedUpload = null;
  els.uploadChip.replaceChildren();
  els.uploadChip.classList.add("hidden");
}

/* ------------------------------------------------------------------ */
/* Papers                                                              */
/* ------------------------------------------------------------------ */

async function loadPapers(): Promise<void> {
  try {
    state.papers = await request<PaperSummary[]>("/api/papers");
    renderPapers();
  } catch (error) {
    showError(error);
  }
}

function renderPapers(): void {
  state.selectedPaperId = null;
  els.paperDetail.classList.add("hidden");
  els.papersList.classList.remove("hidden");
  els.papersList.replaceChildren();
  if (state.papers.length === 0) {
    els.papersList.append(el("p", "empty-hint", "No Papers in the Library yet."));
    return;
  }
  for (const paper of state.papers) {
    const card = el("button", "paper-card");
    card.type = "button";
    card.append(el("span", "paper-card-title", paper.title));
    const meta = [
      formatCreators(paper.creators),
      paper.date ?? "undated",
      `${paper.attachment_count} attachment${paper.attachment_count === 1 ? "" : "s"}`,
    ]
      .filter((part) => part !== "")
      .join(" · ");
    card.append(el("span", "paper-card-meta", meta));
    if (paper.doi) card.append(el("span", "paper-card-doi", `DOI: ${paper.doi}`));
    card.addEventListener("click", () => {
      void openPaper(paper.paper_id);
    });
    els.papersList.append(card);
  }
}

async function openPaper(paperId: string): Promise<void> {
  state.selectedPaperId = paperId;
  els.papersList.classList.add("hidden");
  els.paperDetail.classList.remove("hidden");
  els.paperDetail.replaceChildren(el("p", "empty-hint", "Loading Paper…"));
  try {
    const detail = await request<PaperDetail>(`/api/papers/${encodeURIComponent(paperId)}`);
    renderPaperDetail(detail);
  } catch (error) {
    showError(error);
    renderPapers();
  }
}

function renderPaperDetail(detail: PaperDetail): void {
  const root = els.paperDetail;
  root.replaceChildren();

  const back = el("button", "btn btn-ghost", "Back to Papers");
  back.type = "button";
  back.addEventListener("click", () => {
    renderPapers();
  });
  root.append(back);
  root.append(el("h3", "paper-title", detail.metadata.title));

  const meta = el("dl", "metadata");
  addMeta(meta, "Type", detail.metadata.item_type);
  addMeta(meta, "Creators", formatCreators(detail.metadata.creators) || "—");
  addMeta(meta, "Date", detail.metadata.date ?? "—");
  addMeta(meta, "Publication", detail.metadata.publication_title ?? "—");
  const volumeIssuePages = [detail.metadata.volume, detail.metadata.issue, detail.metadata.pages]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" / ");
  addMeta(meta, "Volume / Issue / Pages", volumeIssuePages || "—");
  if (detail.metadata.doi) {
    addMeta(meta, "DOI", doiLink(detail.metadata.doi));
  } else {
    addMeta(meta, "DOI", "—");
  }
  addMeta(meta, "URL", detail.metadata.url ?? "—");
  addMeta(meta, "Tags", detail.metadata.tags.length > 0 ? detail.metadata.tags.join(", ") : "—");
  addMeta(meta, "Paper ID", detail.paper_id);
  root.append(meta);

  if (detail.metadata.abstract_note) {
    root.append(el("h4", "section-title", "Abstract"));
    const abstract = el("p", "abstract");
    abstract.textContent = detail.metadata.abstract_note;
    root.append(abstract);
  }

  root.append(el("h4", "section-title", "Attachments"));
  const attachments = el("div", "attachment-list");
  const viewer = el("iframe", "pdf-viewer");
  viewer.title = "PDF viewer";
  const attachmentButtons: HTMLButtonElement[] = [];

  const showAttachment = (attachment: PaperDetailAttachment): void => {
    for (const button of attachmentButtons) button.classList.remove("active");
    const index = detail.attachments.indexOf(attachment);
    attachmentButtons[index]?.classList.add("active");
    viewer.src = attachmentFileUrl(detail.paper_id, attachment.attachment_id);
  };

  for (const attachment of detail.attachments) {
    const button = el("button", "attachment-item");
    button.type = "button";
    button.append(el("span", "attachment-title", attachment.title));
    if (attachment.primary) button.append(el("span", "attachment-badge", "Primary"));
    const details = [
      attachment.page_count !== null ? `${attachment.page_count} pages` : null,
      attachment.extraction_status,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    button.append(el("span", "attachment-note", details));
    button.addEventListener("click", () => {
      showAttachment(attachment);
    });
    attachmentButtons.push(button);
    attachments.append(button);
  }
  root.append(attachments);

  const primary =
    detail.attachments.find((attachment) => attachment.primary) ?? detail.attachments[0];
  if (primary) {
    viewer.src = attachmentFileUrl(detail.paper_id, primary.attachment_id);
    root.append(viewer);
  } else {
    root.append(el("p", "empty-hint", "This Paper has no Attachments."));
  }

  root.append(el("h4", "section-title", "Paper Note"));
  const noteContainer = el("div", "paper-note");
  root.append(noteContainer);
  void renderNote(detail.paper_id, noteContainer);
}

async function renderNote(paperId: string, container: HTMLElement): Promise<void> {
  container.replaceChildren(el("p", "empty-hint", "Loading Paper Note…"));
  try {
    const note = await request<NoteView>(`/api/papers/${encodeURIComponent(paperId)}/note`);
    container.replaceChildren();

    const header = el("div", "note-header");
    const toggle = el("button", "btn btn-small", "Raw source");
    toggle.type = "button";
    header.append(toggle);
    container.append(header);

    const rendered = el("div", "note-rendered");
    rendered.innerHTML = sanitizeHtml(marked.parse(note.body, { async: false }));
    const raw = el("pre", "note-raw hidden");
    raw.textContent = note.raw;

    let showingRaw = false;
    toggle.addEventListener("click", () => {
      showingRaw = !showingRaw;
      rendered.classList.toggle("hidden", showingRaw);
      raw.classList.toggle("hidden", !showingRaw);
      toggle.textContent = showingRaw ? "Rendered" : "Raw source";
    });

    container.append(rendered, raw);
  } catch (error) {
    container.replaceChildren();
    if (error instanceof ApiRequestError && error.status === 404) {
      container.append(el("p", "empty-hint", "No Paper Note for this Paper."));
    } else {
      showError(error);
      container.append(el("p", "empty-hint", "Failed to load the Paper Note."));
    }
  }
}

function attachmentFileUrl(paperId: string, attachmentId: string): string {
  return `/api/papers/${encodeURIComponent(paperId)}/attachments/${encodeURIComponent(attachmentId)}/file`;
}

function doiLink(doi: string): HTMLAnchorElement {
  const anchor = el("a", undefined, doi);
  anchor.href = `https://doi.org/${encodeURIComponent(doi)}`;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function addMeta(dl: HTMLDListElement, label: string, value: string | Node): void {
  dl.append(el("dt", undefined, label));
  const dd = el("dd");
  if (typeof value === "string") dd.textContent = value;
  else dd.append(value);
  dl.append(dd);
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function showError(error: unknown): void {
  const { code, message } = describeError(error);
  els.errorBanner.textContent = `${code}: ${message}`;
  els.errorBanner.classList.remove("hidden");
}

function clearError(): void {
  els.errorBanner.textContent = "";
  els.errorBanner.classList.add("hidden");
}

function stripUploadAnnotation(content: string): string {
  const marker = "\n\n[staged upload]";
  const index = content.indexOf(marker);
  return index === -1 ? content : content.slice(0, index);
}

function formatCreators(creators: Creator[]): string {
  return creators
    .map((creator) => {
      if (creator.name) return creator.name;
      return [creator.first_name, creator.last_name].filter(Boolean).join(" ");
    })
    .filter((name) => name.trim() !== "")
    .join(", ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
