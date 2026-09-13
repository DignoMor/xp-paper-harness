import { describe, expect, it } from "vitest";
import { APPROVED_TOOL_NAMES, assertApprovedToolNames } from "../src/agent/system-prompt.js";
import {
  createPaperTools,
  executeTool,
  type AgentToolContext,
} from "../src/agent/tools.js";

const FORBIDDEN_TOOL_NAMES = [
  "pdf_read",
  "read_file",
  "write_file",
  "fs_read",
  "fs_write",
  "shell",
  "exec",
  "bash",
  "web",
  "fetch",
  "browse",
  "mcp",
  "notebook",
] as const;

const FORBIDDEN_TOOL_PATTERN = /pdf_read|shell|exec|fs_|mcp|web|fetch/i;

function explodingContext(): AgentToolContext {
  return new Proxy({} as AgentToolContext, {
    get() {
      throw new Error("Tool context must not be accessed for an unknown tool.");
    },
  });
}

describe("Paper Agent tool inventory", () => {
  it("exposes exactly the approved tool names with no duplicates", () => {
    const tools = createPaperTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...APPROVED_TOOL_NAMES].sort());
  });

  it("does not include any forbidden tool by name or heuristic", () => {
    const names = createPaperTools().map((tool) => tool.name);

    for (const forbidden of FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(forbidden);
    }
    for (const name of names) {
      expect(FORBIDDEN_TOOL_PATTERN.test(name)).toBe(false);
    }
  });

  it("gives every tool a description and an object schema", () => {
    for (const tool of createPaperTools()) {
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTypeOf("object");
      expect(tool.parameters).not.toBeNull();
      expect((tool.parameters as { type?: unknown }).type).toBe("object");
    }
  });

  it("assertApprovedToolNames accepts the approved set and rejects unapproved names", () => {
    expect(() => assertApprovedToolNames([...APPROVED_TOOL_NAMES])).not.toThrow();
    expect(() => assertApprovedToolNames(["list_papers"])).not.toThrow();
    expect(() => assertApprovedToolNames(["shell"])).toThrow(/unapproved/i);
    expect(() => assertApprovedToolNames([...APPROVED_TOOL_NAMES, "fs_read"])).toThrow(
      /fs_read/,
    );
  });
});

describe("executeTool guardrails", () => {
  it("returns INVALID_INPUT for an unknown tool without touching the context", async () => {
    const outcome = await executeTool(
      createPaperTools(),
      "definitely_not_a_tool",
      "{}",
      explodingContext(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("INVALID_INPUT");
    expect(outcome.error.details.tool).toBe("definitely_not_a_tool");
  });

  it("returns INVALID_INPUT for malformed JSON arguments", async () => {
    const outcome = await executeTool(
      createPaperTools(),
      "list_papers",
      "{not valid json",
      {} as AgentToolContext,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error.code).toBe("INVALID_INPUT");
    expect(outcome.error.details.tool).toBe("list_papers");
  });

  it("does not execute the handler when the tool name is unknown", async () => {
    let invoked = false;
    const tools = createPaperTools().map((tool) =>
      tool.name === "list_papers"
        ? {
            ...tool,
            handler: async () => {
              invoked = true;
              return [];
            },
          }
        : tool,
    );

    const outcome = await executeTool(
      tools,
      "list_papers_typo",
      "{}",
      {} as AgentToolContext,
    );

    expect(outcome.ok).toBe(false);
    expect(invoked).toBe(false);
  });
});
