/**
 * Enqueues a QB "mod" item-pipeline row for a variant whose cost changed via
 * the bulk editor. Mirrors the mod branch of
 * `workflows/pos/update-pos-product.ts:buildQbStepInput` (partial payload —
 * undefined keys drop out so the bridge omits them and QB keeps the field
 * untouched) and the row shape `upsertItemPipelineRow` + the poller's
 * Phase B resubmit expect (`op_action`, `op_payload`, `status: 'waiting'`,
 * NO `qb_operation_id`).
 *
 * Never called for a variant without `metadata.quickbooks_id` — a bulk cost
 * edit must never mint a QB ADD; the caller reports those as `skipped_qb`.
 */
import { roundCostDollarsOpt } from "../../../../../../lib/cost/avco";
import { upsertItemPipelineRow } from "../../../../../../lib/quickbooks/upsert-item-pipeline-row";
import type { CatalogPipelineService } from "../../../../../../lib/quickbooks/upsert-item-pipeline-row";

interface MinimalLogger {
  info: (m: string) => void;
  warn: (m: string) => void;
}

export interface EnqueueBulkQbModInput {
  variant_id: string;
  sku: string;
  qb_id: string;
  qb_edit_sequence: string | undefined;
  new_cost: number;
}

/** Enqueues the mod row. Returns true once the row was written. */
export async function enqueueBulkQbMod(
  catalog: CatalogPipelineService,
  logger: MinimalLogger,
  input: EnqueueBulkQbModInput
): Promise<boolean> {
  const purchaseCost = roundCostDollarsOpt(input.new_cost);

  // Partial mod payload — ONLY the cost field. Undefined keys are omitted
  // (never sent as null), so the bridge's mod builder leaves SalesPrice,
  // SalesDesc, Name, etc. untouched in QB — a bulk cost edit must never
  // clobber the rest of the item.
  const data: Record<string, unknown> = {
    ListID: input.qb_id,
    EditSequence: input.qb_edit_sequence,
    PurchaseCost: purchaseCost,
  };
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key];
  }

  await upsertItemPipelineRow(
    catalog,
    {
      variant_id: input.variant_id,
      sku: input.sku,
      item_type: "Inventory",
      op_action: "mod",
      op_payload: data,
      qb_id: input.qb_id,
      status: "waiting",
    },
    logger
  );

  return true;
}
