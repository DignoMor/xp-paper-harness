import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmChatRequest, LlmEvent } from "../src/application/ports.js";
import {
  CREDENTIALS_MISSING_MESSAGE,
  OpenCodeGoProvider,
  createOpenCodeGoProviderFromEnv,
} from "../src/llm/opencode-go-provider.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface MockServer {
  baseUrl: string;
  requests: CapturedRequest[];
  stop: () => Promise<void>;
}

const servers: MockServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
});

async function startMockServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      void Promise.resolve(respond(req, res)).catch(() => {
        res.statusCode = 500;
        res.end("mock handler failure");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const mock: MockServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
  servers.push(mock);
  return mock;
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatRequest(overrides: Partial<LlmChatRequest> = {}): LlmChatRequest {
  return {
    model: "deepseek-v4.1-flash",
    session_id: "session-1",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "lookup_doi",
        description: "Look up a DOI",
        parameters: { type: "object", properties: { doi: { type: "string" } } },
      },
    ],
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const events: LlmEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe("OpenCodeGoProvider", () => {
  it("streams SSE text and tool calls split across chunks", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse({
          choices: [
            { delta: { role: "assistant", content: "Hel" }, finish_reason: null },
          ],
        }),
      );
      res.write(sse({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }));
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"do' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'i":"10.1/x"}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      );
      res.write(
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const provider = new OpenCodeGoProvider({
      apiKey: "test-key-123",
      baseUrl: server.baseUrl,
      fetchImpl: fetch,
    });

    const events = await collect(
      provider.stream(
        chatRequest({
          session_id: "session-42",
          messages: [
            { role: "system", content: "be terse" },
            { role: "user", content: "find 10.1/x" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_1", name: "lookup_doi", arguments: '{"doi":"10.1/x"}' },
              ],
            },
            {
              role: "tool",
              content: "found",
              tool_call_id: "call_1",
              name: "lookup_doi",
            },
          ],
        }),
      ),
    );

    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      {
        type: "tool_call",
        call: { id: "call_1", name: "lookup", arguments: '{"doi":"10.1/x"}' },
      },
      { type: "done", finish_reason: "tool_calls" },
    ]);

    expect(server.requests).toHaveLength(1);
    const captured = server.requests[0]!;
    expect(captured.method).toBe("POST");
    expect(captured.url).toBe("/chat/completions");
    expect(captured.headers.authorization).toBe("Bearer test-key-123");
    expect(captured.headers["x-session-id"]).toBe("session-42");

    const body = JSON.parse(captured.body) as {
      model: string;
      stream: boolean;
      tools: unknown;
      messages: unknown;
    };
    expect(body.model).toBe("deepseek-v4.1-flash");
    expect(body.stream).toBe(true);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup_doi",
          description: "Look up a DOI",
          parameters: {
            type: "object",
            properties: { doi: { type: "string" } },
          },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "find 10.1/x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup_doi", arguments: '{"doi":"10.1/x"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "found",
        tool_call_id: "call_1",
        name: "lookup_doi",
      },
    ]);
  });

  it("emits an error event for non-2xx responses without leaking secrets", async () => {
    const server = await startMockServer((_req, res) => {
      res.statusCode = 401;
      res.end('{"error":"invalid key test-key-123 secret-body-token"}');
    });
    const provider = new OpenCodeGoProvider({
      apiKey: "test-key-123",
      baseUrl: server.baseUrl,
      fetchImpl: fetch,
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "PROVIDER_FAILURE" });
    const message = (events[0] as { type: "error"; message: string }).message;
    expect(message).toContain("401");
    expect(message).not.toContain("test-key-123");
    expect(message).not.toContain("secret-body-token");
  });

  it("emits an error event on network failure without leaking the key", async () => {
    const provider = new OpenCodeGoProvider({
      apiKey: "test-key-123",
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: () => {
        throw new Error("connection failed for test-key-123");
      },
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", code: "PROVIDER_FAILURE" });
    const message = (events[0] as { type: "error"; message: string }).message;
    expect(message).not.toContain("test-key-123");
  });

  it("reports missing credentials without attempting a request", async () => {
    let called = false;
    const provider = new OpenCodeGoProvider({
      apiKey: "",
      fetchImpl: (() => {
        called = true;
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(called).toBe(false);
    expect(events).toEqual([
      {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: CREDENTIALS_MISSING_MESSAGE,
      },
    ]);
  });

  it("creates a provider from env and honors OPENCODE_GO_BASE_URL", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        sse({
          choices: [
            { delta: { content: "ok" }, finish_reason: null },
          ],
        }),
      );
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const provider = createOpenCodeGoProviderFromEnv({
      OPENCODE_GO_API_KEY: "env-key",
      OPENCODE_GO_BASE_URL: server.baseUrl,
    });

    const events = await collect(provider.stream(chatRequest()));

    expect(events).toEqual([
      { type: "text", delta: "ok" },
      { type: "done", finish_reason: "stop" },
    ]);
    expect(server.requests[0]!.headers.authorization).toBe("Bearer env-key");
  });

  it("constructs from env with missing credentials and yields the config error", async () => {
    const provider = createOpenCodeGoProviderFromEnv({});
    const events = await collect(provider.stream(chatRequest()));
    expect(events).toEqual([
      {
        type: "error",
        code: "PROVIDER_FAILURE",
        message: CREDENTIALS_MISSING_MESSAGE,
      },
    ]);
  });

  it("honors a custom session header name", async () => {
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "x" }, finish_reason: null }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    });

    const provider = new OpenCodeGoProvider({
      apiKey: "k",
      baseUrl: server.baseUrl,
      sessionHeader: "x-custom-session",
      fetchImpl: fetch,
    });
    await collect(provider.stream(chatRequest({ session_id: "abc" })));

    expect(server.requests[0]!.headers["x-custom-session"]).toBe("abc");
  });
});
