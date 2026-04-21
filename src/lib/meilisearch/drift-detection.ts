/**
 * Drift-detection helpers shared by the three "Check Sync" admin
 * endpoints (`/admin/search/{products,customers,inventory}/sync`).
 *
 * Before this helper each endpoint had its own ad-hoc algorithm:
 *   • products  — count + timestamp (5s tolerance)
 *   • customers — count + timestamp (2s tolerance), ignored force=true
 *   • inventory — count only, no timestamp, ignored drift
 *
 * Now all three share the same three axes:
 *   1. Count exact match.
 *   2. Latest `updated_at` within a configurable tolerance.
 *   3. Content drift sample: pick N random DB docs and verify their Meili
 *      counterpart by primary key has the expected "shape key" (usually
 *      a field like `variantId` or `email`). Detects silent mutations
 *      that leave count and timestamp unchanged (e.g. a manual document
 *      PATCH that wiped fields).
 *
 * When any axis fails, the caller should run the full sync workflow.
 */

type MeiliSearch = any;

interface Logger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export interface DriftCheckOptions<T extends { id: string }> {
  client: MeiliSearch;
  indexName: string;
  /** Fresh DB snapshot. */
  dbDocs: T[];
  /** Latest update ms across the DB snapshot. */
  dbLatestMs: number;
  /** Tolerance for the timestamp comparison. Defaults to 5 seconds. */
  toleranceMs?: number;
  /** Number of random DB docs to content-sample. Defaults to 10. Pass 0 to skip. */
  sampleSize?: number;
  /** Field(s) on each doc that must match between DB and Meili for the sample
   *  check to pass. Defaults to ['id']. */
  sampleFields?: (keyof T & string)[];
  /** If true, skip ALL checks and report drift — always used on force=true. */
  force?: boolean;
  logger?: Logger;
}

export interface DriftCheckResult {
  shouldSync: boolean;
  reason:
    | "force"
    | "count_mismatch"
    | "time_mismatch"
    | "content_drift"
    | "in_sync"
    | "error";
  dbCount: number;
  meiliCount: number;
  timeDiffMs: number;
  driftSampleSize: number;
  driftMismatches: number;
}

async function getMeiliCount(
  client: MeiliSearch,
  indexName: string,
  logger?: Logger
): Promise<number> {
  try {
    const stats = await client.index(indexName).getStats();
    return stats.numberOfDocuments ?? 0;
  } catch (err: any) {
    logger?.warn(
      `[drift-detection:${indexName}] getStats failed: ${err.message}`
    );
    return 0;
  }
}

async function getMeiliLatestMs(
  client: MeiliSearch,
  indexName: string,
  logger?: Logger
): Promise<number> {
  try {
    const result = await client.index(indexName).search("", {
      limit: 1,
      sort: ["updated_at:desc"],
      attributesToRetrieve: ["updated_at"],
    });
    const hit = result.hits?.[0];
    if (!hit) return 0;
    const raw = (hit as Record<string, unknown>).updated_at;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") return new Date(raw).getTime();
    return 0;
  } catch (err: any) {
    logger?.warn(
      `[drift-detection:${indexName}] latest timestamp fetch failed: ${err.message}`
    );
    return 0;
  }
}

async function sampleContentDrift<T extends { id: string }>(
  client: MeiliSearch,
  indexName: string,
  dbDocs: T[],
  sampleSize: number,
  sampleFields: (keyof T & string)[],
  logger?: Logger
): Promise<{ size: number; mismatches: number }> {
  if (sampleSize <= 0 || dbDocs.length === 0) {
    return { size: 0, mismatches: 0 };
  }
  const shuffled = [...dbDocs].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, Math.min(sampleSize, dbDocs.length));
  let mismatches = 0;

  const fetches = await Promise.all(
    sample.map(async (d) => {
      try {
        const doc = (await client
          .index(indexName)
          .getDocument(d.id, { fields: ["id", ...sampleFields] })) as Record<
          string,
          unknown
        >;
        return doc ?? null;
      } catch {
        return null;
      }
    })
  );

  for (let i = 0; i < sample.length; i++) {
    const meili = fetches[i];
    const dbDoc = sample[i]!;
    if (!meili) {
      mismatches++;
      continue;
    }
    for (const field of sampleFields) {
      const expected = dbDoc[field];
      const actual = (meili as Record<string, unknown>)[field as string];
      if (expected !== actual) {
        mismatches++;
        break;
      }
    }
  }

  logger?.info(
    `[drift-detection:${indexName}] content sample size=${sample.length} mismatches=${mismatches}`
  );
  return { size: sample.length, mismatches };
}

export async function detectDrift<T extends { id: string }>(
  opts: DriftCheckOptions<T>
): Promise<DriftCheckResult> {
  const {
    client,
    indexName,
    dbDocs,
    dbLatestMs,
    toleranceMs = 5000,
    sampleSize = 10,
    sampleFields = ["id"] as (keyof T & string)[],
    force,
    logger,
  } = opts;

  if (force) {
    return {
      shouldSync: true,
      reason: "force",
      dbCount: dbDocs.length,
      meiliCount: -1,
      timeDiffMs: 0,
      driftSampleSize: 0,
      driftMismatches: 0,
    };
  }

  try {
    const [meiliCount, meiliLatestMs] = await Promise.all([
      getMeiliCount(client, indexName, logger),
      getMeiliLatestMs(client, indexName, logger),
    ]);

    const dbCount = dbDocs.length;
    const countOk = dbCount === meiliCount;
    const timeDiffMs = Math.abs(dbLatestMs - meiliLatestMs);
    const timeOk = timeDiffMs <= toleranceMs;

    if (!countOk) {
      return {
        shouldSync: true,
        reason: "count_mismatch",
        dbCount,
        meiliCount,
        timeDiffMs,
        driftSampleSize: 0,
        driftMismatches: 0,
      };
    }
    if (!timeOk) {
      return {
        shouldSync: true,
        reason: "time_mismatch",
        dbCount,
        meiliCount,
        timeDiffMs,
        driftSampleSize: 0,
        driftMismatches: 0,
      };
    }

    const { size, mismatches } = await sampleContentDrift(
      client,
      indexName,
      dbDocs,
      sampleSize,
      sampleFields,
      logger
    );

    if (mismatches > 0) {
      return {
        shouldSync: true,
        reason: "content_drift",
        dbCount,
        meiliCount,
        timeDiffMs,
        driftSampleSize: size,
        driftMismatches: mismatches,
      };
    }

    return {
      shouldSync: false,
      reason: "in_sync",
      dbCount,
      meiliCount,
      timeDiffMs,
      driftSampleSize: size,
      driftMismatches: 0,
    };
  } catch (err: any) {
    logger?.warn(
      `[drift-detection:${indexName}] unexpected error: ${err.message}`
    );
    // Fail open — if drift detection itself crashes, trigger a sync to
    // self-heal rather than leave stale data.
    return {
      shouldSync: true,
      reason: "error",
      dbCount: dbDocs.length,
      meiliCount: -1,
      timeDiffMs: 0,
      driftSampleSize: 0,
      driftMismatches: 0,
    };
  }
}
