import { generateEntityId } from "@medusajs/utils";
import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { pgDateToIso } from "../date/et";

import { assertLineShapes } from "./create";
import { resolveMpnDefaults } from "./mpn-default";
import {
  assertBillBelongsToPo,
  assertNoProductLinesWithoutPo,
  loadCreditedQtyByPoLine,
  loadPoForCredit,
  validateProductLinesAgainstPo,
} from "./po-link";
import { resolveQbAccountsByListId } from "./qb-account-lookup";
import { VendorCreditError, type PgClient, type VendorCreditLineInput } from "./types";

interface CreditRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string;
  purchase_order_id: string | null;
  credit_date: Date | string;
  applied_cents: number | string;
  stock_applied_at: Date | string | null;
}

interface StoredLine {
  id: string;
  line_type: "product" | "qb_account";
  purchase_order_line_id: string | null;
  qb_account_list_id: string | null;
  qty: number | null;
  qb_txn_line_id: string | null;
}

export interface ReviseVendorCreditPatch {
  credit_date?: string;
  reason?: string | null;
  memo?: string | null;
  vendor_bill_id?: string | null;
  lines?: VendorCreditLineInput[];
}

export interface ReviseStockDelta {
  purchase_order_line_id: string;
  inventory_item_id: string;
  sku: string | null;
  /** New qty − old qty on that PO line (signed). */
  delta: number;
}

export interface ReviseResult {
  id: string;
  number: string | null;
  /** Only present when `lines` changed; empty when no product qty moved. */
  stockDeltas: ReviseStockDelta[];
  stockLocationId: string | null;
  linesChanged: boolean;
}

/**
 * Revises a POSTED credit in place (plan `vc-edit-mod-20260911`). Same
 * validations as a draft PATCH plus the ones a live document needs:
 *   - status must be `posted` (voided never; drafts use PATCH);
 *   - new total ≥ Σ active applications (`exceeds_applications`, 409) — a
 *     credit cannot shrink below what bills already consumed;
 *   - accounting period open for the old AND the new date;
 *   - the PO is fixed; product lines re-validated against received units
 *     excluding this credit; no product line without PO.
 * Lines are replaced (soft-delete + reinsert) but each new line INHERITS the
 * `qb_txn_line_id` of the old line it replaces (matched by PO line for
 * products, by account for account lines) so the QuickBooks Mod updates
 * instead of recreating. Returns the per-PO-line stock deltas the caller
 * applies through the Inventory module — never SQL on inventory_level.
 */
