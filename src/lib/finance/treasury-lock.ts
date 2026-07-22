/**
 * treasury-lock.ts — is a treasury day already confirmed & locked?
 *
 * A day is locked once its distribution has been executed (Confirm & Lock →
 * treasury_distribution_log.executed_at). New money must not silently land
 * on a locked day: its cash would be missing from the confirmed totals
 * forever with a 200 OK (same gate class as the treasury defer-payment
 * locked-day guard).
 */
import { getDbPool } from "../../api/utils/db-pool";

export async function isTreasuryDayLocked(day: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT 1 FROM treasury_distribution_log
      WHERE distribution_date = $1::date AND executed_at IS NOT NULL
      LIMIT 1`,
    [day]
  );
  return rows.length > 0;
}
