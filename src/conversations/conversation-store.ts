import { appendFile, readFile, readdir } from "node:fs/promises";
import type { Clock, DataPaths } from "../application/ports.js";
import { AppError } from "../domain/errors.js";
import { uuidv7 } from "../domain/ids.js";
import { atomicWriteFile, ensureDir } from "../infrastructure/fs/atomic.js";
import { isNotFound } from "../infrastructure/fs/errors.js";

export type ConversationId = string & { readonly __brand: "ConversationId" };

export interface ConversationMeta {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  created_at: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface Conversation {
  meta: ConversationMeta;
  messages: ConversationMessage[];
}

export interface ConversationSummary {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ConversationIdGenerator {
  conversationId(): string;
}

export interface ConversationStoreOptions {
  paths: DataPaths;
  clock: Clock;
  ids?: ConversationIdGenerator;
}

export const DEFAULT_CONVERSATION_TITLE = "New Conversation";

const MAX_TITLE_LENGTH = 60;
const SESSION_EXTENSION = ".jsonl";

const defaultIdGenerator: ConversationIdGenerator = {
  conversationId: () => `cnv_${uuidv7()}`,
};

const ROLES: ReadonlySet<ConversationMessage["role"]> = new Set([
  "system",
  "user",
  "assistant",
  "tool",
]);

export class ConversationStore {
  private readonly paths: DataPaths;
  private readonly clock: Clock;
  private readonly ids: ConversationIdGenerator;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ConversationStoreOptions) {
    this.paths = options.paths;
    this.clock = options.clock;
    this.ids = options.ids ?? defaultIdGenerator;
  }

  async create(title?: string): Promise<Conversation> {
    const timestamp = this.clock.isoNow();
    const meta: ConversationMeta = {
      conversation_id: this.ids.conversationId(),
      title:
        typeof title === "string" && title.trim() !== ""
          ? title
          : DEFAULT_CONVERSATION_TITLE,
      created_at: timestamp,
      updated_at: timestamp,
    };
    const conversation: Conversation = { meta, messages: [] };
    return this.enqueue(async () => {
      await ensureDir(this.paths.sessionsDir());
      await atomicWriteFile(
        this.paths.sessionFile(meta.conversation_id),
        serializeMeta(meta),
      );
      return conversation;
    });
  }

