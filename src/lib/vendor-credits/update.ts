import { generateEntityId } from "@medusajs/utils";

import { VendorCreditError, type PgClient, type VendorCreditLineInput } from "./types";

interface CreditRow {
  id: string;
  status: string;
}

/**
 * Replaces the lines of a DRAFT credit (delete + reinsert — the same
 * approach vendor bill drafts use before confirm; there is no revision
 * history to preserve pre-post). Refuses on any non-draft status.
 */
export async function updateDraftVendorCredit(
  client: PgClient,
  creditId: string,
  patch: {
    credit_date?: string;
    reason?: string | null;
    memo?: string | null;
    lines?: VendorCreditLineInput[];
  }
): Promise<void> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status FROM vendor_credit WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
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

    if (patch.lines) {
      // ZERO lines is a valid draft state — `post` enforces ≥1 line
      // (`no_lines`), not PATCH. Full-replace semantics unchanged: every
      // call with `lines` present deletes and reinserts the whole set.
      await client.query(
        `UPDATE vendor_credit_line SET deleted_at = now() WHERE credit_id = $1 AND deleted_at IS NULL`,
        [creditId]
      );
      let sort = 0;
      let total = 0;
      for (const line of patch.lines) {
        if (!(line.amount_cents > 0)) {
          throw new VendorCreditError("invalid_line_amount", "Every line must have amount_cents > 0.");
        }
        total += line.amount_cents;
        const lineId = generateEntityId("", "vcrl");
        await client.query(
          `INSERT INTO vendor_credit_line
             (id, credit_id, sort, line_type, variant_id, sku, description, qty, unit_cost_cents,
              qb_account_list_id, amount_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            lineId,
            creditId,
            sort++,
            line.line_type,
            line.variant_id ?? null,
            line.sku ?? null,
            line.description ?? null,
            line.qty ?? null,
            line.unit_cost_cents ?? null,
            line.qb_account_list_id ?? null,
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
