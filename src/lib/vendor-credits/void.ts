import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { pgDateToIso } from "../date/et";

import { VendorCreditError, type PgClient } from "./types";

interface CreditRow {
  id: string;
  status: string;
  // pg `date` column → JS Date (local-midnight). See post.ts's note.
  credit_date: Date | string;
}

/**
 * Voids the whole credit. Refuses while it still has active applications —
 * those release individually first (`/applications/:id/void`), same
 * discipline as a bill payment's allocations: a void never silently drags
 * dependents with it.
 */
export async function voidVendorCredit(
  client: PgClient,
  creditId: string,
  actorId: string,
  reason?: string | null
): Promise<void> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status, credit_date FROM vendor_credit WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [creditId]
    );
    const credit = rows[0] as CreditRow | undefined;
    if (!credit) throw new VendorCreditError("not_found", "Vendor credit not found.", 404);
    if (credit.status !== "posted") {
      throw new VendorCreditError(
        "invalid_status",
        `Vendor credit is ${credit.status}, expected posted.`,
        409
      );
    }

    const { rows: activeApps } = await client.query(
      `SELECT id FROM vendor_credit_application WHERE credit_id = $1 AND voided_at IS NULL`,
      [creditId]
    );
    if (activeApps.length > 0) {
      throw new VendorCreditError(
        "has_active_applications",
        "Void every application of this credit before voiding it.",
        409
      );
    }

    await assertBankAccountingPeriodOpen(
      client as unknown as PoolClient,
      pgDateToIso(credit.credit_date)
    );

    await client.query(
      `UPDATE vendor_credit SET status='voided', voided_at=now(), voided_by=$2, voided_reason=$3, updated_at=now()
        WHERE id=$1`,
      [creditId, actorId, reason ?? null]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
