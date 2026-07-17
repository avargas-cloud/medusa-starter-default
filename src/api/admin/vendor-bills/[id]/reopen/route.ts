/**
 * POST /admin/vendor-bills/:id/reopen
 *
 * Reopens a confirmed-and-locked regular vendor bill back to draft so its
 * quantities/costs can be corrected, then re-confirmed. HIGH RISK: re-running
 * confirm replays AVCO, so we reverse this bill's landed-cost contribution and
 * refuse whenever a later confirm could make the replay inconsistent (C6).
 *
 * Strict blockers (all must hold):
 *   - status === 'confirmed' (synced bills are out of scope — need QB void/mod)
 *   - no QuickBooks TxnID (defensive "unsynced")
 *   - no application on a CONFIRMED China wire (real money moved)
 *   - no LATER active vendor_bill_cost_log for the same variants (a newer
 *     confirm sits on top of this one in the AVCO chain → reversing now corrupts)
 *
 * Behaviour (transactional — cancel's reversal is NOT wrapped, this one is):
 *   - reverse AVCO per variant (same formula as cancel), mark cost logs reversed
 *   - status confirmed → draft, clear confirmed_at / confirmed_by_user_id
 *   - KEEP purchase_order_receipt_id (confirm depends on the receipt pin)
 *   - PO status is left untouched (confirm never mutated it)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    KnexInstance & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface BillRow {
  id: string;
  status: string;
  qb_txn_id: string | null;
}

interface CostLogRow {
  id: string;
  product_variant_id: string;
  received_qty: number;
  landed_unit_cost_cents: number;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err as Error;
  }

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const billResult = await knex.raw(
    `SELECT id, status, qb_txn_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) {
    return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status === "synced") {
    return res.status(422).json({
      error:
        "Synced bills can't be reopened here — void it in QuickBooks first (out of scope).",
      code: "synced_out_of_scope",
    });
  }
  if (bill.status !== "confirmed") {
    return res.status(409).json({
      error: `Only confirmed bills can be reopened (this one is '${bill.status}')`,
      code: "not_confirmed",
    });
  }
  if (bill.qb_txn_id) {
    return res.status(422).json({
      error: "This bill already has a QuickBooks TxnID — void in QB before reopening.",
      code: "has_qb_txn",
    });
  }

  // Blocker: application on a CONFIRMED China wire.
  const confirmedWire = await knex.raw(
    `SELECT 1
       FROM china_finance_bill cfb
       JOIN china_wire_transfer_application cwta ON cwta.bill_id = cfb.id
       JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
      WHERE cfb.vendor_bill_id = ? AND cwt.status = 'confirmed'
      LIMIT 1`,
    [id]
  );
  if (confirmedWire.rows.length > 0) {
    return res.status(409).json({
      error: "This bill is paid by a confirmed wire transfer — reverse the payment first.",
      code: "on_confirmed_wire",
    });
  }

  // Active cost logs for this bill.
  const logResult = await knex.raw(
    `SELECT id, product_variant_id, received_qty, landed_unit_cost_cents
       FROM vendor_bill_cost_log
      WHERE vendor_bill_id = ? AND reversed_at IS NULL`,
    [id]
  );
  const costLogs = logResult.rows as CostLogRow[];
  if (costLogs.length === 0) {
    return res.status(422).json({
      error: "No active cost log entries found — nothing to reverse.",
      code: "no_cost_log",
    });
  }

  // C6 blocker: a LATER active confirm on any of the same variants would make
  // the AVCO replay inconsistent. Refuse and name the variants.
  const laterResult = await knex.raw(
    `SELECT DISTINCT later.product_variant_id
       FROM vendor_bill_cost_log mine
       JOIN vendor_bill_cost_log later
         ON later.product_variant_id = mine.product_variant_id
        AND later.reversed_at IS NULL
        AND later.vendor_bill_id <> mine.vendor_bill_id
        AND later.created_at > mine.created_at
      WHERE mine.vendor_bill_id = ? AND mine.reversed_at IS NULL`,
    [id]
  );
  if (laterResult.rows.length > 0) {
    const variants = (laterResult.rows as Array<{ product_variant_id: string }>).map(
      (r) => r.product_variant_id
    );
    return res.status(409).json({
      error:
        "A newer confirmed bill already updated the landed cost of one or more of these variants. Reopen/cancel that bill first.",
      code: "later_cost_log_exists",
      variants,
    });
  }

  // ── Reverse AVCO + flip to draft, transactionally ───────────────────────────
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  const warnings: string[] = [];
  try {
    for (const log of costLogs) {
      const qResult = await db.raw(
        `SELECT COALESCE(SUM(il.stocked_quantity)::int, 0) AS qty
           FROM inventory_level il
           JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
          WHERE pvii.variant_id = ? AND il.deleted_at IS NULL`,
        [log.product_variant_id]
      );
      const qCurrent = Number(
        (qResult.rows[0] as { qty: number } | undefined)?.qty ?? 0
      );

      const metaResult = await db.raw(
        `SELECT metadata FROM product_variant WHERE id = ? AND deleted_at IS NULL`,
        [log.product_variant_id]
      );
      const meta = (metaResult.rows[0] as { metadata: Record<string, unknown> | null } | undefined)?.metadata;
      const currentAvg = Number(meta?.avg_landed_cost_cents ?? 0) || 0;

      const qBefore = qCurrent - log.received_qty;
      let restoredAvg: number;
      if (qBefore > 0) {
        restoredAvg =
          (qCurrent * currentAvg - log.received_qty * log.landed_unit_cost_cents) /
          qBefore;
        restoredAvg = Math.max(0, restoredAvg);
      } else {
        restoredAvg = 0;
        warnings.push(
          `variant ${log.product_variant_id}: inventory fully consumed, avg cost reset to 0`
        );
      }

      await db.raw(
        `UPDATE product_variant
            SET metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('avg_landed_cost_cents', ?::float,
                                    'avg_landed_cost_updated_at', now()::text,
                                    'average_cost', (?::float) / 100.0,
                                    'average_cost_updated_at', now()::text,
                                    'average_cost_source', 'landed'),
                updated_at = NOW()
          WHERE id = ?`,
        [restoredAvg, restoredAvg, log.product_variant_id]
      );

      await db.raw(
        `UPDATE vendor_bill_cost_log SET reversed_at = NOW(), updated_at = NOW()
          WHERE id = ?`,
        [log.id]
      );
    }

    await db.raw(
      `UPDATE vendor_bill
          SET status = 'draft',
              confirmed_at = NULL,
              confirmed_by_user_id = NULL,
              updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  const updated = await knex.raw(
    `SELECT * FROM vendor_bill WHERE id = ?`,
    [id]
  );
  return res.json({
    vendor_bill: updated.rows[0] ?? {},
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
