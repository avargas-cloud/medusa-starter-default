/**
 * Safe full-sync helper for MeiliSearch indexes.
 *
 * Replaces the destructive "deleteAllDocuments + re-upload" pattern that the
 * three sync workflows used (`sync-products`, `sync-customers`,
 * `sync-inventory`). That pattern leaves the index empty for 1–3 seconds
 * while the delete task completes and the upload tasks finish, which is
 * exactly the window where the admin `products-advanced` page throws
 * errors on a mass sync.
 *
 * Strategy:
 *   1. Upsert the current DB snapshot by primary key (Meili merges new
 *      revisions atomically per document).
 *   2. Fetch the set of ids that exist in Meili.
 *   3. Delete any ids present in Meili but not in the fresh DB snapshot —
 *      the "orphan cleanup" pass. This covers deletions that happened in
 *      the DB but never made it to the index via the lifecycle subscribers.
 *
 * Outcome: the index never has fewer documents than the DB snapshot at any
 * point during the sync. Searches return complete (if slightly stale)
 * results throughout.
 */

// MeiliSearch is a runtime dependency but ships as ESM. The workflows that
// use this helper import it via `await import("meilisearch")` and pass the
// live client into safeSyncIndex, so we only need the shape here. Using
// `any` avoids a build-level ESM/CJS resolution issue.
type MeiliSearch = any;

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

export interface SafeSyncOptions<T> {
  client: MeiliSearch;
  indexName: string;
  primaryKey: string;
  docs: T[];
  chunkSize?: number;
  logger?: Logger;
  /** Override settings update. If omitted, settings are not updated. */
  settings?: Record<string, unknown>;
  /** When true, skip the orphan cleanup pass (useful for incremental cases). */
  skipOrphanCleanup?: boolean;
}

export interface SafeSyncResult {
  upserted: number;
  orphansDeleted: number;
  totalInIndex: number;
  durationMs: number;
}

const DEFAULT_CHUNK = 1000;
const ID_FETCH_BATCH = 1000;

/**
 * Fetch every primary key currently in a Meili index. Uses the documents
 * endpoint with pagination. Returns a Set for O(1) diff lookups.
 */
async function fetchAllIds(
  client: MeiliSearch,
  indexName: string,
  primaryKey: string,
  logger?: Logger
): Promise<Set<string>> {
  const ids = new Set<string>();
  let offset = 0;

  for (;;) {
    try {
      const { results } = await client.index(indexName).getDocuments({
        fields: [primaryKey],
        limit: ID_FETCH_BATCH,
        offset,
      });
      if (!results || results.length === 0) break;
      for (const row of results as Array<Record<string, unknown>>) {
        const v = row[primaryKey];
        if (typeof v === "string") ids.add(v);
      }
      if (results.length < ID_FETCH_BATCH) break;
      offset += ID_FETCH_BATCH;
    } catch (err: any) {
      logger?.warn(
        `[safe-sync] fetchAllIds failed at offset=${offset}: ${err.message}`
      );
      break;
    }
  }
  return ids;
}

export async function safeSyncIndex<T extends Record<string, unknown>>(
  opts: SafeSyncOptions<T>
): Promise<SafeSyncResult> {
  const t0 = Date.now();
  const {
    client,
    indexName,
    primaryKey,
    docs,
    chunkSize = DEFAULT_CHUNK,
    logger,
    settings,
    skipOrphanCleanup,
  } = opts;
  const index = client.index(indexName);

  if (settings) {
    await index.updateSettings(settings as any);
  }

  // 1. Upsert in parallel chunks. addDocuments is upsert-by-primary-key.
  const chunks: T[][] = [];
  for (let i = 0; i < docs.length; i += chunkSize) {
    chunks.push(docs.slice(i, i + chunkSize));
  }
  logger?.info(
    `[safe-sync:${indexName}] upserting ${docs.length} docs in ${chunks.length} chunks`
  );
  const uploadTasks = await Promise.all(
    chunks.map((chunk) => index.addDocuments(chunk, { primaryKey }))
  );
  if (uploadTasks.length > 0) {
    await (client as any).tasks.waitForTasks(
      uploadTasks.map((t) => t.taskUid)
    );
  }
  logger?.info(
    `[safe-sync:${indexName}] upsert complete in ${Date.now() - t0}ms`
  );

  // 2. Orphan cleanup — find ids in Meili but not in the fresh DB snapshot.
  let orphansDeleted = 0;
  if (!skipOrphanCleanup) {
    const meiliIds = await fetchAllIds(client, indexName, primaryKey, logger);
    const dbIds = new Set<string>();
    for (const d of docs) {
      const v = d[primaryKey];
      if (typeof v === "string") dbIds.add(v);
    }
    const orphans: string[] = [];
    for (const id of meiliIds) if (!dbIds.has(id)) orphans.push(id);

    if (orphans.length > 0) {
      logger?.info(
        `[safe-sync:${indexName}] deleting ${orphans.length} orphan docs`
      );
      const task = await index.deleteDocuments(orphans);
      await (client as any).tasks.waitForTask(task.taskUid);
      orphansDeleted = orphans.length;
    } else {
      logger?.info(`[safe-sync:${indexName}] no orphans to delete`);
    }
  }

  // 3. Report.
  let totalInIndex = 0;
  try {
    const stats = await index.getStats();
    totalInIndex = stats.numberOfDocuments;
  } catch {
    /* ignore */
  }

  const durationMs = Date.now() - t0;
  logger?.info(
    `[safe-sync:${indexName}] done — upserted=${docs.length} orphansDeleted=${orphansDeleted} totalInIndex=${totalInIndex} durationMs=${durationMs}`
  );
  return {
    upserted: docs.length,
    orphansDeleted,
    totalInIndex,
    durationMs,
  };
}
