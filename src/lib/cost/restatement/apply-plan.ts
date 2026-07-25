/**
 * src/lib/cost/restatement/apply-plan.ts
 *
 * Persists a restatement plan. Everything happens inside ONE transaction: a
 * partially-applied cost restatement is worse than none at all.
 *
 * COMPARE-AND-SWAP EVERYWHERE. Each sale line is updated only when its cost
 * still equals the value the plan was built from. If a row moved underneath the
 * run — a concurrent edit, a second session, a re-issued invoice — the update
 * matches zero rows and the whole transaction aborts. It never silently
 * overwrites a change it did not account for.
 *
 * ORDER MATTERS: the immutable audit row (`sale_cost_adjustment`) is written
 * BEFORE the visible column is touched, so the pre-restatement value is
 * captured even if the update then fails. The invoice column is a projection of
 * the audit trail, not the audit trail itself.
 */

import { centsToDollars } from "./rebuild-timeline";
import type { SaleRestatement } from "./restate-sales";
import type { RestatementPlan } from "./run-restatement";

export interface TrxLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: any[]; rowCount?: number }>;
}

export interface KnexWithTransaction {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: any[]; rowCount?: number }>;
  transaction: <T>(handler: (trx: TrxLike) => Promise<T>) => Promise<T>;
}

export interface ApplyResult {
  runId: string;
  costEventsWritten: number;
  variantsUpdated: number;
  invoiceLinesRestated: number;
  creditMemoLinesRestated: number;
  adjustmentsWritten: number;
}

/** Stable id so a retried apply reuses rows instead of duplicating them. */
function eventId(runId: string, idempotencyKey: string): string {
  return `vce_${hashish(`${runId}:${idempotencyKey}`)}`;
}
function adjustmentId(
  runId: string,
  sourceType: string,
  lineId: string
): string {
  return `sca_${hashish(`${runId}:${sourceType}:${lineId}`)}`;
}
/**
 * Short deterministic id. Not cryptographic — it only has to be stable and
 * collision-free across a few thousand rows within one run.
 */
function hashish(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) + 1, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export async function applyPlan(
  knex: KnexWithTransaction,
  plan: RestatementPlan
): Promise<ApplyResult> {
  return knex.transaction((trx) => applyPlanInTransaction(trx, plan));
}

