import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, textBytes, type TestHarness } from "./helpers/harness.js";
import { AppError } from "../src/domain/errors.js";
import { DEFAULT_CONVERSATION_TITLE } from "../src/conversations/conversation-store.js";

let harness: TestHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe("regressions", () => {
  it("applies the deterministic first-prompt title to a default-titled Conversation", async () => {
    harness = await createTestHarness({
      llmScript: [{ text: "hello" }],
    });
    const created = await harness.conversations.create();
    expect(created.meta.title).toBe(DEFAULT_CONVERSATION_TITLE);

    for await (const _event of harness.agent.run({
      prompt: "Investigate sparse attention variants",
      conversation_id: created.meta.conversation_id,
    })) {
      void _event;
    }

    const resumed = await harness.conversations.get(created.meta.conversation_id);
    expect(resumed.meta.title).toBe("Investigate sparse attention variants");
  });

  it("does not overwrite an explicitly titled Conversation on its first message", async () => {
    harness = await createTestHarness({ llmScript: [{ text: "hello" }] });
    const created = await harness.conversations.create("My deliberate title");

    for await (const _event of harness.agent.run({
      prompt: "some other prompt",
      conversation_id: created.meta.conversation_id,
    })) {
      void _event;
    }

    const resumed = await harness.conversations.get(created.meta.conversation_id);
    expect(resumed.meta.title).toBe("My deliberate title");
  });

  it("rejects malformed creator patches without corrupting the Catalog", async () => {
    harness = await createTestHarness();
    const uploadId = await harness.stage(textBytes("pdf-bytes"), "paper.pdf");
    const imported = await harness.library.importPaper({ upload_id: uploadId });
    const paperId = imported.paper.paper_id;
    const revisionBefore = await harness.library.getCatalogRevision();

    await expect(
      harness.library.updatePaperMetadata(paperId, { creators: [123] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const catalog = await harness.catalog.load();
    expect(catalog.revision).toBe(revisionBefore);
    expect(catalog.papers[paperId]!.metadata.creators).toEqual([]);
  });

  it("rejects malformed imported metadata without publishing a Paper", async () => {
    harness = await createTestHarness();
    const uploadId = await harness.stage(textBytes("pdf-bytes"), "paper.pdf");
    let thrown: unknown;
    try {
      await harness.library.importPaper({
        upload_id: uploadId,
        metadata: { title: "T", creators: [{ creator_type: "author" }] as never },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("INVALID_INPUT");
    expect(await harness.library.listPapers()).toEqual([]);
  });
});