export async function reviseVendorCredit(
  client: PgClient,
  creditId: string,
  patch: ReviseVendorCreditPatch,
  actorId: string
): Promise<ReviseResult> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, number, status, vendor_id, purchase_order_id, credit_date, applied_cents, stock_applied_at
         FROM vendor_credit WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [creditId]
    );
    const credit = rows[0] as CreditRow | undefined;
    if (!credit) throw new VendorCreditError("not_found", "Vendor credit not found.", 404);
    if (credit.status !== "posted") {
      throw new VendorCreditError(
        "invalid_status",
        `Only a posted vendor credit can be revised — this one is ${credit.status}.`,
        409
      );
    }
    await assertBankAccountingPeriodOpen(client as unknown as PoolClient, pgDateToIso(credit.credit_date));
    if (patch.credit_date !== undefined) {
      await assertBankAccountingPeriodOpen(client as unknown as PoolClient, patch.credit_date);
      await client.query(`UPDATE vendor_credit SET credit_date = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        patch.credit_date,
      ]);
    }
    if (patch.reason !== undefined) {
      await client.query(`UPDATE vendor_credit SET reason = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        patch.reason,
      ]);
    }
    if (patch.memo !== undefined) {
      await client.query(`UPDATE vendor_credit SET memo = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        patch.memo,
      ]);
    }
    if (patch.vendor_bill_id !== undefined) {
      if (patch.vendor_bill_id) {
        if (!credit.purchase_order_id) {
          throw new VendorCreditError(
            "bill_requires_po",
            "A related bill can only be named on a credit linked to a purchase order."
          );
        }
        await assertBillBelongsToPo(client, patch.vendor_bill_id, credit.purchase_order_id);
      }
      await client.query(`UPDATE vendor_credit SET vendor_bill_id = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        patch.vendor_bill_id,
      ]);
    }

    const stockDeltas: ReviseStockDelta[] = [];
    let stockLocationId: string | null = null;
    let linesChanged = false;

    if (patch.lines) {
      linesChanged = true;
      assertLineShapes(patch.lines);
      let lines = patch.lines;
      const { rows: oldRows } = await client.query(
        `SELECT id, line_type, purchase_order_line_id, qb_account_list_id, qty, qb_txn_line_id
           FROM vendor_credit_line WHERE credit_id = $1 AND deleted_at IS NULL ORDER BY sort`,
        [creditId]
      );
      const oldLines = oldRows as StoredLine[];

      let po = null;
      if (credit.purchase_order_id) {
        po = await loadPoForCredit(client, credit.purchase_order_id);
        if (!po) throw new VendorCreditError("po_not_found", "Purchase order not found.", 404);
        const credited = await loadCreditedQtyByPoLine(client, po.id, creditId);
        lines = validateProductLinesAgainstPo(lines, po, credited);
        stockLocationId = po.stock_location_id;
      } else {
        assertNoProductLinesWithoutPo(lines);
      }

      const newTotal = lines.reduce((sum, l) => sum + l.amount_cents, 0);
      const applied = Number(credit.applied_cents ?? 0);
      if (newTotal < applied) {
        throw new VendorCreditError(
          "exceeds_applications",
          `The revised total (${newTotal}) is below what is already applied to bills (${applied}). Unapply first.`,
          409
        );
      }

      // Stock deltas per PO line (only meaningful once stock was applied).
      if (po && credit.stock_applied_at) {
        const oldQty = new Map<string, number>();
        for (const l of oldLines) {
          if (l.line_type === "product" && l.purchase_order_line_id) {
            oldQty.set(l.purchase_order_line_id, (oldQty.get(l.purchase_order_line_id) ?? 0) + Number(l.qty ?? 0));
          }
        }
        const newQty = new Map<string, number>();
        for (const l of lines) {
          if (l.line_type === "product" && l.purchase_order_line_id) {
            newQty.set(l.purchase_order_line_id, (newQty.get(l.purchase_order_line_id) ?? 0) + Number(l.qty ?? 0));
          }
        }
        for (const poLineId of new Set([...oldQty.keys(), ...newQty.keys()])) {
          const delta = (newQty.get(poLineId) ?? 0) - (oldQty.get(poLineId) ?? 0);
          if (delta === 0) continue;
          const ref = po.lines.get(poLineId);
          if (!ref) continue;
          stockDeltas.push({
            purchase_order_line_id: poLineId,
            inventory_item_id: ref.inventory_item_id,
            sku: ref.sku_snapshot,
            delta,
          });
        }
      }

      // Inherit QB line ids: product ↔ same PO line; account ↔ same account (first unused).
      const productIds = new Map<string, string>();
      const accountIds = new Map<string, string[]>();
      for (const l of oldLines) {
        if (!l.qb_txn_line_id) continue;
        if (l.line_type === "product" && l.purchase_order_line_id) productIds.set(l.purchase_order_line_id, l.qb_txn_line_id);
        if (l.line_type === "qb_account" && l.qb_account_list_id) {
          const arr = accountIds.get(l.qb_account_list_id) ?? [];
          arr.push(l.qb_txn_line_id);
          accountIds.set(l.qb_account_list_id, arr);
        }
      }

      const accountByListId = await resolveQbAccountsByListId(
        client,
        lines.map((l) => l.qb_account_list_id).filter((v): v is string => !!v)
      );
      const resolvedLines = await resolveMpnDefaults(client, lines);
      await client.query(
        `UPDATE vendor_credit_line SET deleted_at = now() WHERE credit_id = $1 AND deleted_at IS NULL`,
        [creditId]
      );
      let sort = 0;
      for (const line of resolvedLines) {
        const lineId = generateEntityId("", "vcrl");
        const account = line.qb_account_list_id ? accountByListId.get(line.qb_account_list_id) : null;
        let inherited: string | null = null;
        if (line.line_type === "product" && line.purchase_order_line_id) {
          inherited = productIds.get(line.purchase_order_line_id) ?? null;
          productIds.delete(line.purchase_order_line_id);
        } else if (line.line_type === "qb_account" && line.qb_account_list_id) {
          inherited = accountIds.get(line.qb_account_list_id)?.shift() ?? null;
        }
        await client.query(
          `INSERT INTO vendor_credit_line
             (id, credit_id, sort, line_type, variant_id, purchase_order_line_id, sku, mpn, description, qty,
              unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents, qb_txn_line_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            lineId,
            creditId,
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
            inherited,
          ]
        );
      }
      await client.query(`UPDATE vendor_credit SET total_cents = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        newTotal,
      ]);
    }

    await client.query(
      `UPDATE vendor_credit SET revised_at = now(), updated_at = now() WHERE id = $1`,
      [creditId]
    );
    await client.query("COMMIT");
    void actorId;
    return { id: creditId, number: credit.number, stockDeltas, stockLocationId, linesChanged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
