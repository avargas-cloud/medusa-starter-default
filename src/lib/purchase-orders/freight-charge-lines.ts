import { randomUUID } from "crypto";

/**
 * freight-charge-lines.ts
 *
 * §7 of docs/VENDOR_BILL_QB_SYNC_PLAN.md — "Add Freight Charges". A freight
 * charge is a flat, non-landed ExpenseLine added directly to a regular vendor
 * bill (distinct from the `freight_included`/`freight_vendor_bill_id` header
 * concept, which is a LINKED freight bill that feeds landed cost — that stays
 * untouched).
 *
 * Stored as a `vendor_bill_line` with `line_kind='freight_charge'` and
 * `line_type='qb_account'` (the DB CHECK constraint on line_type only allows
 * 'product'|'qb_account' — reusing 'qb_account' is deliberate: it is the
 * value every OTHER non-product-cost-pool line already uses, and it means
 * every pre-existing `line_type='product'`/`COALESCE(line_type,'product')`
 * filter across the codebase (PO qty-cap logic, the confirm route's landed
 * allocation, the drift engine) excludes a freight charge line for free,
 * with zero extra filtering. `line_kind='freight_charge'` is the precise
 * discriminator for code that needs to single these lines out (this module,
 * bill-drift.ts's goods-total exclusion, the confirm route's productLines
 * scoping).
 *
 * `qty` is always 1 and `unit_cost_cents`/`landed_unit_cost_cents` both mirror
 * `amount_cents`, so the charge flows into `total_landed_cents` and
 * `recomputeBillFinanceLinks`'/`syncVeetchBills`' unfiltered
 * `SUM(unit_cost_cents * qty)` exactly like a product line's cost does — a
 * freight charge IS real money owed on this bill (decision D9/§7).
 *
 * Shared by `src/api/admin/vendor-bills/[id]/route.ts` (PATCH), which mirrors
 * this validate-then-reconcile shape for its `freight_lines` field, kept
 * entirely separate from the product-line `lines` field (no PO line, no qty
 * cap — see the route for why they must never share validation).
 */

export interface FreightLineInput {
  id?: string;
  amount_cents: number;
  freight_account_list_id: string;
  description?: string | null;
}

export interface FreightAccount {
  full_name: string;
  account_type: string;
}

type RawKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export interface FreightValidationError {
  status: number;
  body: { error: string; code: string };
}

export type FreightValidationResult =
  | {
      ok: true;
      existingIds: Set<string>;
      accountByListId: Map<string, FreightAccount>;
    }
  | { ok: false; error: FreightValidationError };

/**
 * Validates a staged `freight_lines[]` set: every `id` must belong to this
 * bill's existing freight charge lines, and every `freight_account_list_id`
 * must resolve to an active, freight-type QB account (same
 * CostOfGoodsSold + "freight and shipping costs" rule as the pre-existing
 * account-lines route's `accountAllowedForBillType`).
 */
export async function validateFreightLines(
  knex: RawKnex,
  vendorBillId: string,
  lines: FreightLineInput[]
): Promise<FreightValidationResult> {
  const flResult = await knex.raw(
    `SELECT id FROM vendor_bill_line
      WHERE vendor_bill_id = ? AND deleted_at IS NULL AND line_kind = 'freight_charge'`,
    [vendorBillId]
  );
  const existingIds = new Set(
    (flResult.rows as Array<{ id: string }>).map((r) => r.id)
  );

  for (const l of lines) {
    if (l.id && !existingIds.has(l.id)) {
      return {
        ok: false,
        error: {
          status: 404,
          body: {
            error: `Freight charge line ${l.id} not found on this bill`,
            code: "freight_line_not_found",
          },
        },
      };
    }
  }

  const accountByListId = new Map<string, FreightAccount>();
  const distinctAccountIds = [
    ...new Set(lines.map((l) => l.freight_account_list_id)),
  ];
  if (distinctAccountIds.length > 0) {
    const accountsResult = await knex.raw(
      `SELECT qb_list_id, full_name, account_type
         FROM qb_account
        WHERE qb_list_id = ANY(?) AND is_active = true AND deleted_at IS NULL`,
      [distinctAccountIds]
    );
    for (const r of accountsResult.rows as Array<{
      qb_list_id: string;
      full_name: string;
      account_type: string;
    }>) {
      accountByListId.set(r.qb_list_id, {
        full_name: r.full_name,
        account_type: r.account_type,
      });
    }
  }

  for (const l of lines) {
    const acct = accountByListId.get(l.freight_account_list_id);
    if (!acct) {
      return {
        ok: false,
        error: {
          status: 422,
          body: {
            error: "Unknown QuickBooks account for freight charge",
            code: "freight_account_not_found",
          },
        },
      };
    }
    const fn = acct.full_name.toLowerCase();
    const isFreightAccount =
      acct.account_type === "CostOfGoodsSold" &&
      fn.startsWith("freight and shipping costs");
    if (!isFreightAccount) {
      return {
        ok: false,
        error: {
          status: 422,
          body: {
            error: `Account '${acct.full_name}' is not a valid freight account`,
            code: "freight_account_not_allowed",
          },
        },
      };
    }
  }

  return { ok: true, existingIds, accountByListId };
}

/**
 * Reconciles the full desired `freight_lines[]` set against the bill's
 * existing freight charge lines (add / update / remove by id — same "full
 * desired set" pattern as the product `lines` field). MUST be called inside
 * the caller's transaction alongside the rest of the header + line writes.
 */
export async function reconcileFreightLines(
  db: RawKnex,
  vendorBillId: string,
  lines: FreightLineInput[],
  existingIds: Set<string>,
  accountByListId: Map<string, FreightAccount>
): Promise<void> {
  const keepIds = new Set(lines.filter((l) => l.id).map((l) => l.id as string));
  const toRemove = [...existingIds].filter((existingId) => !keepIds.has(existingId));
  if (toRemove.length > 0) {
    await db.raw(
      `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
      [toRemove, vendorBillId]
    );
  }

  for (const l of lines) {
    const acct = accountByListId.get(l.freight_account_list_id)!;
    const description = l.description?.trim() || acct.full_name;

    if (l.id) {
      await db.raw(
        `UPDATE vendor_bill_line
            SET amount_cents = ?, unit_cost_cents = ?, landed_unit_cost_cents = ?,
                freight_account_list_id = ?, qb_account_list_id = ?,
                qb_account_full_name = ?, qb_account_type = ?, description = ?,
                updated_at = NOW()
          WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL AND line_kind = 'freight_charge'`,
        [
          l.amount_cents,
          l.amount_cents,
          l.amount_cents,
          l.freight_account_list_id,
          l.freight_account_list_id,
          acct.full_name,
          acct.account_type,
          description,
          l.id,
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
           landed_unit_cost_cents, freight_account_list_id, amount_cents,
           created_at, updated_at)
         VALUES (?, ?, NULL, NULL, 'qb_account', 'freight_charge', ?, ?, ?, NULL, 'FREIGHT', NULL, ?, 1, ?, NULL, 0, 0, 0, ?, ?, ?, NOW(), NOW())`,
        [
          `vbl_${randomUUID().replace(/-/g, "")}`,
          vendorBillId,
          l.freight_account_list_id,
          acct.full_name,
          acct.account_type,
          description,
          l.amount_cents,
          l.amount_cents,
          l.freight_account_list_id,
          l.amount_cents,
        ]
      );
    }
  }
}
