import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';

// One backend writer is supported. Share queues across store instances in that
// process, and allow a transaction to call the same store's checked save.
const queues = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();
export function withFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const owned = held.getStore();
  if (owned?.has(key)) return operation();
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(() => held.run(new Set([...(owned ?? []), key]), operation));
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return result;
}
