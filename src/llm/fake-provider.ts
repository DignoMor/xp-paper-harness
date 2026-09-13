import type {
  LlmChatRequest,
  LlmEvent,
  LlmProvider,
  LlmToolCall,
} from "../application/ports.js";

export interface FakeToolCallSpec {
  name: string;
  arguments: string | Record<string, unknown>;
  id?: string;
}

export type FakeTurn =
  | { text: string }
  | { text?: string; tool_calls: FakeToolCallSpec[] };

export type FakeHandler = (
  request: LlmChatRequest,
  turnIndex: number,
) => FakeTurn | undefined;

export interface FakeLlmProviderOptions {
  defaultModel?: string;
  script?: FakeTurn[];
  handler?: FakeHandler;
  chunkSize?: number;
}

const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_CHUNK_SIZE = 16;

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  readonly defaultModel: string;

  private readonly script: FakeTurn[];
  private readonly handler: FakeHandler | undefined;
  private readonly chunkSize: number;
  private index = 0;

  constructor(options: FakeLlmProviderOptions = {}) {
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.script = options.script ? [...options.script] : [];
    this.handler = options.handler;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  get turnIndex(): number {
    return this.index;
  }

  private nextTurn(
    request: LlmChatRequest,
  ): { turn: FakeTurn | undefined; turnIndex: number } {
    const turnIndex = this.index;
    const turn = this.handler?.(request, turnIndex) ?? this.script[turnIndex];
    this.index += 1;
    return { turn, turnIndex };
  }

  async *stream(request: LlmChatRequest): AsyncIterable<LlmEvent> {
    throwIfAborted(request.signal);
    const { turn, turnIndex } = this.nextTurn(request);
    if (!turn) {
      yield {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: `FakeLlmProvider: no scripted turn available at index ${turnIndex}`,
      };
      return;
    }

    const text = turn.text ?? "";
    for (const delta of chunkText(text, this.chunkSize)) {
      throwIfAborted(request.signal);
      yield { type: "text", delta };
    }

    const specs = "tool_calls" in turn && turn.tool_calls ? turn.tool_calls : [];
    const emitted: LlmToolCall[] = [];
    specs.forEach((spec, position) => {
      emitted.push({
        id: spec.id ?? `call_${turnIndex}_${position}`,
        name: spec.name,
        arguments:
          typeof spec.arguments === "string"
            ? spec.arguments
            : JSON.stringify(spec.arguments),
      });
    });

    for (const call of emitted) {
      throwIfAborted(request.signal);
      yield { type: "tool_call", call };
    }

    yield {
      type: "done",
      finish_reason: emitted.length > 0 ? "tool_calls" : "stop",
    };
  }
}

function* chunkText(text: string, size: number): Generator<string> {
  if (text.length === 0) return;
  const step = size > 0 ? size : text.length;
  for (let offset = 0; offset < text.length; offset += step) {
    yield text.slice(offset, offset + step);
  }
}

export function abortError(message = "The operation was aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}
