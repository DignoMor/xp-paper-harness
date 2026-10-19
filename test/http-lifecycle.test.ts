import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readdir } from 'node:fs/promises';
import { createTestHarness, type TestHarness } from './helpers/harness.js';
import { createWebServer } from '../src/web/server.js';
import { PaperAgent } from '../src/agent/paper-agent.js';
import type { LlmChatRequest, LlmEvent, LlmProvider } from '../src/application/ports.js';
let h: TestHarness;
beforeEach(async () => { h = await createTestHarness(); });
afterEach(async () => { await h.cleanup(); });
// Drive Node's public request event without a TCP listener. The companion
// HTTP integration tests exercise real socket disconnects on unrestricted CI.
function exchange(path: string, headers: Record<string, string>, provider: LlmProvider = h.llm) {
  const req = Object.assign(new PassThrough(), { url: path, method: 'POST', headers });
  const res = Object.assign(new PassThrough(), { headersSent: false, statusCode: 200,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    setHeader() {}, flushHeaders() {},
  });
  const chunks: string[] = [];
  res.on('data', chunk => chunks.push(chunk.toString()));
  const agent = new PaperAgent({ provider, conversations: h.conversations, services: { library: h.library, notes: h.noteService, reading: h.reading, reconciliation: h.reconciliation } });
  const web = createWebServer({ config: h.config, paths: h.paths, uploads: h.uploads, library: h.library, notes: h.noteService, conversations: h.conversations, agent, llmName: provider.name, llmModel: provider.defaultModel });
  web.server.emit('request', req, res);
  return { req, res, chunks };
}
it('keeps a complete HTTP request running until its SSE response closes, then aborts the provider', async () => {
  let signal: AbortSignal | undefined;
  let release: () => void = () => {};
  const provider: LlmProvider = { name: 'blocking', defaultModel: 'test', async *stream(request: LlmChatRequest): AsyncIterable<LlmEvent> {
    signal = request.signal;
    yield { type: 'text', delta: 'started' };
    await new Promise<void>(resolve => {
      release = resolve;
      if (signal?.aborted) resolve();
      else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'done', finish_reason: 'stop' };
  } };
  const { req, res, chunks } = exchange('/api/messages', { 'content-type': 'application/json' }, provider);
  try {
    req.end(JSON.stringify({ prompt: 'wait' }));
    await vi.waitFor(() => expect(chunks.join('')).toContain('started'));
    expect(signal?.aborted).toBe(false);
    res.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  } finally { release(); res.destroy(); }
});
it('cleans staged partials when an HTTP request stream fails', async () => {
  const { req, res } = exchange('/api/uploads', { 'content-type': 'application/pdf', 'x-original-filename': 'interrupted.pdf' });
  req.write('partial PDF bytes');
  await vi.waitFor(async () => expect((await readdir(h.paths.uploadsDir())).some(name => name.endsWith('.part'))).toBe(true));
  req.destroy(new Error('interrupted'));
  await vi.waitFor(async () => expect(await readdir(h.paths.uploadsDir())).toEqual([]));
  res.destroy();
});
it('does not expose unexpected filesystem errors in HTTP responses', async () => {
  vi.spyOn(h.conversations, 'create').mockRejectedValueOnce(new Error('EACCES /private/secret-library api-key-value'));
  const { req, res, chunks } = exchange('/api/conversations', { 'content-type': 'application/json' });
  req.end('{}');
  await vi.waitFor(() => expect(res.writableEnded).toBe(true));
  expect(res.statusCode).toBe(500);
  expect(JSON.parse(chunks.join(''))).toEqual({ error: { code: 'INTERNAL', message: 'An unexpected error occurred.', details: {} } });
});
