import { describe, expect, it } from 'vitest';
import { OpenCodeGoProvider } from '../src/llm/opencode-go-provider.js';
import { createPaperTools } from '../src/agent/tools.js';
import { uuidv7 } from '../src/domain/ids.js';
import type { LlmEvent, LlmMessage } from '../src/application/ports.js';
const apiKey = process.env.OPENCODE_GO_API_KEY;
const baseUrl = process.env.OPENCODE_GO_BASE_URL;
const model = process.env.OPENCODE_GO_MODEL ?? 'deepseek-v4.1-flash';
const sessionHeader = process.env.OPENCODE_GO_SESSION_HEADER ?? 'x-session-id';

describe.skipIf(!apiKey)('OpenCode Go real-provider smoke (credential-gated)', () => {
  it('streams text, calls a semantic tool, and preserves per-Conversation headers across tool turns', async () => {
    const headers: string[] = [];
    const provider = new OpenCodeGoProvider({ apiKey: apiKey!, baseUrl, model, sessionHeader,
      fetchImpl: async (input, init) => {
        headers.push(new Headers(init?.headers).get(sessionHeader)!);
        return fetch(input, init);
      },
    });
    const tool = createPaperTools().find(tool => tool.name === 'list_papers')!;
    const tools = [{ name: tool.name, description: tool.description, parameters: tool.parameters }];
    const session = `cnv_${uuidv7()}`;
    const messages: LlmMessage[] = [
      { role: 'system', content: 'First call list_papers with empty arguments. After receiving its result, reply with the word pong. Do not invent Library content.' },
      { role: 'user', content: 'List my Papers using the list_papers tool now.' },
    ];
    const collect = async (id: string, history: LlmMessage[], specs = tools) => {
      const events: LlmEvent[] = [];
      for await (const event of provider.stream({ model, session_id: id, messages: history, tools: specs })) events.push(event);
      expect(events.find(event => event.type === 'error')).toBeUndefined();
      expect(events.at(-1)?.type).toBe('done');
      return events;
    };
    const first = await collect(session, messages);
    const callEvent = first.find((event): event is Extract<LlmEvent, { type: 'tool_call' }> => event.type === 'tool_call');
    expect(callEvent?.call.name).toBe('list_papers');
    const call = callEvent!.call;
    expect(JSON.parse(call.arguments)).toEqual({});
    expect(call.id).not.toBe('');
    const second = await collect(session, [...messages,
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', name: call.name, tool_call_id: call.id, content: '[]' },
    ]);
    expect(second.filter(event => event.type === 'text').map(event => event.delta).join('').trim().length).toBeGreaterThan(0);
    const other = `cnv_${uuidv7()}`;
    await collect(other, [{ role: 'user', content: 'Reply pong.' }], []);
    expect(headers).toEqual([session, session, other]);
  }, 180_000);
});
