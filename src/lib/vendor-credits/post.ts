import type { PoolClient } from "pg";

import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { pgDateToIso } from "../date/et";

import { VendorCreditError, type PgClient } from "./types";

interface CreditRow {
  id: string;
  status: string;
  number: string | null;
  // pg returns a `date` column as a JS Date (local-midnight parsed) — never
  // a bare string. Read it through `pgDateToIso`, never pass it raw to
  // `assertBankAccountingPeriodOpen` (BANKING_INVALID_ACCOUNTING_DATE).
  credit_date: Date | string;
  total_cents: number;
}

/**
 * draft → posted. The `VC-####` number is assigned at CREATE, not here (see
 * create.ts — same as `vendor_bill` shows `VB-####` while still draft) — this
 * only flips status and locks the period. Lines are already immutable to
 * edits once posted, enforced by the PATCH route refusing non-draft.
 */
export async function markVendorCreditPosted(
  client: PgClient,
  creditId: string,
  actorId: string
): Promise<{ id: string; number: string }> {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query(
      `SELECT id, status, number, credit_date, total_cents FROM vendor_credit
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
    // Creation now allows a draft with ZERO lines (the POS creates the
    // header first, then edits lines via PATCH) — so this is where "at
    // least one line, total > 0" is actually enforced, not at create.
    const { rows: lineCountRows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM vendor_credit_line WHERE credit_id = $1 AND deleted_at IS NULL`,
      [creditId]
    );
    const lineCount = (lineCountRows[0] as { n: number }).n;
    if (lineCount === 0 || !(credit.total_cents > 0)) {
      throw new VendorCreditError("no_lines", "Vendor credit has no lines to post.");
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
