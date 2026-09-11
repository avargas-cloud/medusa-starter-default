import { VendorCreditError, type PgClient } from "./types";

interface CreditRow {
  id: string;
  status: string;
}

/**
 * Soft-deletes a DRAFT credit and its lines (owner rule 2026-09-11: drafts
 * can be discarded; a posted credit is voided, never deleted). Soft, not
 * hard: the `VC-####` number stays consumed and auditable, and the
 * `deleted_at IS NULL` filter every reader already applies releases the PO
 * units the draft was holding (`loadCreditedQtyByPoLine`).
 */
export async function deleteDraftVendorCredit(client: PgClient, creditId: string): Promise<void> {
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
        `Only drafts can be deleted — this credit is ${credit.status}. Void it instead.`,
        409
      );
    }
    await client.query(
      `UPDATE vendor_credit_line SET deleted_at = now() WHERE credit_id = $1 AND deleted_at IS NULL`,
      [creditId]
    );
    await client.query(
      `UPDATE vendor_credit SET deleted_at = now(), updated_at = now() WHERE id = $1`,
      [creditId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
