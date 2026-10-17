// Deterministic OpenAI-wire fixture for container acceptance; no cloud access.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export function reply(request) {
  const last = request.messages.at(-1);
  const tool = (name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id: `fixture-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
  const text = content => ({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
  if (last?.role === 'tool') {
    if (last.name === 'read_note') {
      const note = JSON.parse(last.content);
      return tool('edit_note', { paper_id: note.paper_id, mode: 'append', content: 'Container acceptance note.', expected_revision: note.revision });
    }
    return text('Acceptance operation completed.');
  }
  const prompt = last?.content ?? '';
  const upload = /upload_id=(upl_[a-z0-9-]+)/.exec(prompt)?.[1];
  const paper = /ppr_[a-z0-9-]+/.exec(prompt)?.[0];
  if (prompt.startsWith('import')) return tool('import_paper', { upload_id: upload });
  if (prompt.startsWith('read')) return tool('read_paper', { paper_id: paper });
  if (prompt.startsWith('note')) return tool('read_note', { paper_id: paper });
  return text('pong');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    // Fail closed if the application omits its stable Conversation header.
    if (!/^cnv_/.test(req.headers['x-session-id'] ?? '')) {
      res.writeHead(400); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(reply(request))}\n\ndata: [DONE]\n\n`);
  });
  server.listen(9999, '0.0.0.0');
}
