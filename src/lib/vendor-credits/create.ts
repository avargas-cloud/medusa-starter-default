import { generateEntityId } from "@medusajs/utils";

import { resolveMpnDefaults } from "./mpn-default";
import { nextVendorCreditNumber } from "./numbering";
import {
  assertBillBelongsToPo,
  assertNoProductLinesWithoutPo,
  loadAndAssertPoForVendor,
  loadCreditedQtyByPoLine,
  validateProductLinesAgainstPo,
} from "./po-link";
import { resolveQbAccountsByListId } from "./qb-account-lookup";
import { VendorCreditError, type CreateVendorCreditInput, type PgClient } from "./types";

interface VendorRow {
  id: string;
  full_name: string;
  qb_list_id: string;
}

/** Shared by create/update: shape checks that need no DB. */
export function assertLineShapes(lines: CreateVendorCreditInput["lines"]): void {
  // Owner rule (2026-09-11): a credit with no lines is never saved — not as a
  // draft either. The POS collects PO + lines locally and only then creates.
  if (lines.length === 0) {
    throw new VendorCreditError("no_lines", "A vendor credit needs at least one line.");
  }
  for (const line of lines) {
    if (!(line.amount_cents > 0)) {
      throw new VendorCreditError("invalid_line_amount", "Every line must have amount_cents > 0.");
    }
    if (line.line_type === "qb_account" && !line.qb_account_list_id) {
      throw new VendorCreditError(
        "missing_qb_account",
        "A qb_account line needs qb_account_list_id."
      );
    }
  }
}

/**
 * Draft creation — no GL, no QB, no period lock (those apply at `post`).
 * `total_cents` is the live sum of lines; it is NOT frozen until posted.
 *
 * The `VC-####` NUMBER, unlike the total, IS assigned here — same as
 * `vendor_bill` shows its `VB-####` while still draft. `post` no longer
 * touches `number` (see post.ts).
 *
 * PO link (plan `vc-po-return-20260911`): with `purchase_order_id`, every
 * product line names a PO line and stays within what was received on it
 * (`po-link.ts`); without one, product lines are refused. The PO is fixed
 * here for the life of the credit; `vendor_bill_id` may change while draft.
 */
export async function createDraftVendorCredit(
  client: PgClient,
  input: CreateVendorCreditInput
): Promise<{ id: string; number: string }> {
  assertLineShapes(input.lines);

  const { rows: vendorRows } = await client.query(
    `SELECT id, full_name, qb_list_id FROM qb_vendor WHERE id = $1 AND deleted_at IS NULL`,
    [input.vendor_id]
  );
  const vendor = vendorRows[0] as VendorRow | undefined;
  if (!vendor) {
    throw new VendorCreditError("vendor_not_found", "Vendor not found.", 404);
  }

  const poId = input.purchase_order_id ?? null;
  const billId = input.vendor_bill_id ?? null;
  let lines = input.lines;
  if (poId) {
    const po = await loadAndAssertPoForVendor(client, poId, vendor.id);
    const credited = await loadCreditedQtyByPoLine(client, poId, null);
    lines = validateProductLinesAgainstPo(lines, po, credited);
    if (billId) await assertBillBelongsToPo(client, billId, poId);
  } else {
    assertNoProductLinesWithoutPo(lines);
    if (billId) {
      throw new VendorCreditError(
        "bill_requires_po",
        "A related bill can only be named on a credit linked to a purchase order."
      );
    }
  }

  const accountByListId = await resolveQbAccountsByListId(
    client,
    lines.map((l) => l.qb_account_list_id).filter((v): v is string => !!v)
  );

  const totalCents = lines.reduce((sum, l) => sum + l.amount_cents, 0);
  const id = generateEntityId("", "vcr");
  const resolvedLines = await resolveMpnDefaults(client, lines);

  await client.query("BEGIN");
  let number: string;
  try {
    number = await nextVendorCreditNumber(client);
    await client.query(
      `INSERT INTO vendor_credit
         (id, number, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
          purchase_order_id, vendor_bill_id,
          credit_date, reason, memo, status, total_cents, applied_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,0)`,
      [
        id,
        number,
        vendor.id,
        vendor.full_name,
        vendor.qb_list_id,
        poId,
        billId,
        input.credit_date,
        input.reason ?? null,
        input.memo ?? null,
        totalCents,
      ]
    );

    let sort = 0;
    for (const line of resolvedLines) {
      const lineId = generateEntityId("", "vcrl");
      const account = line.qb_account_list_id ? accountByListId.get(line.qb_account_list_id) : null;
      await client.query(
        `INSERT INTO vendor_credit_line
           (id, credit_id, sort, line_type, variant_id, purchase_order_line_id, sku, mpn, description, qty,
            unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          lineId,
          id,
          sort++,
          line.line_type,
          line.variant_id ?? null,
          line.line_type === "product" ? (line.purchase_order_line_id ?? null) : null,
          line.sku ?? null,
          line.mpn ?? null,
          line.description ?? null,
          line.qty ?? null,
          line.unit_cost_cents ?? null,
          line.qb_account_list_id ?? null,
          account?.full_name ?? null,
          account?.account_type ?? null,
          line.amount_cents,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  return { id, number };
}
