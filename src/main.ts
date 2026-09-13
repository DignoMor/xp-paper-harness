import { ensureDir } from "./infrastructure/fs/atomic.js";
import { compose } from "./composition.js";
import { loadConfig } from "./config.js";
import { createWebServer } from "./web/server.js";

export async function startApplication(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  const composition = await compose({ env, config });
  const { paths, uploads, agent, library, noteService, conversations, llm } = composition.services;

  for (const dir of [
    paths.root,
    paths.papersDir(),
    paths.notesDir(),
    paths.sessionsDir(),
    paths.uploadsDir(),
    paths.tmpDir(),
  ]) {
    await ensureDir(dir);
  }
  const purged = await uploads.purgeExpired(config.upload.ttlMs);
  if (purged > 0) {
    process.stdout.write(`Purged ${purged} expired upload(s).\n`);
  }

  const web = createWebServer({
    config,
    paths,
    uploads,
    library,
    notes: noteService,
    conversations,
    agent,
    llmName: llm.name,
    llmModel: llm.defaultModel,
  });
  const port = await web.listen();
  process.stdout.write(
    [
      `Paper Harness listening on http://127.0.0.1:${port}`,
      `Data root: ${config.dataRoot}`,
      `LLM provider: ${llm.name} (model ${llm.defaultModel})`,
      "Relevant Paper content and Paper Notes may be sent to the configured LLM provider.",
      "Loopback access only; do not expose this unauthenticated service remotely.",
      "",
    ].join("\n"),
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nReceived ${signal}; shutting down.\n`);
    await web.close();
    await composition.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isEntrypoint) {
  startApplication().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
