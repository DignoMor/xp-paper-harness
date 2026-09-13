import type {
  LlmChatRequest,
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolSpec,
} from "../application/ports.js";
import { abortError, throwIfAborted } from "./fake-provider.js";

export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_SESSION_HEADER = "x-session-id";
export const CREDENTIALS_MISSING_MESSAGE =
  "OpenCode Go credentials are not configured.";

export interface OpenCodeGoConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  sessionHeader?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiChoice {
  delta?: OpenAiDelta;
  finish_reason?: string | null;
}

interface OpenAiChunk {
  choices?: OpenAiChoice[];
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

interface ChunkOutcome {
  texts: string[];
  completed: LlmToolCall[];
  finishReason?: string;
}

export class OpenCodeGoProvider implements LlmProvider {
  readonly name = "opencode-go";
  readonly defaultModel: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sessionHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenCodeGoConfig) {
    this.apiKey = config.apiKey;
    this.defaultModel = config.model ?? DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.sessionHeader = config.sessionHeader ?? DEFAULT_SESSION_HEADER;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmEvent> {
    if (!this.apiKey) {
      yield {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: CREDENTIALS_MISSING_MESSAGE,
      };
      return;
    }

    const url = `${stripTrailingSlash(this.baseUrl)}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${this.apiKey}`,
    };
    headers[this.sessionHeader] = request.session_id;

    const body = JSON.stringify({
      model: request.model || this.defaultModel,
      messages: request.messages.map(toOpenAiMessage),
      tools: request.tools.map(toOpenAiTool),
      stream: true,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: request.signal,
      });
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) {
        throw abortError();
      }
      yield {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: "Unable to reach the OpenCode Go service.",
      };
      return;
    }

    if (!response.ok) {
      yield {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: `OpenCode Go request failed (HTTP ${response.status}).`,
      };
      return;
    }

    const stream = response.body;
    if (!stream) {
      yield {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: "OpenCode Go returned an empty response body.",
      };
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const pending = new Map<number, PendingToolCall>();
    let buffer = "";
    let finishReason: string | undefined;
    let sawDone = false;

    try {
      read: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        throwIfAborted(request.signal);
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const rawLine = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

          const payload = ssePayload(line);
          if (payload !== null) {
            if (payload === "[DONE]") {
              sawDone = true;
              break read;
            }
            const outcome = applyChunk(payload, pending);
            for (const text of outcome.texts) {
              yield { type: "text", delta: text };
            }
            for (const call of outcome.completed) {
              yield { type: "tool_call", call };
            }
            if (outcome.finishReason !== undefined) {
              finishReason = outcome.finishReason;
            }
          }

          newline = buffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!sawDone && buffer.length > 0) {
      const payload = ssePayload(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (payload !== null && payload !== "[DONE]") {
        const outcome = applyChunk(payload, pending);
        for (const text of outcome.texts) {
          yield { type: "text", delta: text };
        }
        for (const call of outcome.completed) {
          yield { type: "tool_call", call };
        }
        if (outcome.finishReason !== undefined) {
          finishReason = outcome.finishReason;
        }
      }
    }

    for (const call of drainPending(pending)) {
      yield { type: "tool_call", call };
    }

    yield { type: "done", finish_reason: finishReason ?? "stop" };
  }
}

export function createOpenCodeGoProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenCodeGoProvider {
  return new OpenCodeGoProvider({
    apiKey: env.OPENCODE_GO_API_KEY ?? "",
    baseUrl: env.OPENCODE_GO_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.OPENCODE_GO_MODEL ?? DEFAULT_MODEL,
    sessionHeader: env.OPENCODE_GO_SESSION_HEADER ?? DEFAULT_SESSION_HEADER,
  });
}

function applyChunk(
  payload: string,
  pending: Map<number, PendingToolCall>,
): ChunkOutcome {
  const texts: string[] = [];
  const completed: LlmToolCall[] = [];
  let finishReason: string | undefined;

  let chunk: OpenAiChunk;
  try {
    chunk = JSON.parse(payload) as OpenAiChunk;
  } catch {
    return { texts, completed };
  }

  const choice = chunk.choices?.[0];
  if (!choice) return { texts, completed };

  const delta = choice.delta ?? {};
  if (typeof delta.content === "string" && delta.content.length > 0) {
    texts.push(delta.content);
  }

  if (Array.isArray(delta.tool_calls)) {
    for (const fragment of delta.tool_calls) {
      const index = typeof fragment.index === "number" ? fragment.index : 0;
      if (!pending.has(index) && pending.size > 0) {
        completed.push(...drainPending(pending));
      }
      let acc = pending.get(index);
      if (!acc) {
        acc = { id: "", name: "", args: "" };
        pending.set(index, acc);
      }
      if (typeof fragment.id === "string" && fragment.id.length > 0) {
        acc.id = fragment.id;
      }
      const fn = fragment.function;
      if (fn) {
        if (typeof fn.name === "string") {
          acc.name += fn.name;
        }
        if (typeof fn.arguments === "string") {
          acc.args += fn.arguments;
        }
      }
    }
  }

  if (choice.finish_reason) {
    finishReason = choice.finish_reason;
    if (pending.size > 0) {
      completed.push(...drainPending(pending));
    }
  }

  return { texts, completed, finishReason };
}

function drainPending(pending: Map<number, PendingToolCall>): LlmToolCall[] {
  const calls: LlmToolCall[] = [];
  for (const acc of pending.values()) {
    calls.push({ id: acc.id, name: acc.name, arguments: acc.args });
  }
  pending.clear();
  return calls;
}

function ssePayload(line: string): string | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (payload.length === 0) return null;
  return payload;
}

function toOpenAiMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case "assistant": {
      const mapped: Record<string, unknown> = {
        role: "assistant",
        content: message.content,
      };
      if (message.tool_calls && message.tool_calls.length > 0) {
        mapped.tool_calls = message.tool_calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return mapped;
    }
    case "tool": {
      const mapped: Record<string, unknown> = {
        role: "tool",
        content: message.content,
      };
      if (message.tool_call_id !== undefined) {
        mapped.tool_call_id = message.tool_call_id;
      }
      if (message.name !== undefined) {
        mapped.name = message.name;
      }
      return mapped;
    }
    case "system":
      return { role: "system", content: message.content };
    case "user":
    default:
      return { role: "user", content: message.content };
  }
}

function toOpenAiTool(tool: LlmToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
