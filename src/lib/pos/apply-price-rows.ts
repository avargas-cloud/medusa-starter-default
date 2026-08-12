/**
 * Shared price/cost apply engine — extracted from `pos/prices/bulk/route.ts`
 * so the approve step of the price-change batch flow (`pos/price-batches/:id/approve`)
 * can reuse the EXACT same write semantics instead of re-implementing them.
 * No behavior change vs. the original inline logic in the bulk route.
 *
 * Split in three pieces so a caller that needs its OWN transaction (approve
 * flips the batch's status atomically in the SAME transaction as the writes)
 * can compose them instead of nesting transactions:
 *   - `applyPriceRowsInTransaction` — the DB-write core (price rows +
 *     variant metadata). Takes an ALREADY-OPEN connection (trx or plain
 *     knex) — it never opens its own transaction.
 *   - `runPriceRowsPostCommit` — MeiliSearch + QB enqueue, always AFTER
 *     commit (never inside the write transaction — same as v1).
 *   - `applyPriceRows` — the bulk route's shape: opens the transaction
 *     itself, runs the core, then runs post-commit. Unchanged behavior.
 */
import { roundCostDollarsOpt } from "../cost/avco";
import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";
import type { PinConn } from "./verify-supervisor-pin";
import { writeVariantPrices } from "./price-write";
import { enqueueBulkQbMod } from "../../api/admin/pos/prices/bulk/_lib/enqueue-bulk-qb-mod";
import { syncMeiliBulkPrices } from "../../api/admin/pos/prices/bulk/_lib/sync-meili-bulk";

interface LoggerLike {
  info: (m: string) => void;
  warn: (m: string) => void;
  error: (m: string) => void;
}

export interface ApplyPriceRow {
  variant_id: string;
  cost?: number;
  retail_price?: number;
  wholesale_price?: number;
}

export interface ApplyPriceVariant {
  id: string;
  sku: string | null;
  metadata: Record<string, unknown> | null;
  price_set: { id: string } | { id: string }[] | null;
}

export interface ApplyPriceRowResult {
  variant_id: string;
  sku: string | null;
  old: Record<string, number | null>;
  new: Record<string, number>;
  qb_enqueued: boolean;
}

export interface ApplyPriceRowsSkip {
  variant_id: string;
  sku: string | null;
  reason: string;
}

export interface MeiliBulkRow {
  variant_id: string;
  retail_price?: number;
  wholesale_price?: number;
  purchase_cost?: number;
}

export interface QbModCandidate {
  variant_id: string;
  sku: string | null;
  qb_id?: string;
  qb_edit_sequence?: string;
  new_cost: number;
}

export interface ApplyPriceRowsCoreResult {
  results: ApplyPriceRowResult[];
  skippedQb: ApplyPriceRowsSkip[];
  meiliRows: MeiliBulkRow[];
  qbCandidates: QbModCandidate[];
}

export interface ApplyPriceRowsResult {
  results: ApplyPriceRowResult[];
  skippedQb: ApplyPriceRowsSkip[];
}

const priceSetIdOf = (v: ApplyPriceVariant): string | undefined => {
  const raw = v.price_set;
  return Array.isArray(raw) ? raw[0]?.id : raw?.id;
};

/**
 * The DB-write core, with NO transaction boundary of its own — `trx` must
 * already be an open connection (a `knex.transaction` callback's `trx`, or
 * plain `knex` for a caller that doesn't need atomicity, e.g. tests).
 */
