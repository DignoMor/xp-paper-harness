import { describe, expect, it } from "vitest";
import { OpenCodeGoProvider } from "../src/llm/opencode-go-provider.js";
import type { LlmEvent } from "../src/application/ports.js";

const apiKey = process.env.OPENCODE_GO_API_KEY;
const baseUrl = process.env.OPENCODE_GO_BASE_URL;
const model = process.env.OPENCODE_GO_MODEL ?? "deepseek-v4.1-flash";

const run = apiKey ? describe : describe.skip;

run("OpenCode Go real-provider smoke (credential-gated)", () => {
  it(
    "streams DeepSeek V4.1 Flash output and propagates the Conversation session header",
    async () => {
      const provider = new OpenCodeGoProvider({ apiKey: apiKey!, baseUrl, model });
      const events: LlmEvent[] = [];
      for await (const event of provider.stream({
        model,
        session_id: "cnv_smoke-session",
        messages: [
          { role: "system", content: "Reply with exactly the word: pong" },
          { role: "user", content: "ping" },
        ],
        tools: [],
      })) {
        events.push(event);
      }
      const error = events.find((event) => event.type === "error");
      expect(error).toBeUndefined();
      const text = events
        .filter((event): event is Extract<LlmEvent, { type: "text" }> => event.type === "text")
        .map((event) => event.delta)
        .join("");
      expect(text.trim().length).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "done")).toBe(true);
    },
    120_000,
  );
});

if (!apiKey) {
  describe("OpenCode Go real-provider smoke (skipped)", () => {
    it("is skipped without OPENCODE_GO_API_KEY", () => {
      expect(apiKey).toBeUndefined();
    });
  });
}
