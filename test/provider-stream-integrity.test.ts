import { expect, it } from 'vitest';
import { OpenCodeGoProvider } from '../src/llm/opencode-go-provider.js';
import type { LlmEvent } from '../src/application/ports.js';

async function run(chunks: unknown[], broken = false): Promise<LlmEvent[]> {
  const encoder = new TextEncoder();
  const provider = new OpenCodeGoProvider({ apiKey: 'test-key', fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      if (broken) controller.error(new Error('secret test-key /private/provider-path'));
      else controller.close();
    },
  })) });
  const events: LlmEvent[] = [];
  for await (const event of provider.stream({ model: 'test', session_id: 'test', messages: [], tools: [] })) events.push(event);
  return events;
}
const fragment = (index: number, fn: object, id?: string) => ({ index, id, function: fn });
const delta = (tool_calls: object[]) => ({ choices: [{ delta: { tool_calls } }] });
it('assembles interleaved parallel tool calls by index before emitting them', async () => {
  const events = await run([
    delta([fragment(0, { name: 'get_paper', arguments: '{"paper_' }, 'a'), fragment(1, { name: 'read_note', arguments: '{"paper_' }, 'b')]),
    delta([fragment(0, { arguments: 'id":"one"}' }), fragment(1, { arguments: 'id":"two"}' })]),
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  expect(events).toEqual([
    { type: 'tool_call', call: { id: 'a', name: 'get_paper', arguments: '{"paper_id":"one"}' } },
    { type: 'tool_call', call: { id: 'b', name: 'read_note', arguments: '{"paper_id":"two"}' } },
    { type: 'done', finish_reason: 'tool_calls' },
  ]);
});
it('sanitizes response stream failures as a terminal provider error', async () => {
  const events = await run([], true);
  expect(events).toEqual([{ type: 'error', code: 'PROVIDER_FAILURE', message: 'The OpenCode Go response stream failed.' }]);
});
it('does not execute pending tool calls when the stream ends prematurely', async () => {
  const events = await run([delta([fragment(0, { name: 'import_paper', arguments: '{"upload_id":"upl_x"}' }, 'a')])]);
  expect(events).toEqual([{ type: 'error', code: 'PROVIDER_FAILURE', message: 'The OpenCode Go response ended before completion.' }]);
});