export async function applyPriceRowsInTransaction(
  trx: PinConn,
  logger: LoggerLike,
  variants: Map<string, ApplyPriceVariant>,
  rows: ApplyPriceRow[]
): Promise<ApplyPriceRowsCoreResult> {
  const results: ApplyPriceRowResult[] = [];
  const skippedQb: ApplyPriceRowsSkip[] = [];
  const meiliRows: MeiliBulkRow[] = [];
  const qbCandidates: QbModCandidate[] = [];

  for (const row of rows) {
    const variant = variants.get(row.variant_id)!;
    const meta = variant.metadata ?? {};
    const old: Record<string, number | null> = {};
    const newVals: Record<string, number> = {};

    if (row.retail_price !== undefined || row.wholesale_price !== undefined) {
      const priceSetId = priceSetIdOf(variant);
      if (!priceSetId) {
        throw new Error(
          `Variant ${row.variant_id} has no price set linked — cannot write prices`
        );
      }
      // Each side is passed AS-IS — undefined means "don't touch that row".
      // `writeVariantPrices` enforces wholesale ≤ retail against the
      // effective (passed or live) value of the side not touched here.
      const written = await writeVariantPrices(
        trx,
        logger,
        priceSetId,
        row.retail_price,
        row.wholesale_price
      );
      if (row.retail_price !== undefined) {
        old.retail_price = written.old_retail;
        newVals.retail_price = row.retail_price;
      }
      if (row.wholesale_price !== undefined) {
        old.wholesale_price = written.old_wholesale;
        newVals.wholesale_price = row.wholesale_price;
      }
    }

    let costChanged = false;
    if (row.cost !== undefined) {
      const roundedCost = roundCostDollarsOpt(row.cost) as number;
      const rawOld = meta.purchase_cost;
      const oldCost =
        typeof rawOld === "number"
          ? rawOld
          : typeof rawOld === "string" && rawOld.trim() !== ""
            ? Number(rawOld)
            : null;
      old.cost = Number.isFinite(oldCost as number) ? (oldCost as number) : null;
      newVals.cost = roundedCost;
      costChanged = old.cost !== roundedCost;

      // knex.raw uses `?` bindings — never `$1`. Value binds typed via
      // `::numeric` so jsonb_build_object stores a JSON NUMBER.
      await trx.raw(
        `UPDATE product_variant
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('purchase_cost', ?::numeric)
          WHERE id = ?`,
        [roundedCost, row.variant_id]
      );
    }

    results.push({
      variant_id: row.variant_id,
      sku: variant.sku,
      old,
      new: newVals,
      qb_enqueued: false, // patched by runPriceRowsPostCommit
    });

    if (row.retail_price !== undefined || row.wholesale_price !== undefined || row.cost !== undefined) {
      meiliRows.push({
        variant_id: row.variant_id,
        retail_price: newVals.retail_price,
        wholesale_price: newVals.wholesale_price,
        purchase_cost: newVals.cost,
      });
    }

    if (row.cost !== undefined && costChanged) {
      const qbId =
        typeof meta.quickbooks_id === "string" && meta.quickbooks_id.trim()
          ? meta.quickbooks_id
          : undefined;
      if (qbId) {
        qbCandidates.push({
          variant_id: row.variant_id,
          sku: variant.sku,
          qb_id: qbId,
          qb_edit_sequence:
            typeof meta.qb_edit_sequence === "string"
              ? meta.qb_edit_sequence
              : undefined,
          new_cost: roundCostDollarsOpt(row.cost) as number,
        });
      } else {
        skippedQb.push({
          variant_id: row.variant_id,
          sku: variant.sku,
          reason: "no quickbooks_id — never synced to QB, an ADD would be minted from a route that must never mint one",
        });
      }
    }
  }

  return { results, skippedQb, meiliRows, qbCandidates };
}

/**
 * Post-commit side effects: MeiliSearch (non-blocking) + QB mod enqueue.
 * Mutates `results[].qb_enqueued` in place for the rows that got enqueued.
 */
export async function runPriceRowsPostCommit(
  scope: { resolve: (k: string) => unknown },
  logger: LoggerLike,
  core: Pick<ApplyPriceRowsCoreResult, "results" | "meiliRows" | "qbCandidates">
): Promise<void> {
  const { results, meiliRows, qbCandidates } = core;

  await syncMeiliBulkPrices(scope, logger, meiliRows);

  if (qbCandidates.length > 0) {
    const catalog = scope.resolve(QUICKBOOKS_CATALOG_MODULE) as any;
    const enqueuedByVariant = new Set<string>();
    for (const c of qbCandidates) {
      try {
        await enqueueBulkQbMod(catalog, logger, {
          variant_id: c.variant_id,
          sku: c.sku ?? "",
          qb_id: c.qb_id!,
          qb_edit_sequence: c.qb_edit_sequence,
          new_cost: c.new_cost,
        });
        enqueuedByVariant.add(c.variant_id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(
          `[apply-price-rows] failed to enqueue QB mod for variant ${c.variant_id}: ${msg}`
        );
      }
    }
    for (const result of results) {
      if (enqueuedByVariant.has(result.variant_id)) result.qb_enqueued = true;
    }
  }
}

/**
 * Applies a set of already-validated price/cost rows: opens ITS OWN
 * transaction, runs the write core, then runs post-commit. This is the shape
 * the bulk route uses (it has no other write to fold into the same
 * transaction). `variants` must already contain every `row.variant_id`
 * (callers resolve + 404-check missing ids before calling this — same
 * ordering as the original bulk route).
 */
export async function applyPriceRows(input: {
  knex: PinConn & {
    transaction: <T>(fn: (trx: PinConn) => Promise<T>) => Promise<T>;
  };
  scope: { resolve: (k: string) => unknown };
  logger: LoggerLike;
  variants: Map<string, ApplyPriceVariant>;
  rows: ApplyPriceRow[];
}): Promise<ApplyPriceRowsResult> {
  const { knex, scope, logger, variants, rows } = input;

  let core: ApplyPriceRowsCoreResult | undefined;
  await knex.transaction(async (trx: PinConn) => {
    core = await applyPriceRowsInTransaction(trx, logger, variants, rows);
  });

  await runPriceRowsPostCommit(scope, logger, core!);

  return { results: core!.results, skippedQb: core!.skippedQb };
}
