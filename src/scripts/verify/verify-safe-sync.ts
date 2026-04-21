/**
 * verify-safe-sync.ts
 *
 * F2 verification. Exercises `safeSyncIndex` against a mock MeiliSearch
 * client to prove:
 *
 *   1. Index never goes empty during sync (unlike the old delete-all path).
 *   2. Orphan docs (present in Meili but not in DB snapshot) are cleaned up.
 *   3. Shared docs are upserted, not replaced then re-created.
 *   4. Settings update happens before upsert.
 *   5. Chunking respects the configured chunkSize.
 *   6. No destructive `deleteAllDocuments` is ever called.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/verify/verify-safe-sync.ts
 */

import { safeSyncIndex } from "../../lib/meilisearch/safe-sync";

interface Call {
  method: string;
  payload?: unknown;
  ts: number;
}

function makeClient(opts: { initialIds: string[]; pageSize?: number }) {
  const calls: Call[] = [];
  const store = new Map<string, Record<string, unknown>>();
  for (const id of opts.initialIds) store.set(id, { id, initial: true });

  let taskCounter = 0;
  const tasks = new Map<number, { status: string }>();

  const newTask = () => {
    taskCounter += 1;
    tasks.set(taskCounter, { status: "succeeded" });
    return { taskUid: taskCounter };
  };

  const pageSize = opts.pageSize ?? 1000;

  const index = (_name: string) => ({
    async updateSettings(settings: unknown) {
      calls.push({ method: "updateSettings", payload: settings, ts: Date.now() });
      return newTask();
    },
    async addDocuments(
      docs: Array<Record<string, unknown>>,
      _opts: { primaryKey: string }
    ) {
      calls.push({
        method: "addDocuments",
        payload: { count: docs.length, ids: docs.map((d) => d.id) },
        ts: Date.now(),
      });
      // Atomic upsert per primary key. Index size only GROWS or stays
      // equal after upsert, never shrinks.
      for (const d of docs) {
        const id = d.id as string;
        store.set(id, { ...d });
      }
      return newTask();
    },
    async getDocuments(args: { fields?: string[]; limit: number; offset: number }) {
      calls.push({ method: "getDocuments", payload: args, ts: Date.now() });
      const all = Array.from(store.values());
      const page = all.slice(args.offset, args.offset + args.limit);
      return {
        results: page.map((d) => ({ id: d.id })),
        total: all.length,
        offset: args.offset,
        limit: args.limit,
      };
    },
    async deleteDocuments(ids: string[]) {
      calls.push({ method: "deleteDocuments", payload: { ids }, ts: Date.now() });
      for (const id of ids) store.delete(id);
      return newTask();
    },
    async deleteAllDocuments() {
      calls.push({ method: "deleteAllDocuments", ts: Date.now() });
      store.clear();
      return newTask();
    },
    async getStats() {
      return { numberOfDocuments: store.size };
    },
  });

  return {
    client: {
      index,
      tasks: {
        waitForTasks: async (_uids: number[]) => {},
        waitForTask: async (_uid: number) => {},
      },
    } as any,
    calls,
    store,
    pageSize,
  };
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const checks: Check[] = [];
function add(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
}

async function main() {
  // ── Scenario A: full sync with overlap + orphans + new ─────────────────
  // Meili currently has: [1, 2, 3]
  // DB snapshot:         [2, 3, 4, 5]
  //   • 1 is orphan → should be deleted
  //   • 2, 3 are shared → should be upserted
  //   • 4, 5 are new → should be added
  {
    const harness = makeClient({ initialIds: ["1", "2", "3"] });
    const docs = [
      { id: "2", name: "two" },
      { id: "3", name: "three" },
      { id: "4", name: "four" },
      { id: "5", name: "five" },
    ];
    const res = await safeSyncIndex({
      client: harness.client,
      indexName: "test",
      primaryKey: "id",
      docs,
    });
    const finalIds = [...harness.store.keys()].sort();

    add(
      "A — no deleteAllDocuments was ever called",
      !harness.calls.some((c) => c.method === "deleteAllDocuments")
    );
    add(
      "A — final index contains exactly DB snapshot",
      JSON.stringify(finalIds) === JSON.stringify(["2", "3", "4", "5"])
    );
    add("A — result.upserted === 4", res.upserted === 4);
    add("A — result.orphansDeleted === 1", res.orphansDeleted === 1);
    add(
      "A — orphan delete happened AFTER upsert (no empty window)",
      (() => {
        const upsert = harness.calls.find((c) => c.method === "addDocuments")!;
        const del = harness.calls.find((c) => c.method === "deleteDocuments")!;
        return !!upsert && !!del && del.ts >= upsert.ts;
      })()
    );
  }

  // ── Scenario B: no orphans (DB is superset) ─────────────────────────────
  {
    const harness = makeClient({ initialIds: ["1", "2"] });
    const docs = [
      { id: "1", v: 1 },
      { id: "2", v: 2 },
      { id: "3", v: 3 },
    ];
    const res = await safeSyncIndex({
      client: harness.client,
      indexName: "test",
      primaryKey: "id",
      docs,
    });
    add(
      "B — no orphan delete call when there are no orphans",
      !harness.calls.some((c) => c.method === "deleteDocuments") &&
        res.orphansDeleted === 0
    );
  }

  // ── Scenario C: settings are applied BEFORE upsert ─────────────────────
  {
    const harness = makeClient({ initialIds: [] });
    await safeSyncIndex({
      client: harness.client,
      indexName: "test",
      primaryKey: "id",
      docs: [{ id: "x" }],
      settings: { filterableAttributes: ["sku"] },
    });
    const settingsIdx = harness.calls.findIndex(
      (c) => c.method === "updateSettings"
    );
    const upsertIdx = harness.calls.findIndex((c) => c.method === "addDocuments");
    add(
      "C — settings applied before the first addDocuments",
      settingsIdx !== -1 && upsertIdx !== -1 && settingsIdx < upsertIdx
    );
  }

  // ── Scenario D: chunkSize is respected ─────────────────────────────────
  {
    const harness = makeClient({ initialIds: [] });
    const docs = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
    await safeSyncIndex({
      client: harness.client,
      indexName: "test",
      primaryKey: "id",
      docs,
      chunkSize: 100,
    });
    const upsertCalls = harness.calls.filter((c) => c.method === "addDocuments");
    // 250 docs / 100 per chunk = 3 chunks.
    add(
      "D — docs split into 3 chunks when chunkSize=100 and total=250",
      upsertCalls.length === 3
    );
    const sizes = upsertCalls.map(
      (c) => (c.payload as { count: number }).count
    );
    add(
      "D — chunk sizes are [100, 100, 50]",
      JSON.stringify(sizes) === JSON.stringify([100, 100, 50])
    );
  }

  // ── Scenario E: skipOrphanCleanup flag ─────────────────────────────────
  {
    const harness = makeClient({ initialIds: ["a", "b", "c"] });
    const docs = [{ id: "a" }];
    await safeSyncIndex({
      client: harness.client,
      indexName: "test",
      primaryKey: "id",
      docs,
      skipOrphanCleanup: true,
    });
    add(
      "E — skipOrphanCleanup prevents deleteDocuments call",
      !harness.calls.some((c) => c.method === "deleteDocuments")
    );
    const finalIds = [...harness.store.keys()].sort();
    add(
      "E — existing docs remain untouched when skipOrphanCleanup=true",
      JSON.stringify(finalIds) === JSON.stringify(["a", "b", "c"])
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────
  console.log("━".repeat(60));
  console.log("  F2 Safe Sync Helper — verification");
  console.log("━".repeat(60));
  let failed = 0;
  for (const c of checks) {
    const glyph = c.pass ? "✅" : "❌";
    console.log(`${glyph}  ${c.name}`);
    if (!c.pass && c.detail) console.log(`    ${c.detail}`);
    if (!c.pass) failed++;
  }
  console.log("━".repeat(60));
  if (failed === 0) {
    console.log(`✅ ALL ${checks.length} CHECKS PASSED`);
    process.exit(0);
  }
  console.log(`❌ ${failed} / ${checks.length} CHECKS FAILED`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
