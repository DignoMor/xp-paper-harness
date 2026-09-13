import { readFile } from "node:fs/promises";
import { AppError } from "../../domain/errors.js";
import {
  emptyCatalog,
  parseCatalog,
  serializeCatalog,
  type Catalog,
} from "../../domain/catalog.js";
import type { CatalogStore, DataPaths } from "../../application/ports.js";
import { atomicWriteFile } from "./atomic.js";

export class FileSystemCatalogStore implements CatalogStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: DataPaths) {}

  async exists(): Promise<boolean> {
    try {
      await readFile(this.paths.catalogFile(), "utf8");
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async readRaw(): Promise<string | null> {
    try {
      return await readFile(this.paths.catalogFile(), "utf8");
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async load(): Promise<Catalog> {
    const raw = await this.readRaw();
    if (raw === null) return emptyCatalog();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AppError("CORRUPT_CATALOG", "The catalog is not valid JSON.", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return parseCatalog(parsed);
  }

  async save(catalog: Catalog): Promise<void> {
    await atomicWriteFile(this.paths.catalogFile(), serializeCatalog(catalog));
  }

  transact<T>(
    mutator: (current: Catalog) => Promise<{ catalog: Catalog; result: T }> | { catalog: Catalog; result: T },
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.load();
      const { catalog: next, result } = await mutator(current);
      if (next.revision !== current.revision) {
        await this.save(next);
      }
      return result;
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}
