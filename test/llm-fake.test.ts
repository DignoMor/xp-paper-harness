import { describe, expect, it } from "vitest";
import type {
  LlmChatRequest,
  LlmEvent,
} from "../src/application/ports.js";
import { FakeLlmProvider } from "../src/llm/fake-provider.js";

function chatRequest(overrides: Partial<LlmChatRequest> = {}): LlmChatRequest {
  return {
    model: "deepseek-v4.1-flash",
    session_id: "session-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...overrides,
  };
}

async function collect(
  iterable: AsyncIterable<LlmEvent>,
): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function textOf(events: LlmEvent[]): string {
  return events
    .filter((event): event is { type: "text"; delta: string } => event.type === "text")
    .map((event) => event.delta)
    .join("");
}

describe("FakeLlmProvider", () => {
  it("streams scripted text as chunks and finishes with stop", async () => {
    const provider = new FakeLlmProvider({
      script: [{ text: "Hello from the fake provider" }],
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(textOf(events)).toBe("Hello from the fake provider");
    expect(events.at(-1)).toEqual({ type: "done", finish_reason: "stop" });
  });

  it("emits scripted tool calls and finishes with tool_calls", async () => {
    const provider = new FakeLlmProvider({
      script: [
        {
          text: "calling",
          tool_calls: [
            { name: "lookup_doi", arguments: { doi: "10.1/x" } },
            { name: "list_notes", arguments: '{"paper_id":"p1"}', id: "fixed-id" },
          ],
        },
      ],
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(textOf(events)).toBe("calling");
    const calls = events.filter(
      (event): event is { type: "tool_call"; call: never } =>
        event.type === "tool_call",
    );
    expect(calls).toHaveLength(2);
    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      {
        type: "tool_call",
        call: {
          id: "call_0_0",
          name: "lookup_doi",
          arguments: '{"doi":"10.1/x"}',
        },
      },
      {
        type: "tool_call",
        call: {
          id: "fixed-id",
          name: "list_notes",
          arguments: '{"paper_id":"p1"}',
        },
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "done",
      finish_reason: "tool_calls",
    });
  });

  it("is deterministic across independent providers for the same script", async () => {
    const script = [
      { text: "first" },
      { tool_calls: [{ name: "noop", arguments: {} }] },
    ];

    const a = await collect(new FakeLlmProvider({ script }).stream(chatRequest()));
    const b = await collect(new FakeLlmProvider({ script }).stream(chatRequest()));

    expect(a).toEqual(b);
  });

  it("advances through the script one turn per stream call", async () => {
    const provider = new FakeLlmProvider({
      script: [{ text: "one" }, { text: "two" }],
    });

    expect(textOf(await collect(provider.stream(chatRequest())))).toBe("one");
    expect(textOf(await collect(provider.stream(chatRequest())))).toBe("two");
    expect(provider.turnIndex).toBe(2);
  });

  it("throws when the script is exhausted", async () => {
    const provider = new FakeLlmProvider({ script: [] });
    await expect(collect(provider.stream(chatRequest()))).rejects.toThrow(
      /no scripted turn/,
    );
  });

  it("supports a handler that inspects the latest user message", async () => {
    const provider = new FakeLlmProvider({
      handler: (request, turnIndex) => {
        const lastUser = [...request.messages]
          .reverse()
          .find((message) => message.role === "user");
        if (lastUser?.content.includes("weather")) {
          return {
            tool_calls: [{ name: "get_weather", arguments: { city: "Oslo" } }],
          };
        }
        return { text: `turn ${turnIndex}: no tool` };
      },
    });

    const toolEvents = await collect(
      provider.stream(
        chatRequest({
          messages: [{ role: "user", content: "what is the weather" }],
        }),
      ),
    );
    expect(toolEvents.filter((event) => event.type === "tool_call")).toHaveLength(1);
    expect(toolEvents.at(-1)).toEqual({
      type: "done",
      finish_reason: "tool_calls",
    });

    const textEvents = await collect(
      provider.stream(
        chatRequest({ messages: [{ role: "user", content: "say hello" }] }),
      ),
    );
    expect(textOf(textEvents)).toBe("turn 1: no tool");
  });

  it("rejects with an AbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeLlmProvider({ script: [{ text: "never" }] });

    await expect(
      collect(provider.stream(chatRequest({ signal: controller.signal }))),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects with an AbortError when aborted mid-stream", async () => {
    const controller = new AbortController();
    const provider = new FakeLlmProvider({
      script: [{ text: "abcdef" }],
      chunkSize: 2,
    });

    const iterator = provider
      .stream(chatRequest({ signal: controller.signal }))
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value).toEqual({ type: "text", delta: "ab" });

    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the configured default model", () => {
    expect(new FakeLlmProvider().defaultModel).toBe("deepseek-v4.1-flash");
    expect(new FakeLlmProvider({ defaultModel: "custom" }).defaultModel).toBe(
      "custom",
    );
  });
});
