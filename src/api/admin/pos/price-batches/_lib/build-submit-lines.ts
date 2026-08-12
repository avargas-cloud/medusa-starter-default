/**
 * src/api/admin/pos/price-batches/_lib/build-submit-lines.ts
 *
 * Shared submit logic: given STRICT-shape rows (already passed through
 * `validateBulkRows`), load the live variant snapshot, enforce the
 * wholesale<=retail invariant against the live side (single-sided changes
 * check against whatever's live for the untouched side), and build the
 * final old/new line records — dropping any field that's a no-op against
 * what's live right now.
 *
 * Shared by POST / (direct submit) and POST /:id/submit (draft -> submitted)
 * so the two paths can never diverge on what counts as an effective change.
 * Read-only — never writes. The caller decides what to do with the result
 * inside its own transaction.
 */
import { roundCostDollarsOpt } from "../../../../../lib/cost/avco";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import type {
  BulkPriceRow,
  BulkRowError,
} from "../../prices/bulk/_lib/validate-bulk-rows";
import { loadLiveVariantSnapshots } from "./live-variant-snapshot";

export interface SubmitLinesResult {
  linesToCreate: Record<string, unknown>[];
  droppedNoopRows: number;
}

export type SubmitLinesOutcome =
  | { ok: true; result: SubmitLinesResult }
  | { ok: false; status: number; body: unknown };

export async function buildSubmitLines(
  query: { graph: (args: unknown) => Promise<{ data: unknown[] }> },
  knex: PinConn,
  rows: BulkPriceRow[]
): Promise<SubmitLinesOutcome> {
  const variantIds = Array.from(new Set(rows.map((r) => r.variant_id)));
  const snapshots = await loadLiveVariantSnapshots(query, knex, variantIds);

  const missing = variantIds.filter((id) => !snapshots.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      body: { error: `Variant(s) not found: ${missing.join(", ")}` },
    };
  }

  // ── wholesale ≤ retail, checked against the LIVE side when only one of
  // the pair is provided — a single-sided change can't violate the
  // invariant against itself. Aggregate ALL rows' violations (same pattern
  // as validateBulkRows) so submit either creates nothing or the full set.
  const invariantErrors: BulkRowError[] = [];
  rows.forEach((row, index) => {
    const live = snapshots.get(row.variant_id)!;
    const effectiveRetail =
      row.retail_price !== undefined ? row.retail_price : live.current_retail;
    const effectiveWholesale =
      row.wholesale_price !== undefined
        ? row.wholesale_price
        : live.current_wholesale;
    if (
      effectiveRetail !== null &&
      effectiveWholesale !== null &&
      effectiveWholesale > effectiveRetail
    ) {
      invariantErrors.push({
        index,
        variant_id: row.variant_id,
        message: `wholesale_price ($${effectiveWholesale}) cannot exceed retail_price ($${effectiveRetail})`,
      });
    }
  });
  if (invariantErrors.length > 0) {
    return { ok: false, status: 400, body: { errors: invariantErrors } };
  }

  let droppedNoopRows = 0;
  const linesToCreate: Record<string, unknown>[] = [];

  for (const row of rows) {
    const live = snapshots.get(row.variant_id)!;
    const line: Record<string, unknown> = {
      variant_id: row.variant_id,
      product_id: row.product_id,
      sku: live.sku,
      description: live.description,
      old_cost: null,
      new_cost: null,
      old_retail: null,
      new_retail: null,
      old_wholesale: null,
      new_wholesale: null,
    };
    let hasEffectiveChange = false;

    if (row.cost !== undefined) {
      const roundedCost = roundCostDollarsOpt(row.cost) as number;
      if (live.current_cost !== roundedCost) {
        line.old_cost = live.current_cost;
        line.new_cost = roundedCost;
        hasEffectiveChange = true;
      }
    }

    if (row.retail_price !== undefined) {
      const retailChanged = live.current_retail !== row.retail_price;
      if (retailChanged) {
        line.old_retail = live.current_retail;
        line.new_retail = row.retail_price;
        hasEffectiveChange = true;
      }
    }
    if (row.wholesale_price !== undefined) {
      const wholesaleChanged = live.current_wholesale !== row.wholesale_price;
      if (wholesaleChanged) {
        line.old_wholesale = live.current_wholesale;
        line.new_wholesale = row.wholesale_price;
        hasEffectiveChange = true;
      }
    }

    if (hasEffectiveChange) {
      linesToCreate.push(line);
    } else {
      droppedNoopRows++;
    }
  }

  if (linesToCreate.length === 0) {
    return { ok: false, status: 400, body: { error: "no effective changes" } };
  }

  return { ok: true, result: { linesToCreate, droppedNoopRows } };
}