/** Apply inside a caller-owned transaction (vendor-bill replay uses this). */
export async function applyPlanInTransaction(
  trx: TrxLike,
  plan: RestatementPlan
): Promise<ApplyResult> {
  const { runId } = plan.options;
  // --- 1. The manifest. Re-applying an applied run is a no-op by design. ---
  const existing = await trx.raw(
    `SELECT status, input_hash FROM cost_restatement_run WHERE id = ?`,
    [runId]
  );
  const priorRun = existing.rows[0] as
    | { status: string; input_hash: string }
    | undefined;
  if (priorRun?.status === "applied") {
    if (priorRun.input_hash !== plan.inputHash) {
      throw new Error(
        `Run ${runId} is already applied with a DIFFERENT input hash ` +
          `(${priorRun.input_hash} vs ${plan.inputHash}). Create a new run id; ` +
          `never re-apply a run against moved source data.`
      );
    }
    return {
      runId,
      costEventsWritten: 0,
      variantsUpdated: 0,
      invoiceLinesRestated: 0,
      creditMemoLinesRestated: 0,
      adjustmentsWritten: 0,
    };
  }

  await trx.raw(
    `INSERT INTO cost_restatement_run
         (id, reason, methodology_version, scope, source_data_cutoff, anchor_date,
          status, input_hash, requested_by, variants_affected, cost_events_written,
          lines_restated, cogs_delta_cents, inventory_delta_cents, exceptions, reconciliation)
       VALUES (?, ?, ?, 'china', ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         status = 'applied', input_hash = EXCLUDED.input_hash,
         exceptions = EXCLUDED.exceptions, reconciliation = EXCLUDED.reconciliation,
         applied_at = NOW(), updated_at = NOW()`,
    [
      runId,
      plan.options.reason,
      plan.methodologyVersion,
      plan.options.sourceDataCutoff.toISOString(),
      plan.options.anchorDate.toISOString(),
      plan.inputHash,
      plan.options.requestedBy ?? null,
      plan.rebuilds.length,
      plan.reconciliation.costEvents,
      plan.reconciliation.invoices.changedLines +
        plan.reconciliation.creditMemos.changedLines,
      Math.round(plan.reconciliation.totalCogsDelta * 100),
      plan.reconciliation.inventoryDeltaCents,
      JSON.stringify(plan.exceptions),
      JSON.stringify(plan.reconciliation),
    ]
  );
  await trx.raw(
    `UPDATE cost_restatement_run SET applied_at = NOW() WHERE id = ?`,
    [runId]
  );

  // The rows remain immutable, but only one reconstructed projection may be
  // active for a variant. Retire the prior projection before appending this
  // run's version; source facts and reversal events are never touched.
  const replayVariantIds = plan.rebuilds.map((r) => r.variantId);
  if (replayVariantIds.length > 0) {
    await trx.raw(
      `UPDATE variant_cost_event
            SET status = 'superseded'
          WHERE product_variant_id = ANY(?::text[])
            AND restatement_run_id IS NOT NULL
            AND status = 'active'`,
      [replayVariantIds]
    );
  }

  // --- 2. Cost events. Append-only; the run-scoped key makes retries safe. ---
  const allEvents = plan.rebuilds.flatMap((rebuild) => rebuild.events);
  let costEventsWritten = 0;
  for (const chunk of chunked(allEvents, WRITE_CHUNK)) {
    const result = await trx.raw(
      `INSERT INTO variant_cost_event
           (id, product_variant_id, event_type, cost_field, effective_at, recorded_at,
            previous_unit_cost, new_unit_cost, quantity_on_hand_at_event,
            inventory_value_delta_cents, source_system, source_type, source_id,
            status, idempotency_key, restatement_run_id, methodology_version,
            economic_sequence, receipt_id, vendor_bill_id, quantity_delta,
            cogs_true_up_cents, negative_settled_quantity, reason_code, metadata)
         SELECT u.id, u.variant_id, u.event_type, 'average_cost',
                u.effective_at::timestamptz, u.recorded_at::timestamptz,
                u.prev_cost, u.new_cost, u.qty_on_hand, u.value_delta,
                u.source_system, u.source_type, u.source_id, 'active', u.idem_key,
                ?, ?, u.economic_seq, u.receipt_id, u.bill_id, u.qty_delta,
                u.true_up, u.settled, 'china_cost_basis_restatement', u.meta::jsonb
           FROM UNNEST(
                  ?::text[], ?::text[], ?::text[], ?::text[], ?::text[],
                  ?::numeric[], ?::numeric[], ?::int[], ?::bigint[],
                  ?::text[], ?::text[], ?::text[], ?::text[], ?::bigint[],
                  ?::text[], ?::text[], ?::int[], ?::bigint[], ?::int[], ?::text[]
                ) AS u(id, variant_id, event_type, effective_at, recorded_at,
                       prev_cost, new_cost, qty_on_hand, value_delta,
                       source_system, source_type, source_id, idem_key, economic_seq,
                       receipt_id, bill_id, qty_delta, true_up, settled, meta)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      [
        runId,
        plan.methodologyVersion,
        chunk.map((e) => eventId(runId, e.idempotencyKey)),
        chunk.map((e) => e.variantId),
        chunk.map((e) => e.eventType),
        chunk.map((e) => e.effectiveAt.toISOString()),
        chunk.map((e) => e.recordedAt.toISOString()),
        chunk.map((e) =>
          e.previousUnitCostCents === null
            ? null
            : centsToDollars(e.previousUnitCostCents)
        ),
        chunk.map((e) => centsToDollars(e.newUnitCostCents)),
        chunk.map((e) => e.quantityOnHandAfter),
        chunk.map((e) => e.inventoryValueDeltaCents),
        chunk.map((e) =>
          e.eventType === "opening_balance" ? "quickbooks" : "medusa"
        ),
        chunk.map((e) =>
          e.eventType === "opening_balance"
            ? "qb_catalog_load"
            : "vendor_bill_cost_log"
        ),
        chunk.map((e) => e.sourceId),
        chunk.map((e) => `${runId}:${e.idempotencyKey}`),
        chunk.map((e) => e.economicSequence),
        chunk.map((e) => e.receiptId),
        chunk.map((e) => e.vendorBillId),
        chunk.map((e) => e.quantityDelta),
        chunk.map((e) => Math.round(e.cogsTrueUpCents)),
        chunk.map((e) => e.negativeSettledQuantity),
        chunk.map((e) =>
          JSON.stringify({
            sku: e.sku,
            quantityOnHandBefore: e.quantityOnHandBefore,
          })
        ),
      ]
    );
    costEventsWritten += result.rowCount ?? 0;
  }

  // --- 3. The variant's current carrying cost. ---
  // JSONB merge (||) — a full-blob write would stomp quickbooks_id and the
  // rest of the variant's metadata.
  const variantWrites = plan.rebuilds.filter(
    (rebuild) => rebuild.anchorUnitCostCents > 0 || rebuild.events.length > 1
  );
  let variantsUpdated = 0;
  for (const chunk of chunked(variantWrites, WRITE_CHUNK)) {
    const result = await trx.raw(
      `UPDATE product_variant AS pv
            SET metadata = COALESCE(pv.metadata, '{}'::jsonb) || jsonb_build_object(
                  'average_cost', u.cost_dollars,
                  'average_cost_source', u.source,
                  'average_cost_updated_at', now()::text,
                  'average_cost_restatement_run_id', ?::text,
                  'avg_landed_cost_cents', u.cost_cents),
                updated_at = NOW()
           FROM UNNEST(?::text[], ?::float[], ?::text[], ?::float[])
                AS u(variant_id, cost_dollars, source, cost_cents)
          WHERE pv.id = u.variant_id AND pv.deleted_at IS NULL`,
      [
        runId,
        chunk.map((r) => r.variantId),
        chunk.map((r) => centsToDollars(r.finalUnitCostCents)),
        chunk.map((r) => (r.events.length > 1 ? "landed" : "sync")),
        chunk.map((r) => r.finalUnitCostCents),
      ]
    );
    variantsUpdated += result.rowCount ?? 0;
  }

  // --- 4 & 5. Audit row first, then the visible column, under CAS. ---
  const invoiceLinesRestated = await applySaleRestatements(
    trx,
    runId,
    plan.invoiceRestatements,
    "invoice_item",
    "pos_invoice_item"
  );
  const creditMemoLinesRestated = await applySaleRestatements(
    trx,
    runId,
    plan.creditMemoRestatements,
    "credit_memo_item",
    "pos_credit_memo_item"
  );

  await trx.raw(
    `UPDATE cost_restatement_run SET cost_events_written = ?, updated_at = NOW() WHERE id = ?`,
    [costEventsWritten, runId]
  );

  return {
    runId,
    costEventsWritten,
    variantsUpdated,
    invoiceLinesRestated,
    creditMemoLinesRestated,
    adjustmentsWritten: invoiceLinesRestated + creditMemoLinesRestated,
  };
}

/**
 * Rows are written in CHUNKS, not one statement per line.
 *
 * The first version issued two round-trips per sale line — roughly 5,500
 * sequential queries — which is fine against a local socket and hopeless
 * against a hosted database: the production run passed ten minutes without
 * finishing and had to be killed. Set-based writes collapse that to a handful
 * of statements.
 *
 * The compare-and-swap survives the rewrite intact. The expected prior cost
 * travels in the UNNEST payload and sits in the UPDATE's WHERE clause, so a row
 * that moved simply does not match — and because the whole chunk is one
 * statement, a short row count proves at least one row moved and aborts the
 * transaction. Set-based, same guarantee.
 */
const WRITE_CHUNK = 500;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

async function applySaleRestatements(
  trx: TrxLike,
  runId: string,
  restatements: readonly SaleRestatement[],
  sourceType: "invoice_item" | "credit_memo_item",
  table: "pos_invoice_item" | "pos_credit_memo_item"
): Promise<number> {
  const pending = restatements.filter(
    (result) => result.changed && result.newRestatedUnitCost !== null
  );
  let updated = 0;

  for (const chunk of chunked(pending, WRITE_CHUNK)) {
    // The immutable record goes in FIRST: if the update below fails, the
    // pre-restatement values are still captured.
    await trx.raw(
      `INSERT INTO sale_cost_adjustment
         (id, restatement_run_id, source_type, source_line_id, source_document_id,
          product_variant_id, sku, quantity, original_unit_cost, prior_restated_unit_cost,
          new_restated_unit_cost, original_extended_cogs, new_extended_cogs, delta_cogs,
          cost_event_id, economic_posted_at, reason_code, derived_from_line_id)
       SELECT u.id, ?, ?, u.line_id, u.document_id, u.variant_id, u.sku, u.quantity,
              u.original_cost, u.prior_cost, u.new_cost, u.original_ext, u.new_ext,
              u.delta, u.event_key, u.posted_at::timestamptz, u.reason, u.derived_from
         FROM UNNEST(
                ?::text[], ?::text[], ?::text[], ?::text[], ?::text[], ?::int[],
                ?::numeric[], ?::numeric[], ?::numeric[], ?::numeric[], ?::numeric[],
                ?::numeric[], ?::text[], ?::text[], ?::text[], ?::text[]
              ) AS u(id, line_id, document_id, variant_id, sku, quantity,
                     original_cost, prior_cost, new_cost, original_ext, new_ext,
                     delta, event_key, posted_at, reason, derived_from)
       ON CONFLICT (restatement_run_id, source_type, source_line_id) DO NOTHING`,
      [
        runId,
        sourceType,
        chunk.map((r) => adjustmentId(runId, sourceType, r.lineId)),
        chunk.map((r) => r.lineId),
        chunk.map((r) => r.documentId),
        chunk.map((r) => r.variantId),
        chunk.map((r) => r.sku),
        chunk.map((r) => r.quantity),
        chunk.map((r) => r.originalUnitCost),
        chunk.map((r) => r.priorRestatedUnitCost),
        chunk.map((r) => r.newRestatedUnitCost),
        chunk.map((r) => r.originalExtendedCogs),
        chunk.map((r) => r.newExtendedCogs),
        chunk.map((r) => r.deltaCogs),
        chunk.map((r) => r.costEventKey),
        chunk.map((r) => r.economicPostedAt.toISOString()),
        chunk.map((r) => r.reasonCode),
        chunk.map((r) => r.derivedFromLineId),
      ]
    );

    // IS NOT DISTINCT FROM so a NULL prior value matches NULL rather than
    // never matching anything.
    const update = await trx.raw(
      `UPDATE ${table} AS t
          SET average_unit_cost = u.new_cost,
              raw_average_unit_cost = jsonb_build_object('value', u.new_cost),
              average_unit_cost_synced_at = NOW(),
              updated_at = NOW()
         FROM UNNEST(?::text[], ?::numeric[], ?::numeric[])
              AS u(line_id, new_cost, expected_cost)
        WHERE t.id = u.line_id
          AND t.deleted_at IS NULL
          AND t.average_unit_cost IS NOT DISTINCT FROM u.expected_cost`,
      [
        chunk.map((r) => r.lineId),
        chunk.map((r) => r.newRestatedUnitCost),
        chunk.map((r) => r.priorRestatedUnitCost),
      ]
    );

    const applied = update.rowCount ?? 0;
    if (applied !== chunk.length) {
      throw new Error(
        `Compare-and-swap failed on ${table}: expected to update ${chunk.length} rows, ` +
          `matched ${applied}. At least one row's cost changed after the plan was built — ` +
          `the transaction is being rolled back. Regenerate the run.`
      );
    }
    updated += applied;
  }

  return updated;
}
