import { VendorCreditError, type PgClient } from "./types";

interface AppRow {
  id: string;
  credit_id: string;
  amount_cents: number;
  voided_at: string | null;
}

/** Releases one application: the credit's cache shrinks, the bill's balance grows back. */
export async function voidVendorCreditApplication(
  client: PgClient,
  applicationId: string,
  actorId: string
): Promise<void> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, credit_id, amount_cents, voided_at FROM vendor_credit_application
        WHERE id = $1 FOR UPDATE`,
      [applicationId]
    );
    const app = rows[0] as AppRow | undefined;
    if (!app) throw new VendorCreditError("not_found", "Application not found.", 404);
    if (app.voided_at) {
      throw new VendorCreditError("already_voided", "Application already voided.", 409);
    }

    const { rows: allocRows } = await client.query(
      `SELECT vbpa.id FROM vendor_bill_payment_allocation vbpa
         JOIN vendor_bill_payment p ON p.id = vbpa.payment_id
        WHERE vbpa.credit_application_id = $1 AND p.status = 'posted'`,
      [applicationId]
    );
    if (allocRows.length > 0) {
      throw new VendorCreditError(
        "referenced_by_payment",
        "This application is used by a posted bill payment's SetCredit — void that payment first.",
        409
      );
    }

    await client.query(
      `UPDATE vendor_credit_application SET voided_at = now(), voided_by = $2, updated_at = now()
        WHERE id = $1`,
      [applicationId, actorId]
    );
    await client.query(
      `UPDATE vendor_credit SET applied_cents = GREATEST(applied_cents - $2, 0), updated_at = now()
        WHERE id = $1`,
      [app.credit_id, app.amount_cents]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
