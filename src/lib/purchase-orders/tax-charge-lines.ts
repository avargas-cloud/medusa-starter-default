import { randomUUID } from "crypto";

/**
 * tax-charge-lines.ts
 *
 * Sales tax a vendor charged on a purchase invoice (US vendors that bill us
 * tax instead of honouring a resale certificate — e.g. Parts Express on
 * PO-1029: $184.26 goods + $12.90 tax = $197.16).
 *
 * WHY A LINE AND NOT JUST A HEADER FIELD
 * `vendor_bill.tax_amount_cents` is the operator-facing field: one amount
 * copied off the vendor document, read back in the POS totals footer the way
 * QuickBooks presents it. But QBXML `BillAdd` has NO header tax field — its
 * only slots are ExpenseLineAdd / ItemLineAdd. So the tax has to reach QB as a
 * line either way, and once it is a line in QB it needs a `TxnLineID` we can
 * retain: `BillMod` DELETES BY OMISSION, so a tax line we could not name by
 * its TxnLineID would be dropped (or silently duplicated) on the first edit.
 * Materializing it as a real `vendor_bill_line` makes it inherit the existing
 * TxnLineID persistence, Mod retention and QB payload paths for free.
 *
 * SHAPE (mirrors freight-charge-lines.ts, with two deliberate differences)
 *   line_type = 'qb_account'  → every `line_type='product'` filter in the
 *                               codebase excludes it from landed-cost INPUTS
 *                               for free (same trick freight charges use).
 *   line_kind = 'tax_charge'  → the precise discriminator for code that must
 *                               single tax out (the drift engine's goods
 *                               total, the POS items table).
 *   unit_cost_cents = amount  → the tax IS real money owed on this bill, so it
 *                               must flow into `recomputeBillFinanceLinks`'
 *                               unfiltered SUM(unit_cost_cents × qty).
 *   landed_unit_cost_cents = 0 → UNLIKE a freight charge. The tax is already
 *                               capitalized into the product lines through the
 *                               landed `taxCents` pool; giving this line a
 *                               non-zero landed value would count the same
 *                               $12.90 twice in `total_landed_cents`.
 *
 * There is at most ONE tax charge line per bill: the vendor document states a
 * single tax total, so a set-shaped API would only invite drift from it.
 */

/**
 * QB account the tax posts to. A CostOfGoodsSold sibling of `Freight and
 * Shipping Costs` / `Duties`, so QuickBooks' P&L agrees with our decision to
 * capitalize the tax into average_cost. Resolved by name (never hardcoded by
 * ListID) so the account can be created in QB Desktop and picked up by the
 * next `POST /admin/qb-catalog/accounts/sync` without a code change.
 */
export const TAX_ACCOUNT_FULL_NAME = "Sales Tax Paid";
const TAX_ACCOUNT_TYPE = "CostOfGoodsSold";

type RawKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface TaxAccount {
  qb_list_id: string;
  full_name: string;
  account_type: string;
}

export interface TaxValidationError {
  status: number;
  body: { error: string; code: string };
}

export type TaxValidationResult =
  | { ok: true; account: TaxAccount | null }
  | { ok: false; error: TaxValidationError };

/**
 * Resolves the sales-tax COGS account. Returns `ok` with a null account when
 * the bill carries no tax (nothing to resolve); fails closed when there IS tax
 * but the account does not exist yet, because a bill saved with tax but no
 * account would later be refused by the QB enqueue anyway — better to say so
 * at save time, where the operator can act on it.
 */
