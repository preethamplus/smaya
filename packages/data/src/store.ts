// The Cosmos abstraction. Two implementations:
//   - InMemoryStore: a Map<container, Map<partitionKey, Map<id, item>>> used in tests / no-Docker mode
//   - CosmosStore: lazy-loaded against @azure/cosmos when SMAYA_COSMOS=1
//
// The orchestrator only sees the Store interface — same writes work either way.
// All writes are partitioned by tenantId; reads must always supply a tenantId
// (no cross-partition queries by design — that's a guardrail against tenant-bleed).

import { assertNoPII } from "@smaya/shared/pii";
import type { ContainerName } from "./containers.js";

export interface StoreItem {
  id: string;
  tenantId: string;
  [k: string]: unknown;
}

export interface QueryOptions {
  tenantId: string;
  filter?: (item: StoreItem) => boolean;
  limit?: number;
}

export interface Store {
  upsert(container: ContainerName, item: StoreItem, opts?: { skipPiiCheck?: boolean }): Promise<void>;
  get(container: ContainerName, tenantId: string, id: string): Promise<StoreItem | undefined>;
  query(container: ContainerName, opts: QueryOptions): Promise<StoreItem[]>;
  delete(container: ContainerName, tenantId: string, id: string): Promise<void>;
}

// ---- In-memory shim ------------------------------------------------------

export class InMemoryStore implements Store {
  // tenantId → container → id → item
  private byTenant = new Map<string, Map<string, Map<string, StoreItem>>>();

  private bucket(container: ContainerName, tenantId: string): Map<string, StoreItem> {
    let t = this.byTenant.get(tenantId);
    if (!t) {
      t = new Map();
      this.byTenant.set(tenantId, t);
    }
    let c = t.get(container);
    if (!c) {
      c = new Map();
      t.set(container, c);
    }
    return c;
  }

  async upsert(container: ContainerName, item: StoreItem, opts: { skipPiiCheck?: boolean } = {}): Promise<void> {
    if (!item.tenantId) throw new Error("tenantId required on every write (partition key invariant)");
    // PII assertion ONLY on `candidates` — that's the boundary where raw resume data
    // could leak. `decisionPacks` legitimately contains panel-member emails (those
    // are not candidate PII), so we don't gate it. The Mission also calls
    // assertNoPII directly on masked profiles before they reach here, so this is
    // defense in depth, not the primary guard.
    if (!opts.skipPiiCheck && container === "candidates") {
      assertNoPII(item);
    }
    this.bucket(container, item.tenantId).set(item.id, deepClone(item));
  }

  async get(container: ContainerName, tenantId: string, id: string): Promise<StoreItem | undefined> {
    const item = this.bucket(container, tenantId).get(id);
    return item ? deepClone(item) : undefined;
  }

  async query(container: ContainerName, opts: QueryOptions): Promise<StoreItem[]> {
    const all = [...this.bucket(container, opts.tenantId).values()];
    const filtered = opts.filter ? all.filter(opts.filter) : all;
    const limited = opts.limit ? filtered.slice(0, opts.limit) : filtered;
    return limited.map(deepClone);
  }

  async delete(container: ContainerName, tenantId: string, id: string): Promise<void> {
    this.bucket(container, tenantId).delete(id);
  }

  /** Diagnostic: snapshot of the entire store, for trace artifacts. */
  snapshot(): Record<string, Record<string, StoreItem[]>> {
    const out: Record<string, Record<string, StoreItem[]>> = {};
    for (const [tenant, byContainer] of this.byTenant) {
      out[tenant] = {};
      for (const [container, byId] of byContainer) {
        out[tenant][container] = [...byId.values()].map(deepClone);
      }
    }
    return out;
  }
}

// ---- Cosmos SDK adapter (lazy) ------------------------------------------

export class CosmosStore implements Store {
  private clientPromise: Promise<unknown> | null = null;

  async upsert(container: ContainerName, item: StoreItem, opts: { skipPiiCheck?: boolean } = {}): Promise<void> {
    if (!item.tenantId) throw new Error("tenantId required on every write");
    if (!opts.skipPiiCheck && container === "candidates") {
      assertNoPII(item);
    }
    const c = await this.containerHandle(container);
    await c.items.upsert(item, { partitionKey: item.tenantId });
  }

  async get(container: ContainerName, tenantId: string, id: string): Promise<StoreItem | undefined> {
    const c = await this.containerHandle(container);
    try {
      const { resource } = await c.item(id, tenantId).read();
      return resource as StoreItem | undefined;
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code === 404) return undefined;
      throw err;
    }
  }

  async query(container: ContainerName, opts: QueryOptions): Promise<StoreItem[]> {
    const c = await this.containerHandle(container);
    const iter = c.items.query(
      "SELECT * FROM c WHERE c.tenantId = @tenantId",
      { partitionKey: opts.tenantId, parameters: [{ name: "@tenantId", value: opts.tenantId }] }
    );
    const { resources } = await iter.fetchAll();
    let result = resources as StoreItem[];
    if (opts.filter) result = result.filter(opts.filter);
    if (opts.limit) result = result.slice(0, opts.limit);
    return result;
  }

  async delete(container: ContainerName, tenantId: string, id: string): Promise<void> {
    const c = await this.containerHandle(container);
    await c.item(id, tenantId).delete();
  }

  private async containerHandle(container: ContainerName): Promise<{
    items: {
      upsert: (item: StoreItem, opts: { partitionKey: string }) => Promise<unknown>;
      query: (q: string, opts: { partitionKey: string; parameters: Array<{ name: string; value: string }> }) => {
        fetchAll: () => Promise<{ resources: StoreItem[] }>;
      };
    };
    item: (id: string, pk: string) => {
      read: () => Promise<{ resource?: unknown }>;
      delete: () => Promise<unknown>;
    };
  }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = await import("@azure/cosmos").catch(() => null);
        if (!sdk) throw new Error("@azure/cosmos not installed; SMAYA_COSMOS=1 requires it");
        const endpoint = process.env.COSMOS_ENDPOINT ?? "https://localhost:8081";
        const key = process.env.COSMOS_KEY ?? "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";
        // @ts-expect-error CosmosClient is a class
        return new sdk.CosmosClient({ endpoint, key });
      })();
    }
    const client = (await this.clientPromise) as {
      database: (id: string) => {
        containers: { createIfNotExists: (def: { id: string; partitionKey: string }) => Promise<unknown> };
        container: (id: string) => unknown;
      };
      databases: { createIfNotExists: (def: { id: string }) => Promise<unknown> };
    };
    const dbName = process.env.COSMOS_DB ?? "smaya";
    await client.databases.createIfNotExists({ id: dbName });
    const db = client.database(dbName);
    await db.containers.createIfNotExists({ id: container, partitionKey: "/tenantId" });
    return db.container(container) as never;
  }
}

// ---- Factory --------------------------------------------------------------

let singleton: Store | null = null;
export function getStore(): Store {
  if (singleton) return singleton;
  if (process.env.SMAYA_COSMOS === "1") {
    singleton = new CosmosStore();
  } else {
    singleton = new InMemoryStore();
  }
  return singleton;
}

export function setStore(s: Store): void {
  singleton = s;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
