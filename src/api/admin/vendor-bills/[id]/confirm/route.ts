/**
 * POST /admin/vendor-bills/:id/confirm
 *
 * Confirms service, freight, and tariff bills. These bills contain QB account
 * lines only and do not allocate landed cost into product variants.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import {
  normalizeRequiredVendorBillReference,
  VENDOR_BILL_REFERENCE_REQUIRED_BODY,
} from "../../../../../lib/purchase-orders/vendor-bill-reference-uniqueness";
import { enqueueQbVendorBillAdd } from "../../../../../lib/purchase-orders/qb-vendor-bill-enqueue";
import { enqueueVendorBillModSingle } from "../../../../../lib/purchase-orders/qb-vendor-bill-mod-enqueue";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const billResult = await knex.raw(
    `SELECT id, number, status, bill_type, reference_id
     FROM vendor_bill
     WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as
    | {
        id: string;
        number: string | null;
        status: string;
        bill_type: string;
        reference_id: string | null;
      }
    | null;

  if (!bill) {
    return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.bill_type === "regular") {
    return res.status(422).json({
      error: "Regular bills must be confirmed from their purchase order receipt",
      code: "regular_bill_confirm_requires_receipt",
    });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: `Vendor bill is already in status '${bill.status}'`,
      code: "not_draft",
    });
  }
  if (!normalizeRequiredVendorBillReference(bill.reference_id)) {
    return res.status(409).json(VENDOR_BILL_REFERENCE_REQUIRED_BODY);
  }

  const linesResult = await knex.raw(
    `SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE line_type = 'qb_account')::int AS account_count
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
    [id]
  );
  const rawLineStats = (linesResult.rows[0] ?? { count: 0, account_count: 0 }) as {
    count: number | string;
    account_count: number | string;
  };
  const lineStats = {
    count: Number(rawLineStats.count),
    account_count: Number(rawLineStats.account_count),
  };

  if (lineStats.count === 0) {
    return res.status(422).json({ error: "Vendor bill has no lines", code: "no_lines" });
  }
  if (lineStats.count !== lineStats.account_count) {
    return res.status(422).json({
      error: "Service, freight, and tariff bills can only contain account lines",
      code: "invalid_line_type",
    });
  }

  let vbNumber = bill.number;
  if (!vbNumber) {
    const seqResult = await knex.raw(
      `SELECT nextval('custom_vendor_bill_seq') AS seq`
    );
    vbNumber = `VB-${(seqResult.rows[0] as { seq: string | number }).seq}`;
  }

  await knex.raw(
    `UPDATE vendor_bill
     SET number = ?,
         status = 'confirmed',
         confirmed_at = NOW(),
         confirmed_by_user_id = ?,
         updated_at = NOW()
     WHERE id = ? AND deleted_at IS NULL`,
    [vbNumber, userId, id]
  );

  // Send it to QuickBooks. Until 2026-08-04 this route confirmed the bill and
  // returned — no enqueue at all — so a service/freight/tariff bill was a
  // finished document in the POS that QuickBooks had never heard of. Four of
  // them ($2,325.25, all 2026-07-29) sat that way, and VB-1061 was edited to
  // $346.43 while QuickBooks kept quoting $328.60.
  //
  // Each bill goes ALONE (owner decision): the group Mod would drag the regular
  // bill along, and that one may be mid-repair. The regular's clearing lines go
  // stale as a result, which is what `qbResyncPending` on it is for.
  let qbQueued: { queued: boolean; reason?: string } = { queued: false };
  try {
    const billRow = await knex.raw(
      `SELECT qb_txn_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    const qbTxnId = (billRow.rows[0] as { qb_txn_id: string | null } | undefined)
      ?.qb_txn_id;
    qbQueued = qbTxnId
      ? await enqueueVendorBillModSingle(knex as never, id)
      : await enqueueQbVendorBillAdd(knex as never, id);
  } catch (qbErr) {
    // A QuickBooks enqueue failure must not un-confirm the bill: the local
    // document is correct and the sync is retryable. It is reported, never
    // swallowed — a silent catch here is how this gap stayed invisible.
    console.error("[vendor-bill-confirm] QB enqueue failed:", qbErr);
    qbQueued = {
      queued: false,
      reason: qbErr instanceof Error ? qbErr.message : "enqueue failed",
    };
  }

  const headerResult = await knex.raw(
    `SELECT *
     FROM vendor_bill
     WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const lineResult = await knex.raw(
    `SELECT *
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  return res.json({
    vendor_bill: {
      ...(headerResult.rows[0] ?? {}),
      lines: lineResult.rows,
    },
    // Whether QuickBooks was told. `queued: false` with a reason is a real
    // answer the POS can show — silence was what let four bills go missing.
    qb_sync: qbQueued,
  });
}
