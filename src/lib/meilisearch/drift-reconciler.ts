/**
 * MeiliSearch reconciliation framework.
 *
 * Why this exists: ~68 direct SQL UPDATE statements across this codebase
 * write to entities that should live in MeiliSearch but bypass the Medusa
 * event bus — so the subscriber never fires and the index goes stale.
 * The reconciliation cron (src/jobs/meilisearch-reconciliation-cron.ts)
 * uses this framework to compare DB ↔ Meili every 5 minutes, repair drift,
 * and log each repair to `meilisearch_drift_log` for audit.
 *
 * To add a new entity type:
 *   1. Implement the EntityReconciler interface for it.
 *   2. Register it in the cron's `RECONCILERS` array.
 *   3. Ship.
 *
 * No code changes to the existing write paths are required — that is the
 * entire point of this approach.
 */
import postgres from "postgres";
import type { MedusaContainer } from "@medusajs/framework/types";
import { generateEntityId } from "@medusajs/utils";

export interface EntityReconciler {
  /** Stable name written to drift_log (e.g. "customer", "product"). */
  entityType: string;
  /** MeiliSearch index name. */
  meiliIndex: string;
  /** Fields to compare DB↔Meili for drift detection. */
  comparableFields: string[];
  /**
   * Build the canonical Meili document from the DB id. Same function the
   * subscriber would call. We compare its output against what Meili currently
   * holds — any mismatch in `comparableFields` is drift.
   */
  buildExpectedDoc(
    id: string,
    container: MedusaContainer
  ): Promise<Record<string, unknown> | null>;
  /** Re-sync the entity to MeiliSearch (the fix). */
  syncOne(id: string, container: MedusaContainer): Promise<void>;
  /** Query DB for ids whose `updated_at > since`. Returns ids only. */
  fetchUpdatedIdsSince(
    sql: postgres.Sql,
    sinceIso: string,
    limit: number
  ): Promise<string[]>;
}

export interface ReconcilerStats {
  entityType: string;
  checked: number;
  drifted: number;
  fixed: number;
  fix_errors: number;
  durationMs: number;
}

/**
 * For one entity type: walk recently-updated rows, compare against Meili,
 * log + fix drift, return per-entity stats.
 */
export async function reconcileEntity(
  reconciler: EntityReconciler,
  sql: postgres.Sql,
  container: MedusaContainer,
  opts: {
    /** ISO timestamp — anything updated after this is in scope. */
    sinceIso: string;
    /** Max rows to check in one cron pass. Safety cap. */
    maxRows: number;
    /** When true, skip writing fixes and drift_log (debug). */
    dryRun: boolean;
    logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  }
): Promise<ReconcilerStats> {
  const t0 = Date.now();
  const stats: ReconcilerStats = {
    entityType: reconciler.entityType,
    checked: 0,
    drifted: 0,
    fixed: 0,
    fix_errors: 0,
    durationMs: 0,
  };

  const ids = await reconciler.fetchUpdatedIdsSince(sql, opts.sinceIso, opts.maxRows);
  if (ids.length === 0) {
    stats.durationMs = Date.now() - t0;
    return stats;
  }

  // MeiliSearch SDK is ESM-only; CommonJS require would crash at module
  // load. Dynamic import keeps it lazy and ESM-compatible.
  const { MeiliSearch } = await import("meilisearch");
  const meili = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
  const index = meili.index(reconciler.meiliIndex);

  for (const id of ids) {
    stats.checked++;

    const expected = await reconciler.buildExpectedDoc(id, container).catch(() => null);
    if (!expected) continue;

    let actual: Record<string, unknown> | null;
    try {
      actual = (await index.getDocument(id)) as Record<string, unknown>;
    } catch (err: unknown) {
      // 404 = doc missing from Meili (drift: should exist, doesn't)
      const status = (err as { httpStatus?: number }).httpStatus;
      if (status === 404) {
        actual = null;
      } else {
        opts.logger.warn(
          `[meili-reconcile] ${reconciler.entityType}:${id} Meili read failed: ${(err as Error).message}`
        );
        continue;
      }
    }

    const drifts = diffFields(expected, actual, reconciler.comparableFields);
    if (drifts.length === 0) continue;

    stats.drifted++;

    if (!opts.dryRun) {
      const driftRows = drifts.map((d) => ({
        id: generateEntityId("", "msdl"),
        entity_type: reconciler.entityType,
        entity_id: id,
        field_name: d.field,
        db_value: stringifyVal(d.dbValue),
        meili_value: stringifyVal(d.meiliValue),
      }));
      try {
        await sql`
          INSERT INTO meilisearch_drift_log
            (id, entity_type, entity_id, field_name, db_value, meili_value)
          SELECT id, entity_type, entity_id, field_name, db_value, meili_value
          FROM ${sql(driftRows)}
        `;
      } catch (err: unknown) {
        opts.logger.warn(
          `[meili-reconcile] drift_log insert failed: ${(err as Error).message}`
        );
      }
    }

    try {
      if (!opts.dryRun) {
        await reconciler.syncOne(id, container);
        await sql`
          UPDATE meilisearch_drift_log
          SET fixed_at = NOW()
          WHERE entity_type = ${reconciler.entityType}
            AND entity_id = ${id}
            AND fixed_at IS NULL
        `;
      }
      stats.fixed++;
      opts.logger.info(
        `[meili-reconcile] ${reconciler.entityType}:${id} fixed — drifted on: ${drifts
          .map((d) => d.field)
          .join(", ")}`
      );
    } catch (err: unknown) {
      stats.fix_errors++;
      const msg = (err as Error).message;
      opts.logger.error(
        `[meili-reconcile] ${reconciler.entityType}:${id} fix failed: ${msg}`
      );
      if (!opts.dryRun) {
        await sql`
          UPDATE meilisearch_drift_log
          SET fix_error = ${msg}
          WHERE entity_type = ${reconciler.entityType}
            AND entity_id = ${id}
            AND fixed_at IS NULL
        `.catch(() => {});
      }
    }
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}

interface FieldDiff {
  field: string;
  dbValue: unknown;
  meiliValue: unknown;
}

function diffFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown> | null,
  fields: string[]
): FieldDiff[] {
  if (!actual) {
    // Whole doc is missing — flag the primary signature field for the log.
    const field = fields[0] ?? "(doc)";
    return [{ field, dbValue: expected[field], meiliValue: null }];
  }
  const out: FieldDiff[] = [];
  for (const f of fields) {
    if (!valuesEqual(expected[f], actual[f])) {
      out.push({ field: f, dbValue: expected[f], meiliValue: actual[f] });
    }
  }
  return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  // Normalize null/undefined/empty-string as equivalent — Meili and Medusa
  // serialize "missing" differently and we don't want to flag those as drift.
  const norm = (v: unknown) => (v === null || v === undefined || v === "" ? null : v);
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (Array.isArray(na) && Array.isArray(nb)) {
    if (na.length !== nb.length) return false;
    const sa = [...na].sort();
    const sb = [...nb].sort();
    return sa.every((v, i) => v === sb[i]);
  }
  return false;
}

function stringifyVal(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
