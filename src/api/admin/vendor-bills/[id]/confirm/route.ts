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
import {
  decideSecondaryDispatch,
  loadSecondaryDispatchFacts,
} from "../../../../../lib/purchase-orders/qb-vendor-bill-sibling-dispatch";

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: () => Promise<
    KnexInstance & {
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
    }
  >;
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
      error: "Service, freight, tariff, and expense bills can only contain account lines",
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

  // THE CONFIRM AND ITS QUICKBOOKS INTENT ARE ONE OPERATION (2026-08-31).
  //
  // This route used to run outside any transaction and swallow an enqueue
  // failure into a 200 carrying `qb_sync: {queued:false, reason}` — a field the
  // POS never even declared, so the reason arrived and nobody read it. Measured
  // against production: not ONE service/freight/tariff bill ever produced a
  // BillAdd row, in either pipeline table, since the feature shipped. 18 bills
  // sat "finished" while QuickBooks had never heard of them, and nothing turned
  // red, because a row that is never created cannot fail.
  //
  // So the write now behaves like the regular bill's confirm: one transaction,
  // and a dispatch we decided to do that fails takes the confirm down with it.
  const trx = await knex.transaction();
  let qbQueued: { queued: boolean; reason: string; deferred?: boolean };
  try {
    await trx.raw(
      `UPDATE vendor_bill
       SET number = ?,
           status = 'confirmed',
           confirmed_at = NOW(),
           confirmed_by_user_id = ?,
           updated_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [vbNumber, userId, id]
    );

    const billRow = await trx.raw(
      `SELECT qb_txn_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    const qbTxnId = (billRow.rows[0] as { qb_txn_id: string | null } | undefined)
      ?.qb_txn_id;

    if (qbTxnId) {
      // ALREADY in QuickBooks: this is a correction to a live document and is
      // NEVER deferred. Holding a Mod back would leave QuickBooks quoting the
      // old amount — exactly the VB-1061 failure ($346.43 here, $328.60 there).
      //
      // Each bill goes ALONE (owner decision): the group Mod would drag the
      // regular bill along, and that one may be mid-repair. The regular's
      // clearing lines go stale as a result, which is what `qbResyncPending`
      // on it is for.
      const mod = await enqueueVendorBillModSingle(trx as never, id);
      qbQueued = mod.queued
        ? { queued: true, reason: "queued" }
        : { queued: false, reason: mod.reason };
      if (!qbQueued.queued) {
        throw new Error(`QuickBooks BillMod could not be queued: ${qbQueued.reason}`);
      }
    } else {
      // NOT in QuickBooks yet — the pair rule decides.
      const facts = await loadSecondaryDispatchFacts(trx, id);
      if (!facts) throw new Error("Vendor bill vanished mid-confirm");
      const decision = decideSecondaryDispatch(facts);

      if (!decision.dispatch) {
        // Deferred is a HEALTHY outcome, not a failure: the regular bill's
        // confirm will dispatch this one. It is reported so the POS can say so.
        qbQueued = {
          queued: false,
          reason: decision.reason,
          deferred: decision.deferred,
        };
      } else {
        const add = await enqueueQbVendorBillAdd(trx as never, id);
        if (!add.queued) {
          throw new Error(`QuickBooks BillAdd could not be queued: ${add.reason}`);
        }
        qbQueued = { queued: true, reason: decision.reason };
      }
    }
    await trx.commit();
  } catch (qbErr) {
    await trx.rollback().catch(() => undefined);
    console.error("[vendor-bill-confirm] confirm failed:", qbErr);
    return res.status(500).json({
      error:
        qbErr instanceof Error ? qbErr.message : "Vendor bill confirm failed",
      code: "confirm_failed",
    });
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
