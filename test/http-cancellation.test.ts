import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { compose, type Composition } from '../src/composition.js';
import { createWebServer, type WebServer } from '../src/web/server.js';
import type { LlmChatRequest, LlmEvent, LlmProvider } from '../src/application/ports.js';
let dir: string, composition: Composition, web: WebServer;
let cancelled = false, entered = false;
let release: () => void = () => {};
async function start() {
  dir = await mkdtemp(join(tmpdir(), 'paper-cancel-'));
  cancelled = false; entered = false;
  const provider: LlmProvider = { name: 'blocking', defaultModel: 'test', async *stream(req: LlmChatRequest): AsyncIterable<LlmEvent> {
    entered = true;
    yield { type: 'text', delta: 'started' };
    await new Promise<void>(resolve => {
      release = resolve;
      if (req.signal?.aborted) { cancelled = true; resolve(); }
      else req.signal?.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true });
    });
    yield { type: 'done', finish_reason: 'stop' };
  } };
  composition = await compose({ env: { PAPER_HARNESS_DATA_ROOT: dir, PAPER_HARNESS_PORT: '0', LLM_PROVIDER: 'fake' }, llm: provider });
  const s = composition.services;
  web = createWebServer({ config: s.config, paths: s.paths, uploads: s.uploads, library: s.library, notes: s.noteService, conversations: s.conversations, agent: s.agent, llmName: provider.name, llmModel: provider.defaultModel });
  return `http://127.0.0.1:${await web.listen()}`;
}
afterEach(async () => { release(); web.server.closeAllConnections(); if (web?.server.listening) await web.close(); if (composition) await composition.dispose(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('cancels the provider when the HTTP SSE consumer disconnects', async () => {
  const base = await start();
  const controller = new AbortController();
  const response = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'wait' }), signal: controller.signal });
  const reader = response.body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(cancelled).toBe(false);
  controller.abort();
  await vi.waitFor(() => expect(cancelled).toBe(true));
  await reader.cancel().catch(() => {});
});
it('removes partial files after an HTTP upload is interrupted', async () => {
  const base = await start();
  const req = request(`${base}/api/uploads`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-original-filename': 'interrupted.pdf', 'content-length': 10000 } });
  req.on('error', () => {});
  req.write(Buffer.from('%PDF partial'));
  await vi.waitFor(async () => expect((await readdir(composition.services.paths.uploadsDir())).some(name => name.endsWith('.part'))).toBe(true));
  req.destroy();
  await vi.waitFor(async () => expect(await readdir(composition.services.paths.uploadsDir())).toEqual([]));
});
