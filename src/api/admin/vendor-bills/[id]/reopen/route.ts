import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  getActorUserId,
  UnauthenticatedError,
} from "../../../purchase-orders/_lib/auth";

type Db = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  transaction?: () => Promise<
    Db & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

interface BillRow {
  id: string;
  status: string;
  qb_txn_id: string | null;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const id = req.params.id;
  if (!id) {
    return res
      .status(400)
      .json({ error: "Vendor bill id is required", code: "missing_id" });
  }
  const knex = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as Db;
  const billResult = await knex.raw(
    `SELECT id, status, qb_txn_id FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = billResult.rows[0] as BillRow | undefined;
  if (!bill)
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  if (bill.status === "synced" || bill.qb_txn_id) {
    return res.status(422).json({
      error: "Void this bill in QuickBooks before reopening it.",
      code: "has_qb_txn",
    });
  }
  if (bill.status !== "confirmed") {
    return res.status(409).json({
      error: `Only confirmed bills can be reopened (this one is '${bill.status}')`,
      code: "not_confirmed",
    });
  }

  const confirmedWire = await knex.raw(
    `SELECT 1
       FROM china_finance_bill cfb
       JOIN china_wire_transfer_application a ON a.bill_id = cfb.id
       JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
      WHERE cfb.vendor_bill_id = ? AND w.status = 'confirmed'
      LIMIT 1`,
    [id]
  );
  if (confirmedWire.rows.length > 0) {
    return res.status(409).json({
      error: "Reverse the confirmed wire payment before reopening this bill.",
      code: "on_confirmed_wire",
    });
  }

  const trx = knex.transaction ? await knex.transaction() : null;
  if (!trx) {
    return res.status(500).json({
      error: "Transactions unavailable",
      code: "transaction_required",
    });
  }

  try {
    const locked = await trx.raw(
      `SELECT status FROM vendor_bill WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (
      (locked.rows[0] as { status?: string } | undefined)?.status !==
      "confirmed"
    ) {
      throw new Error(
        "Vendor bill changed after preview; refresh and try again"
      );
    }

    // Reopen is an editing-state transition only. The currently confirmed
    // generation remains the accounting truth while the replacement is a
    // draft. Its cost facts/events are retired atomically by the next Confirm,
    // immediately before the replacement generation is replayed.
    await trx.raw(
      `UPDATE vendor_bill
          SET status = 'draft', confirmed_at = NULL,
              confirmed_by_user_id = NULL,
              draft_revision_number = COALESCE((
                SELECT MAX(revision_number) + 1
                  FROM vendor_bill_revision
                 WHERE vendor_bill_id = ?
              ), 2),
              updated_at = NOW()
        WHERE id = ?`,
      [id, id]
    );
    await trx.commit();

    const updated = await knex.raw(`SELECT * FROM vendor_bill WHERE id = ?`, [
      id,
    ]);
    return res.json({
      vendor_bill: updated.rows[0] ?? {},
      cost_replay: { applied: false, applies_on: "confirm" },
    });
  } catch (error) {
    await trx.rollback().catch(() => undefined);
    return res.status(409).json({
      error: error instanceof Error ? error.message : "Cost replay failed",
      code: "cost_replay_conflict",
    });
  }
}
