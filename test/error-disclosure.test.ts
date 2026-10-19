import { expect, it } from 'vitest';
import { executeTool, type AgentToolContext } from '../src/agent/tools.js';
import { FileSystemCatalogStore } from '../src/infrastructure/fs/catalog-store.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemDataPaths } from '../src/infrastructure/fs/paths.js';
it('sanitizes unexpected tool errors before exposing them to the model or browser', async () => {
  const tool = { name: 'test', description: '', parameters: {}, handler: async () => { throw new Error('EACCES /private/secret-library api-key-value'); } };
  const result = await executeTool([tool], 'test', '{}', {} as AgentToolContext);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.toJSON()).toEqual({ error: { code: 'INTERNAL', message: 'Tool "test" failed unexpectedly.', details: { tool: 'test' } } });
});
it('does not include raw corrupt Catalog content in errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paper-harness-disclosure-'));
  try {
    const paths = new FileSystemDataPaths(root);
    const raw = 'private-api-key-contents';
    await writeFile(paths.catalogFile(), raw);
    const store = new FileSystemCatalogStore(paths);
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_CATALOG', details: {} });
  } finally { await rm(root, { recursive: true, force: true }); }
});
