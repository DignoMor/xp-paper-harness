import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock, type Clock } from "../src/application/ports.js";
import {
  ConversationStore,
  DEFAULT_CONVERSATION_TITLE,
  type ConversationMessage,
} from "../src/conversations/index.js";
import { FileSystemDataPaths } from "../src/infrastructure/fs/paths.js";

interface TestClock extends Clock {
  advance(ms: number): void;
}

function createTestClock(startMs = Date.parse("2026-01-01T00:00:00.000Z")): TestClock {
  let current = startMs;
  return {
    now: () => new Date(current),
    isoNow: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function message(
  role: ConversationMessage["role"],
  content: string,
  createdAt: string,
): ConversationMessage {
  return { role, content, created_at: createdAt };
}

describe("ConversationStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paper-harness-conversations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function newStore(clock: Clock = systemClock): ConversationStore {
    return new ConversationStore({ paths: new FileSystemDataPaths(dir), clock });
  }

  it("creates a conversation with a prefixed id and lists it", async () => {
    const store = newStore();
    const conversation = await store.create();

    expect(conversation.meta.conversation_id).toMatch(/^cnv_[0-9a-f-]{36}$/);
    expect(conversation.meta.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect(conversation.messages).toEqual([]);

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.conversation_id)).toContain(
      conversation.meta.conversation_id,
    );
    expect(summaries[0]?.message_count).toBe(0);
  });

  it("uses an explicit title when creating", async () => {
    const store = newStore();
    const conversation = await store.create("My research");
    expect(conversation.meta.title).toBe("My research");
  });

  it("appends messages and returns them from history in order", async () => {
    const store = newStore();
    const conversation = await store.create();
    const id = conversation.meta.conversation_id;

    await store.appendMessage(id, message("user", "hello", systemClock.isoNow()));
    await store.appendMessage(
      id,
      message("assistant", "hi there", systemClock.isoNow()),
    );
    await store.appendMessage(
      id,
      message("tool", "result", systemClock.isoNow()),
    );

    const history = await store.history(id);
    expect(history.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(history.map((entry) => entry.content)).toEqual([
      "hello",
      "hi there",
      "result",
    ]);
  });

  describe("defaultTitleFromPrompt", () => {
    const store = newStore();

    it("uses the first non-empty line, trimmed and collapsed", () => {
      expect(store.defaultTitleFromPrompt("\n\n  Hello   world \nignored")).toBe(
        "Hello world",
      );
      expect(store.defaultTitleFromPrompt("  a\t b   c  ")).toBe("a b c");
    });

    it("truncates long prompts to 60 characters with an ellipsis", () => {
      const prompt = "a".repeat(100);
      const title = store.defaultTitleFromPrompt(prompt);
      expect(title).toBe(`${"a".repeat(59)}…`);
      expect(title.length).toBe(60);
    });

    it("falls back when there is no usable text", () => {
      expect(store.defaultTitleFromPrompt("")).toBe(DEFAULT_CONVERSATION_TITLE);
      expect(store.defaultTitleFromPrompt("   \n\t  ")).toBe(
        DEFAULT_CONVERSATION_TITLE,
      );
    });
  });

  it("renames a conversation and survives a new store instance", async () => {
    const store = newStore();
    const conversation = await store.create();
    const id = conversation.meta.conversation_id;

    const renamed = await store.rename(id, "  Renamed title  ");
    expect(renamed.title).toBe("Renamed title");

    const restarted = newStore();
    const loaded = await restarted.get(id);
    expect(loaded.meta.title).toBe("Renamed title");
    expect(loaded.meta.created_at).toBe(conversation.meta.created_at);
  });

  it("reconstructs message history after restart", async () => {
    const store = newStore();
    const conversation = await store.create();
    const id = conversation.meta.conversation_id;

    await store.appendMessage(id, message("user", "persisted?", systemClock.isoNow()));
    await store.appendMessage(
      id,
      message("assistant", "yes", systemClock.isoNow()),
    );

    const restarted = newStore();
    const history = await restarted.history(id);
    expect(history).toHaveLength(2);
    expect(history[0]?.content).toBe("persisted?");
    expect(history[1]?.content).toBe("yes");
  });

  it("list sorts by updated_at descending", async () => {
    const clock = createTestClock();
    const store = newStore(clock);

    const first = await store.create("first");
    clock.advance(1000);
    const second = await store.create("second");
    clock.advance(1000);
    const third = await store.create("third");

    clock.advance(1000);
    await store.appendMessage(
      second.meta.conversation_id,
      message("user", "bump second", clock.isoNow()),
    );

    const summaries = await store.list();
    expect(summaries.map((summary) => summary.conversation_id)).toEqual([
      second.meta.conversation_id,
      third.meta.conversation_id,
      first.meta.conversation_id,
    ]);
  });

  it("throws NOT_FOUND for a missing conversation", async () => {
    const store = newStore();
    await expect(store.get("cnv_00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(store.history("cnv_00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws INVALID_INPUT for an empty rename", async () => {
    const store = newStore();
    const conversation = await store.create();
    await expect(
      store.rename(conversation.meta.conversation_id, "   "),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("throws INVALID_INPUT for an invalid message role", async () => {
    const store = newStore();
    const conversation = await store.create();
    await expect(
      store.appendMessage(conversation.meta.conversation_id, {
        role: "bogus" as ConversationMessage["role"],
        content: "nope",
        created_at: systemClock.isoNow(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unsafe conversation IDs before reading or writing paths", async () => {
    const store = newStore();
    for (const id of ["../outside", "cnv_missing", "/tmp/outside", "cnv_../outside"]) {
      await expect(store.get(id)).rejects.toMatchObject({ code: "INVALID_ID" });
      await expect(store.rename(id, "changed")).rejects.toMatchObject({ code: "INVALID_ID" });
      await expect(store.appendMessage(id, message("user", "x", systemClock.isoNow())))
        .rejects.toMatchObject({ code: "INVALID_ID" });
    }
  });

  it.each(["append", "rename"])("recovers a partial crash tail before %s without losing history", async (operation) => {
    const store = newStore();
    const { meta } = await store.create("Research");
    const id = meta.conversation_id;
    await store.appendMessage(id, message("user", "before crash", systemClock.isoNow()));
    await appendFile(new FileSystemDataPaths(dir).sessionFile(id), '{"type":"message","content":"unfinished');
    const restarted = newStore();
    expect(await restarted.history(id)).toHaveLength(1);
    if (operation === "rename") await restarted.rename(id, "Recovered");
    else await restarted.appendMessage(id, message("assistant", "after crash", systemClock.isoNow()));
    await restarted.appendMessage(id, message("user", "continued", systemClock.isoNow()));
    const loaded = await newStore().get(id);
    expect(loaded.messages.map(entry => entry.content)).toEqual(
      operation === "rename" ? ["before crash", "continued"] : ["before crash", "after crash", "continued"],
    );
    if (operation === "rename") expect(loaded.meta.title).toBe("Recovered");
  });

  it("serializes concurrent appends without corruption", async () => {
    const store = newStore();
    const conversation = await store.create();
    const id = conversation.meta.conversation_id;
    const total = 50;

    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        store.appendMessage(
          id,
          message("user", `message-${index}`, systemClock.isoNow()),
        ),
      ),
    );

    const history = await store.history(id);
    expect(history).toHaveLength(total);
    expect(history.map((entry) => entry.content).sort()).toEqual(
      Array.from({ length: total }, (_, index) => `message-${index}`).sort(),
    );

    const raw = await readFile(
      new FileSystemDataPaths(dir).sessionFile(id),
      "utf8",
    );
    const dataLines = raw
      .split("\n")
      .filter((line) => line.trim() !== "");
    for (const line of dataLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(dataLines).toHaveLength(total + 1);
  });
});