export async function validateTaxCharge(
  knex: RawKnex,
  taxAmountCents: number
): Promise<TaxValidationResult> {
  if (!Number.isInteger(taxAmountCents) || taxAmountCents < 0) {
    return {
      ok: false,
      error: {
        status: 422,
        body: {
          error: "Sales tax must be a whole, non-negative amount of cents",
          code: "tax_amount_invalid",
        },
      },
    };
  }
  if (taxAmountCents === 0) return { ok: true, account: null };

  const result = await knex.raw(
    `SELECT qb_list_id, full_name, account_type
       FROM qb_account
      WHERE full_name = ? AND is_active = true AND deleted_at IS NULL
      LIMIT 1`,
    [TAX_ACCOUNT_FULL_NAME]
  );
  const account = (result.rows[0] ?? null) as TaxAccount | null;
  if (!account) {
    return {
      ok: false,
      error: {
        status: 422,
        body: {
          error:
            `QuickBooks account "${TAX_ACCOUNT_FULL_NAME}" does not exist yet. ` +
            `Create it in QuickBooks Desktop as a ${TAX_ACCOUNT_TYPE} account, ` +
            `then run Settings → QuickBooks Sync → Resync Accounts.`,
          code: "tax_account_not_found",
        },
      },
    };
  }
  if (account.account_type !== TAX_ACCOUNT_TYPE) {
    return {
      ok: false,
      error: {
        status: 422,
        body: {
          error:
            `QuickBooks account "${TAX_ACCOUNT_FULL_NAME}" is a ` +
            `${account.account_type} account; it must be ${TAX_ACCOUNT_TYPE} so ` +
            `the tax lands in cost of goods, not in a period expense.`,
          code: "tax_account_wrong_type",
        },
      },
    };
  }
  return { ok: true, account };
}

/**
 * Reconciles the bill's single `tax_charge` line against the header amount:
 * inserts it, updates it, or soft-deletes it when the tax drops to zero. Also
 * snapshots the resolved ListID on the bill so a later chart-of-accounts
 * rename can never silently retarget an already-saved bill.
 *
 * Call INSIDE the save transaction, after the header amount is persisted.
 */
export async function reconcileTaxChargeLine(
  db: RawKnex,
  vendorBillId: string,
  taxAmountCents: number,
  account: TaxAccount | null
): Promise<void> {
  const existingResult = await db.raw(
    `SELECT id FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL AND line_kind = 'tax_charge'
      ORDER BY created_at ASC`,
    [vendorBillId]
  );
  const existingIds = (existingResult.rows as Array<{ id: string }>).map(
    (r) => r.id
  );

  if (taxAmountCents === 0 || !account) {
    if (existingIds.length > 0) {
      await db.raw(
        `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
        [existingIds, vendorBillId]
      );
    }
    await db.raw(
      `UPDATE vendor_bill SET tax_account_list_id = NULL, updated_at = NOW()
        WHERE id = ?`,
      [vendorBillId]
    );
    return;
  }

  // Defensive: a bill should never hold more than one tax line, but if a
  // legacy/concurrent write produced extras, collapse onto the oldest so the
  // QB TxnLineID already recorded against it survives.
  const keepId = existingIds[0];
  if (existingIds.length > 1) {
    await db.raw(
      `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
      [existingIds.slice(1), vendorBillId]
    );
  }

  if (keepId) {
    await db.raw(
      `UPDATE vendor_bill_line
          SET amount_cents = ?, unit_cost_cents = ?, landed_unit_cost_cents = 0,
              qb_account_list_id = ?, qb_account_full_name = ?,
              qb_account_type = ?, description = ?, updated_at = NOW()
        WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL
          AND line_kind = 'tax_charge'`,
      [
        taxAmountCents,
        taxAmountCents,
        account.qb_list_id,
        account.full_name,
        account.account_type,
        account.full_name,
        keepId,
        vendorBillId,
      ]
    );
  } else {
    await db.raw(
      `INSERT INTO vendor_bill_line (
         id, vendor_bill_id, receipt_line_id, purchase_order_line_id, line_type, line_kind,
         qb_account_list_id, qb_account_full_name, qb_account_type,
         product_variant_id, sku, mpn, description, qty, unit_cost_cents, cbm_per_unit,
         commission_per_unit_cents, freight_per_unit_cents, tariff_per_unit_cents,
         tax_per_unit_cents, landed_unit_cost_cents, freight_account_list_id, amount_cents,
         created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'qb_account', 'tax_charge', ?, ?, ?, NULL, 'SALESTAX',
               NULL, ?, 1, ?, NULL, 0, 0, 0, 0, 0, NULL, ?, NOW(), NOW())`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`,
        vendorBillId,
        account.qb_list_id,
        account.full_name,
        account.account_type,
        account.full_name,
        taxAmountCents,
        taxAmountCents,
      ]
    );
  }

  await db.raw(
    `UPDATE vendor_bill SET tax_account_list_id = ?, updated_at = NOW()
      WHERE id = ?`,
    [account.qb_list_id, vendorBillId]
  );
}
