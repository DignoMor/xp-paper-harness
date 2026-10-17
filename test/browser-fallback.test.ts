import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { beforeAll, expect, it, vi } from 'vitest';
let script = '';
beforeAll(async () => { script = (await build({ entryPoints: ['src/web/client/app.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' })).outputFiles[0]!.text; });
// Execute the actual browser bundle at its HTTP/storage boundary with a minimal
// DOM. No selection helpers or implementation details are exported for tests.
class Element {
  children: Element[] = []; dataset = {}; textContent = ''; value = ''; scrollTop = 0; scrollHeight = 0;
  classList = { add() {}, remove() {}, toggle() {} };
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  addEventListener() {} focus() {}
}
async function boot(stored: string | null, ids: string[], missing: string[] = [], storageFails = false) {
  const elements = new Map<string, Element>();
  const calls: string[] = [];
  const storage = new Map(stored ? [['paper-harness.lastConversationId', stored]] : []);
  const localStorage = {
    getItem(key: string) { if (storageFails) throw Error('disabled'); return storage.get(key) ?? null; },
    setItem(key: string, value: string) { if (storageFails) throw Error('disabled'); storage.set(key, value); },
    removeItem(key: string) { if (storageFails) throw Error('disabled'); storage.delete(key); },
  };
  const meta = (id: string) => ({ conversation_id: id, title: id, message_count: 0 });
  const fetch = async (path: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    let body: unknown = {};
    let status = 200;
    if (path === '/api/config') body = { provider: 'fake', model: 'test', provider_disclosure: 'disclosure' };
    else if (path === '/api/papers') body = [];
    else if (path === '/api/conversations') body = init?.method === 'POST' ? meta('created') : ids.map(meta);
    else if (path.startsWith('/api/conversations/')) {
      const id = path.split('/').at(-1)!;
      if (missing.includes(id)) { body = { error: { code: 'NOT_FOUND', message: 'gone' } }; status = 404; }
      else body = { meta: meta(id), messages: [{ role: 'assistant', content: `history of ${id}` }] };
    } else throw Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(body), { status });
  };
  runInNewContext(script, { document: { getElementById(id: string) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement() { return new Element(); } }, window: { localStorage }, fetch, Response, console });
  await vi.waitFor(() => {
    const transcript = elements.get('transcript')!;
    expect(transcript.children.length > 0 || calls.includes('POST /api/conversations')).toBe(true);
  });
  return { calls, storage, elements };
}
it('restores a stored Conversation and its history', async () => {
  const result = await boot('chosen', ['latest', 'chosen']);
  expect(result.calls).toContain('GET /api/conversations/chosen');
  expect(result.calls).not.toContain('POST /api/conversations');
  expect(result.storage.get('paper-harness.lastConversationId')).toBe('chosen');
});
it('falls back from a stale stored selection to the first Conversation', async () => {
  const result = await boot('gone', ['latest']);
  expect(result.calls).toContain('GET /api/conversations/latest');
  expect(result.storage.get('paper-harness.lastConversationId')).toBe('latest');
});
it('falls back when a listed Conversation disappears before loading', async () => {
  const result = await boot('gone', ['gone', 'latest'], ['gone']);
  expect(result.calls).toContain('GET /api/conversations/latest');
  expect(result.storage.get('paper-harness.lastConversationId')).toBe('latest');
});
it('creates a Conversation when no selection survives', async () => {
  const result = await boot('gone', []);
  expect(result.calls).toContain('POST /api/conversations');
  expect(result.storage.get('paper-harness.lastConversationId')).toBe('created');
});
it('loads a Conversation when browser storage is disabled', async () => {
  expect((await boot(null, ['latest'], [], true)).calls).toContain('GET /api/conversations/latest');
});