  async list(): Promise<ConversationSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.sessionsDir());
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const summaries: ConversationSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(SESSION_EXTENSION)) continue;
      const id = entry.slice(0, -SESSION_EXTENSION.length);
      const conversation = await this.readConversation(id);
      if (conversation === null) continue;
      summaries.push({
        ...conversation.meta,
        message_count: conversation.messages.length,
      });
    }
    summaries.sort((a, b) =>
      a.updated_at === b.updated_at
        ? a.conversation_id.localeCompare(b.conversation_id)
        : b.updated_at.localeCompare(a.updated_at),
    );
    return summaries;
  }

  async get(id: string): Promise<Conversation> {
    const conversation = await this.readConversation(id);
    if (conversation === null) {
      throw new AppError("NOT_FOUND", `Conversation ${id} was not found.`, {
        conversation_id: id,
      });
    }
    return conversation;
  }

  async history(id: string): Promise<ConversationMessage[]> {
    return (await this.get(id)).messages;
  }

  async rename(id: string, title: string): Promise<ConversationMeta> {
    const trimmed = typeof title === "string" ? title.trim() : "";
    if (trimmed === "") {
      throw new AppError("INVALID_INPUT", "Conversation title must not be empty.", {
        conversation_id: id,
      });
    }
    return this.enqueue(async () => {
      const conversation = await this.readConversation(id);
      if (conversation === null) {
        throw new AppError("NOT_FOUND", `Conversation ${id} was not found.`, {
          conversation_id: id,
        });
      }
      const meta: ConversationMeta = {
        ...conversation.meta,
        title: trimmed,
        updated_at: this.clock.isoNow(),
      };
      await ensureDir(this.paths.sessionsDir());
      await appendFile(
        this.paths.sessionFile(id),
        serializeMeta(meta),
        "utf8",
      );
      return meta;
    });
  }

  async appendMessage(
    id: string,
    message: ConversationMessage,
  ): Promise<ConversationMessage> {
    if (!ROLES.has(message?.role)) {
      throw new AppError("INVALID_INPUT", "Conversation message role is invalid.", {
        conversation_id: id,
        role: (message as { role?: unknown } | null | undefined)?.role,
      });
    }
    return this.enqueue(async () => {
      const conversation = await this.readConversation(id);
      if (conversation === null) {
        throw new AppError("NOT_FOUND", `Conversation ${id} was not found.`, {
          conversation_id: id,
        });
      }
      const normalized: ConversationMessage = {
        ...message,
        created_at:
          typeof message.created_at === "string" && message.created_at !== ""
            ? message.created_at
            : this.clock.isoNow(),
      };
      await ensureDir(this.paths.sessionsDir());
      await appendFile(
        this.paths.sessionFile(id),
        serializeMessage(normalized),
        "utf8",
      );
      return normalized;
    });
  }

  defaultTitleFromPrompt(prompt: string): string {
    if (typeof prompt !== "string") return DEFAULT_CONVERSATION_TITLE;
    const firstLine = prompt
      .split(/\r?\n/)
      .find((line) => line.trim() !== "");
    if (firstLine === undefined) return DEFAULT_CONVERSATION_TITLE;
    const collapsed = firstLine.trim().replace(/\s+/g, " ");
    if (collapsed === "") return DEFAULT_CONVERSATION_TITLE;
    if (collapsed.length > MAX_TITLE_LENGTH) {
      return `${collapsed.slice(0, MAX_TITLE_LENGTH)}…`;
    }
    return collapsed;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readConversation(id: string): Promise<Conversation | null> {
    let raw: string;
    try {
      raw = await readFile(this.paths.sessionFile(id), "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    const lines = raw.split("\n");
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if ((lines[i] ?? "").trim() !== "") {
        lastNonEmpty = i;
        break;
      }
    }

    let meta: ConversationMeta | null = null;
    const messages: ConversationMessage[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (i === lastNonEmpty) break;
        throw new AppError(
          "INTERNAL",
          "Conversation log contains invalid JSON.",
          {
            conversation_id: id,
            line: i + 1,
            detail: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (!isRecord(parsed)) continue;
      if (parsed.type === "meta") {
        meta = { ...(meta ?? emptyMeta(id)), ...extractMeta(parsed) };
      } else if (parsed.type === "message") {
        messages.push(extractMessage(parsed));
      }
    }

    if (meta === null) return null;

    const lastMessage = messages[messages.length - 1];
    const updatedAt =
      lastMessage !== undefined && lastMessage.created_at > meta.updated_at
        ? lastMessage.created_at
        : meta.updated_at;

    return { meta: { ...meta, updated_at: updatedAt }, messages };
  }
}

function emptyMeta(id: string): ConversationMeta {
  return {
    conversation_id: id,
    title: DEFAULT_CONVERSATION_TITLE,
    created_at: "",
    updated_at: "",
  };
}

function extractMeta(
  line: Record<string, unknown>,
): Partial<ConversationMeta> {
  const meta: Partial<ConversationMeta> = {};
  if (typeof line.conversation_id === "string") {
    meta.conversation_id = line.conversation_id;
  }
  if (typeof line.title === "string") meta.title = line.title;
  if (typeof line.created_at === "string") meta.created_at = line.created_at;
  if (typeof line.updated_at === "string") meta.updated_at = line.updated_at;
  return meta;
}

function extractMessage(line: Record<string, unknown>): ConversationMessage {
  const message: ConversationMessage = {
    role: isRole(line.role) ? line.role : "user",
    content: typeof line.content === "string" ? line.content : "",
    created_at: typeof line.created_at === "string" ? line.created_at : "",
  };
  if (typeof line.tool_call_id === "string") {
    message.tool_call_id = line.tool_call_id;
  }
  if (typeof line.name === "string") message.name = line.name;
  if (Array.isArray(line.tool_calls)) {
    message.tool_calls = line.tool_calls.filter(isRecord).map((call) => ({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof call.name === "string" ? call.name : "",
      arguments: typeof call.arguments === "string" ? call.arguments : "",
    }));
  }
  return message;
}

function serializeMeta(meta: ConversationMeta): string {
  return `${JSON.stringify({ type: "meta", ...meta })}\n`;
}

function serializeMessage(message: ConversationMessage): string {
  return `${JSON.stringify({ type: "message", ...message })}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRole(value: unknown): value is ConversationMessage["role"] {
  return (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  );
}


