import { generateEntityId } from "@medusajs/utils";

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
  status: string;
  vendor_id: string;
  purchase_order_id: string | null;
}

/**
 * Replaces the lines of a DRAFT credit (delete + reinsert — the same
 * approach vendor bill drafts use before confirm; there is no revision
 * history to preserve pre-post). Refuses on any non-draft status.
 *
 * The PO is NOT patchable (fixed at create); `vendor_bill_id` is, and must
 * be a confirmed regular bill of that PO (`null` unlinks it).
 */
export async function updateDraftVendorCredit(
  client: PgClient,
  creditId: string,
  patch: {
    credit_date?: string;
    reason?: string | null;
    memo?: string | null;
    vendor_bill_id?: string | null;
    lines?: VendorCreditLineInput[];
  }
): Promise<void> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status, vendor_id, purchase_order_id FROM vendor_credit
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

    if (patch.credit_date !== undefined) {
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
      await client.query(
        `UPDATE vendor_credit SET vendor_bill_id = $2, updated_at = now() WHERE id = $1`,
        [creditId, patch.vendor_bill_id]
      );
    }

    if (patch.lines) {
      // Owner rule (2026-09-11): the last line cannot be removed — an empty
      // credit is never persisted, draft or not (`no_lines`). Full-replace
      // semantics: every call with `lines` deletes and reinserts the set.
      assertLineShapes(patch.lines);
      let lines = patch.lines;
      if (credit.purchase_order_id) {
        const po = await loadPoForCredit(client, credit.purchase_order_id);
        if (!po) throw new VendorCreditError("po_not_found", "Purchase order not found.", 404);
        const credited = await loadCreditedQtyByPoLine(client, po.id, creditId);
        lines = validateProductLinesAgainstPo(lines, po, credited);
      } else {
        assertNoProductLinesWithoutPo(lines);
      }

      await client.query(
        `UPDATE vendor_credit_line SET deleted_at = now() WHERE credit_id = $1 AND deleted_at IS NULL`,
        [creditId]
      );
      // Exactly like create.ts: resolve every qb_account line's snapshot by
      // list id (active accounts only), fail closed on anything that
      // doesn't resolve — a PATCH must not persist a `qb_account` line with
      // a stale/unknown account and a null full_name/type.
      const accountByListId = await resolveQbAccountsByListId(
        client,
        lines.map((l) => l.qb_account_list_id).filter((v): v is string => !!v)
      );
      const resolvedLines = await resolveMpnDefaults(client, lines);
      let sort = 0;
      let total = 0;
      for (const line of resolvedLines) {
        total += line.amount_cents;
        const lineId = generateEntityId("", "vcrl");
        const account = line.qb_account_list_id ? accountByListId.get(line.qb_account_list_id) : null;
        await client.query(
          `INSERT INTO vendor_credit_line
             (id, credit_id, sort, line_type, variant_id, purchase_order_line_id, sku, mpn, description, qty,
              unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type, amount_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
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
          ]
        );
      }
      await client.query(`UPDATE vendor_credit SET total_cents = $2, updated_at = now() WHERE id = $1`, [
        creditId,
        total,
      ]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
