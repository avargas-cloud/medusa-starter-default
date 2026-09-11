import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { pgDateToIso } from "../date/et";

import { loadCreditedQtyByPoLine, loadPoForCredit, validateProductLinesAgainstPo } from "./po-link";
import { VendorCreditError, type PgClient, type VendorCreditLineInput } from "./types";

interface CreditRow {
  id: string;
  status: string;
  number: string | null;
  purchase_order_id: string | null;
  // pg returns a `date` column as a JS Date (local-midnight parsed) — never
  // a bare string. Read it through `pgDateToIso`, never pass it raw to
  // `assertBankAccountingPeriodOpen` (BANKING_INVALID_ACCOUNTING_DATE).
  credit_date: Date | string;
  total_cents: number;
}

interface StoredLineRow {
  line_type: "product" | "qb_account";
  variant_id: string | null;
  purchase_order_line_id: string | null;
  sku: string | null;
  qty: number | null;
  amount_cents: number | string;
}

/**
 * draft → posted. The `VC-####` number is assigned at CREATE, not here (see
 * create.ts — same as `vendor_bill` shows `VB-####` while still draft) — this
 * only flips status and locks the period. Lines are already immutable to
 * edits once posted, enforced by the PATCH route refusing non-draft.
 *
 * The "returned ≤ received" cap is re-asserted HERE under the credit's row
 * lock and the PO's (`FOR UPDATE` on `purchase_order`, a read-side lock —
 * the row is never written): two drafts saved against the same received
 * units can both exist, and this is the gate that lets only one post.
 */
export async function markVendorCreditPosted(
  client: PgClient,
  creditId: string,
  actorId: string
): Promise<{ id: string; number: string }> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status, number, purchase_order_id, credit_date, total_cents FROM vendor_credit
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [creditId]
    );
    const credit = rows[0] as CreditRow | undefined;
    if (!credit) throw new VendorCreditError("not_found", "Vendor credit not found.", 404);
    if (credit.status !== "draft") {
      throw new VendorCreditError(
        "invalid_status",
        `Vendor credit is ${credit.status}, expected draft.`,
        409
      );
    }
    const { rows: lineRows } = await client.query(
      `SELECT line_type, variant_id, purchase_order_line_id, sku, qty, amount_cents
         FROM vendor_credit_line WHERE credit_id = $1 AND deleted_at IS NULL ORDER BY sort`,
      [creditId]
    );
    const storedLines = lineRows as StoredLineRow[];
    if (storedLines.length === 0 || !(credit.total_cents > 0)) {
      throw new VendorCreditError("no_lines", "Vendor credit has no lines to post.");
    }

    if (credit.purchase_order_id) {
      await client.query(`SELECT id FROM purchase_order WHERE id = $1 FOR UPDATE`, [
        credit.purchase_order_id,
      ]);
      const po = await loadPoForCredit(client, credit.purchase_order_id);
      if (!po) throw new VendorCreditError("po_not_found", "Purchase order not found.", 404);
      const credited = await loadCreditedQtyByPoLine(client, po.id, creditId);
      const asInputs: VendorCreditLineInput[] = storedLines.map((l) => ({
        line_type: l.line_type,
        variant_id: l.variant_id,
        purchase_order_line_id: l.purchase_order_line_id,
        sku: l.sku,
        qty: l.qty,
        amount_cents: Number(l.amount_cents),
      }));
      validateProductLinesAgainstPo(asInputs, po, credited);
    } else if (storedLines.some((l) => l.line_type === "product")) {
      throw new VendorCreditError(
        "product_line_requires_po",
        "This credit has product lines but no purchase order — it cannot be posted."
      );
    }

    await assertBankAccountingPeriodOpen(
      client as unknown as PoolClient,
      pgDateToIso(credit.credit_date)
    );

    if (!credit.number) {
      // Should be unreachable — create.ts assigns it unconditionally — but a
      // credit somehow missing one is not something `post` should paper over
      // by minting a fresh one silently (that would desync the sequence from
      // what create.ts already handed the caller).
      throw new VendorCreditError(
        "missing_number",
        "Vendor credit has no VC-#### number (expected to be assigned at create)."
      );
    }
    await client.query(
      `UPDATE vendor_credit SET status='posted', posted_at=now(), posted_by=$2, updated_at=now()
        WHERE id=$1`,
      [creditId, actorId]
    );
    await client.query("COMMIT");
    return { id: creditId, number: credit.number };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
