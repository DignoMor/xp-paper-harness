import { withFileLock } from "./lock.js";
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
import { isNotFound } from "./errors.js";

export class FileSystemCatalogStore implements CatalogStore {

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
      throw new AppError("CORRUPT_CATALOG", "The catalog is not valid JSON.");
    }
    return parseCatalog(parsed);
  }

  async save(catalog: Catalog): Promise<void> {
    await withFileLock(this.paths.catalogFile(), async () => {
      const current = await this.load();
      if (catalog.revision !== current.revision + 1) {
        throw new AppError("STALE_REVISION", "The catalog revision is stale; reload and retry.", {
          current_revision: current.revision, expected_revision: catalog.revision - 1,
        });
      }
      await atomicWriteFile(this.paths.catalogFile(), serializeCatalog(parseCatalog(catalog)));
    });
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
    return withFileLock(this.paths.catalogFile(), run);
  }
}


