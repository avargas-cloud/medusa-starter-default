/**
 * POST /admin/vendor-bills/:id/resync-qb
 *
 * Re-sends a bill to QuickBooks WITHOUT changing it.
 *
 * Two cases, gated differently — see the branch below for why a sibling bill
 * carries no gate.
 *
 * The case it was built for: a linked commission / freight / tariff bill was
 * edited. Each bill syncs on its own, so that edit went out alone and left this
 * bill's negative clearing line quoting the old figure — QuickBooks' A/P is off
 * by the difference. This bill is not dirty (its own document did not change),
 * so Save is disabled, and once it is `confirmed`/`synced` there is no Confirm
 * button either. Without this route the banner on the bill would be a warning
 * with no exit, and the only workaround would be editing a line to dirty the
 * form — repairing a sync by MODIFYING the document.
 *
 * WHAT IT DOES NOT DO: no revision, no AVCO, no COGS, not one row of the bill
 * changes. It queues a BillMod built from the bill as it stands, whose clearing
 * amounts come from the siblings' CURRENT totals. That is why re-sending
 * settles the drift instead of restating anything.
 *
 * NO SUPERVISOR PIN, deliberately: this cannot move money in our books and it
 * cannot invent a figure. It makes QuickBooks agree with what the POS already
 * says — the only direction it can push is toward the truth we already hold.
 *
 * GATED ON REAL DRIFT: it refuses when the two sides already agree, so the
 * button cannot fire BillMods at QuickBooks for nothing.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  enqueueRegularBillModAlone,
  enqueueVendorBillModSingle,
} from "../../../../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";
import {
  deriveClearingDrift,
  type PersistedClearingLine,
} from "../../../../../lib/purchase-orders/qb-vendor-bill-clearing-lines";
import { loadClearingSiblings } from "../../../../../lib/purchase-orders/load-clearing-siblings";

interface BillRow {
  id: string;
  number: string | null;
  bill_type: string;
  qb_txn_id: string | null;
  qb_source: string | null;
  lines: PersistedClearingLine[];
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const knex = req.scope.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  };
  const { id } = req.params as { id: string };

  const billResult = await knex.raw(
    `SELECT id, number, bill_type, qb_txn_id, qb_source,
            COALESCE(qb_clearing_lines, '[]'::jsonb) AS lines
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) {
    res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
    return;
  }
  if (bill.qb_source === "adopted") {
    res.status(409).json({
      error:
        "This bill was adopted from QuickBooks — it is the accountant's document, and Store POS does not edit it.",
      code: "adopted_bill_readonly",
    });
    return;
  }
  if (!bill.qb_txn_id) {
    res.status(409).json({
      error:
        "This bill is not in QuickBooks yet, so there is nothing to correct over there. Confirming it sends the current amounts.",
      code: "not_in_quickbooks",
    });
    return;
  }

  // A SERVICE / FREIGHT / TARIFF bill re-sends itself, and without a gate.
  //
  // For a regular bill we know what QuickBooks holds — `qb_clearing_lines` is
  // written every time we send one — so the button can be offered only when the
  // two sides actually disagree. For a sibling there is no such record: its own
  // `qb_clearing_lines` is a snapshot the July backfill wrote and nothing has
  // updated since, so treating it as the truth would either hide a real gap or
  // show a banner that never clears. The operator is the one who knows the bill
  // was edited without QuickBooks being told — which is exactly what happened
  // to VB-1061, $346.43 here against $328.60 over there since July, with no
  // pipeline row ever queued for it.
  //
  // Re-sending is a BillMod carrying the bill's current amounts: worst case it
  // tells QuickBooks something it already knew.
  if (bill.bill_type !== "regular") {
    const sent = await enqueueVendorBillModSingle(knex as never, id);
    if (!sent.queued) {
      res.status(409).json({
        error: `QuickBooks sync was not queued: ${sent.reason ?? "unknown reason"}`,
        code: "resync_not_queued",
        reason: sent.reason,
      });
      return;
    }
    res.json({ queued: true, group_id: sent.groupId, bill_ids: sent.billIds });
    return;
  }

  // The same comparison the detail route renders the banner from — one
  // derivation, so the button cannot disagree with the reason it was offered.
  const siblings = await loadClearingSiblings(knex, id);
  const drift = deriveClearingDrift(bill.lines ?? [], siblings);
  if (!drift.stale) {
    res.status(409).json({
      error:
        "QuickBooks already has the current amounts for the linked bills. Nothing to re-send.",
      code: "nothing_to_resync",
    });
    return;
  }

  const result = await enqueueRegularBillModAlone(knex as never, id);
  if (!result.queued) {
    res.status(409).json({
      error: `QuickBooks sync was not queued: ${result.reason ?? "unknown reason"}`,
      code: "resync_not_queued",
      reason: result.reason,
    });
    return;
  }

  res.json({
    queued: true,
    group_id: result.groupId,
    bill_ids: result.billIds,
    // Echoed so the caller can say what it just corrected instead of a bare
    // "queued" — the operator is watching an A/P figure, not a job.
    corrected: drift,
  });
}
