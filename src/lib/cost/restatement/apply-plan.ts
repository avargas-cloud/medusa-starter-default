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

import type { RestatementPlan } from "./run-restatement";
import type { SaleRestatement } from "./restate-sales";
import { centsToDollars } from "./rebuild-timeline";

export interface TrxLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
}

export interface KnexWithTransaction {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
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
function adjustmentId(runId: string, sourceType: string, lineId: string): string {
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
  const { runId } = plan.options;

  return knex.transaction(async (trx) => {
    // --- 1. The manifest. Re-applying an applied run is a no-op by design. ---
    const existing = await trx.raw(
      `SELECT status, input_hash FROM cost_restatement_run WHERE id = ?`,
      [runId]
    );
    const priorRun = existing.rows[0] as { status: string; input_hash: string } | undefined;
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
        plan.reconciliation.invoices.changedLines + plan.reconciliation.creditMemos.changedLines,
        Math.round(plan.reconciliation.totalCogsDelta * 100),
        plan.reconciliation.inventoryDeltaCents,
        JSON.stringify(plan.exceptions),
        JSON.stringify(plan.reconciliation),
      ]
    );
    await trx.raw(`UPDATE cost_restatement_run SET applied_at = NOW() WHERE id = ?`, [runId]);

    // --- 2. Cost events. Append-only; the idempotency key makes retries safe. ---
    let costEventsWritten = 0;
    for (const rebuild of plan.rebuilds) {
      for (const event of rebuild.events) {
        const result = await trx.raw(
          `INSERT INTO variant_cost_event
             (id, product_variant_id, event_type, cost_field, effective_at, recorded_at,
              previous_unit_cost, new_unit_cost, quantity_on_hand_at_event,
              inventory_value_delta_cents, source_system, source_type, source_id,
              status, idempotency_key, restatement_run_id, methodology_version,
              economic_sequence, receipt_id, vendor_bill_id, quantity_delta,
              cogs_true_up_cents, negative_settled_quantity, reason_code, metadata)
           VALUES (?, ?, ?, 'average_cost', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
          [
            eventId(runId, event.idempotencyKey),
            event.variantId,
            event.eventType,
            event.effectiveAt.toISOString(),
            event.recordedAt.toISOString(),
            event.previousUnitCostCents === null
              ? null
              : centsToDollars(event.previousUnitCostCents),
            centsToDollars(event.newUnitCostCents),
            event.quantityOnHandAfter,
            event.inventoryValueDeltaCents,
            event.eventType === "opening_balance" ? "quickbooks" : "medusa",
            event.eventType === "opening_balance" ? "qb_catalog_load" : "vendor_bill_cost_log",
            event.sourceId,
            event.idempotencyKey,
            runId,
            plan.methodologyVersion,
            event.economicSequence,
            event.receiptId,
            event.vendorBillId,
            event.quantityDelta,
            Math.round(event.cogsTrueUpCents),
            event.negativeSettledQuantity,
            "china_cost_basis_restatement",
            JSON.stringify({ sku: event.sku, quantityOnHandBefore: event.quantityOnHandBefore }),
          ]
        );
        costEventsWritten += result.rowCount ?? 0;
      }
    }

    // --- 3. The variant's current carrying cost. ---
    let variantsUpdated = 0;
    for (const rebuild of plan.rebuilds) {
      if (rebuild.anchorUnitCostCents <= 0 && rebuild.events.length <= 1) continue;
      const dollars = centsToDollars(rebuild.finalUnitCostCents);
      // JSONB merge (||) — a full-blob write would stomp quickbooks_id and the
      // rest of the variant's metadata.
      const result = await trx.raw(
        // Every parameter needs an explicit cast: jsonb_build_object is
        // variadic "any", so Postgres cannot infer a bare parameter's type and
        // fails with 42P18 "could not determine data type".
        `UPDATE product_variant
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'average_cost', ?::float,
                  'average_cost_source', ?::text,
                  'average_cost_updated_at', now()::text,
                  'average_cost_restatement_run_id', ?::text,
                  'avg_landed_cost_cents', ?::float),
                updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [
          dollars,
          rebuild.events.length > 1 ? "landed" : "sync",
          runId,
          rebuild.finalUnitCostCents,
          rebuild.variantId,
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
  });
}

async function applySaleRestatements(
  trx: TrxLike,
  runId: string,
  restatements: readonly SaleRestatement[],
  sourceType: "invoice_item" | "credit_memo_item",
  table: "pos_invoice_item" | "pos_credit_memo_item"
): Promise<number> {
  let updated = 0;

  for (const result of restatements) {
    if (!result.changed || result.newRestatedUnitCost === null) continue;

    // The immutable record goes in FIRST: if the update below fails, the
    // pre-restatement value is still captured.
    await trx.raw(
      `INSERT INTO sale_cost_adjustment
         (id, restatement_run_id, source_type, source_line_id, source_document_id,
          product_variant_id, sku, quantity, original_unit_cost, prior_restated_unit_cost,
          new_restated_unit_cost, original_extended_cogs, new_extended_cogs, delta_cogs,
          cost_event_id, economic_posted_at, reason_code, derived_from_line_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (restatement_run_id, source_type, source_line_id) DO NOTHING`,
      [
        adjustmentId(runId, sourceType, result.lineId),
        runId,
        sourceType,
        result.lineId,
        result.documentId,
        result.variantId,
        result.sku,
        result.quantity,
        result.originalUnitCost,
        result.priorRestatedUnitCost,
        result.newRestatedUnitCost,
        result.originalExtendedCogs,
        result.newExtendedCogs,
        result.deltaCogs,
        result.costEventKey,
        result.economicPostedAt.toISOString(),
        result.reasonCode,
        result.derivedFromLineId,
      ]
    );

    // Compare-and-swap. IS NOT DISTINCT FROM so a NULL prior value matches
    // NULL rather than never matching anything.
    const update = await trx.raw(
      `UPDATE ${table}
          SET average_unit_cost = ?,
              raw_average_unit_cost = ?::jsonb,
              average_unit_cost_synced_at = NOW(),
              updated_at = NOW()
        WHERE id = ?
          AND deleted_at IS NULL
          AND average_unit_cost IS NOT DISTINCT FROM ?`,
      [
        result.newRestatedUnitCost,
        JSON.stringify({ value: result.newRestatedUnitCost }),
        result.lineId,
        result.priorRestatedUnitCost,
      ]
    );

    if ((update.rowCount ?? 0) === 0) {
      throw new Error(
        `Compare-and-swap failed on ${table} ${result.lineId}: expected cost ` +
          `${result.priorRestatedUnitCost}, row no longer matches. The source data ` +
          `moved after the plan was built — regenerate the run.`
      );
    }
    updated += update.rowCount ?? 0;
  }

  return updated;
}
