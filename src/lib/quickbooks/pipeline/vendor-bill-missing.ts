import { getDbPool } from "../../../api/utils/db-pool";

/**
 * "The QuickBooks Bill this row points at no longer exists."
 *
 * WHY THIS IS ITS OWN TERMINAL OUTCOME, NOT A FAILURE
 *
 * The hourly payment monitor re-elects any linked unpaid bill whose
 * `qb_payment_checked_at` is older than 12 h, and a failed check never advances
 * that stamp. A bill whose QB document was DELETED therefore produces one
 * permanently-failed pipeline row per hour, forever — measured live on bill
 * FTL - 1573151 (adopted mirror, ELA Florida, $1,807.00 open): the accountant
 * deleted it in QuickBooks Desktop and four identical failed rows appeared in the
 * next four hours, each with retries already exhausted.
 *
 * A deleted document never comes back on its own, so retrying is not merely
 * useless — it is the thing generating the noise. The outcome is recorded once
 * (row `skipped`, bill stamped) and reported by the daily digest, so it fails
 * VISIBLE once instead of invisibly every hour.
 *
 * The row is `skipped`, not `failed`, on purpose: nothing about our side failed,
 * and a red Failed badge that no retry can ever clear trains people to ignore the
 * badge.
 */

/**
 * QuickBooks answers a query for a non-existent object with statusCode 500,
 * severity Warn: "There was a required element ("<TxnID>") that could not be
 * found in QuickBooks."
 *
 * The shape below was PROBED against the live bridge rather than written from
 * memory — the status lives under a `$` child, not on the `*Rs` node itself:
 *
 *   { "BillQueryRs": { "$": { "statusCode": "500", "statusSeverity": "Warn",
 *                             "statusMessage": "There was a required element…" } } }
 *
 * Two other placements are accepted because sibling code in this consolidator
 * reads `BillModRs.statusMessage` and `BillModRs["@statusMessage"]`, i.e. this
 * project has seen all three across parser versions. Accepting only the probed
 * one would make the check silently stop matching after a bridge upgrade, and a
 * check that never matches is worse than no check: it is a capability the code
 * claims to have and does not.
 */
export const QB_OBJECT_NOT_FOUND_STATUS_CODE = "500";

type QbStatus = { statusCode?: unknown; statusMessage?: unknown };

function readQbStatus(node: unknown): QbStatus | null {
  if (node == null || typeof node !== "object") return null;
  const rec = node as Record<string, unknown>;
  const dollar = rec["$"];
  if (dollar && typeof dollar === "object") {
    const d = dollar as Record<string, unknown>;
    if (d.statusCode !== undefined) {
      return { statusCode: d.statusCode, statusMessage: d.statusMessage };
    }
  }
  if (rec.statusCode !== undefined) {
    return { statusCode: rec.statusCode, statusMessage: rec.statusMessage };
  }
  if (rec["@statusCode"] !== undefined) {
    return {
      statusCode: rec["@statusCode"],
      statusMessage: rec["@statusMessage"],
    };
  }
  return null;
}

/**
 * True when QuickBooks explicitly reported the queried object as absent.
 *
 * Deliberately narrow: only an explicit statusCode 500 counts. An empty result
 * for any other reason keeps the ordinary retry path, because "QB said it is
 * gone" and "we could not tell" are different facts and only the first one is
 * safe to treat as permanent.
 */
export function isQbObjectNotFound(responseNode: unknown): boolean {
  const status = readQbStatus(responseNode);
  if (!status) return false;
  return String(status.statusCode) === QB_OBJECT_NOT_FOUND_STATUS_CODE;
}

/** The statusMessage QuickBooks returned, for the operator-facing row error. */
export function qbStatusMessage(responseNode: unknown): string | null {
  const status = readQbStatus(responseNode);
  if (!status || status.statusMessage == null) return null;
  return String(status.statusMessage);
}

export type SettleBillMissingResult = {
  rowSettled: boolean;
  billMarked: boolean;
};

/**
 * Records, atomically, that a Vendor Bill's QuickBooks document is gone:
 * settles the pipeline row terminally and stamps the bill so the hourly monitor
 * stops electing it.
 *
 * Both writes share one transaction because they are one fact. Splitting them
 * would allow the state the whole change exists to prevent: a settled row with an
 * unstamped bill, which the next tick clones again.
 *
 * Idempotent: `qb_missing_in_qb_at` is COALESCEd so the FIRST detection time
 * survives re-runs, and the row update is a no-op once the row is terminal.
 */
export async function settleBillMissingInQb(
  rowId: string,
  vendorBillId: string | null,
  reason: string
): Promise<SettleBillMissingResult> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rowRes = await client.query(
      `UPDATE qb_order_pipeline
          SET status        = 'skipped',
              error         = $2,
              next_retry_at = NULL,
              failed_at     = NULL,
              updated_at    = NOW()
        WHERE id = $1
          AND status <> 'confirmed'`,
      [rowId, reason]
    );
    let billMarked = false;
    if (vendorBillId) {
      const billRes = await client.query(
        `UPDATE vendor_bill
            SET qb_missing_in_qb_at   = COALESCE(qb_missing_in_qb_at, NOW()),
                qb_payment_checked_at = NOW(),
                updated_at            = NOW()
          WHERE id = $1
            AND deleted_at IS NULL`,
        [vendorBillId]
      );
      billMarked = (billRes.rowCount ?? 0) > 0;
    }
    await client.query("COMMIT");
    return { rowSettled: (rowRes.rowCount ?? 0) > 0, billMarked };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Clears the marker so the monitor can elect the bill again.
 *
 * Only an explicit human re-check calls this. Nothing clears it automatically:
 * an automatic clear would restore exactly the hourly loop this module removes.
 */
export async function clearBillMissingInQb(vendorBillId: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `UPDATE vendor_bill
        SET qb_missing_in_qb_at = NULL,
            updated_at          = NOW()
      WHERE id = $1
        AND deleted_at IS NULL`,
    [vendorBillId]
  );
}
