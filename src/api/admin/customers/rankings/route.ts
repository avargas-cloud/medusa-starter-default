import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Client } from "pg";

/**
 * GET /admin/customers/rankings?by=ar|balance&dir=desc|asc&limit=100
 *
 * Returns top N customers ranked by Open AR or Net Balance across ALL customers.
 * Used by the /customers page when the user sorts by AR or Balance — client-side
 * sort only covers the 100 loaded, this covers the entire database.
 *
 * Response: { rankings: [{ customer_id, ar, balance }] }
 *
 * Units: all values in USD (dollars).
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const by = (req.query.by as string) ?? "ar";
  const dir = (req.query.dir as string) === "asc" ? "ASC" : "DESC";
  const limit = Math.min(
    parseInt((req.query.limit as string) ?? "100", 10),
    500
  );

  if (!["ar", "balance"].includes(by)) {
    res.status(400).json({ error: 'by must be "ar" or "balance"' });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // AR per customer: sum of unpaid pos_invoice.balance_due (cents → dollars)
    const arResult = await client.query<{ customer_id: string; ar: string }>(
      `SELECT
                o.customer_id,
                COALESCE(SUM(pi.balance_due), 0) / 100.0 AS ar
             FROM pos_invoice pi
             JOIN "order" o ON o.id = pi.order_id
             WHERE pi.status NOT IN ('paid', 'voided')
               AND pi.deleted_at IS NULL
               AND pi.balance_due > 0
             GROUP BY o.customer_id`
    );

    // Unapplied payment credit per customer (cents → dollars)
    const creditResult = await client.query<{
      customer_id: string;
      credit: string;
    }>(
      `SELECT
                cp.customer_id,
                COALESCE(SUM(
                    cp.amount - COALESCE(
                        (SELECT SUM(pa.amount_applied)
                         FROM payment_application pa
                         WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL),
                        0
                    )
                ), 0) / 100.0 AS credit
             FROM customer_payment cp
             WHERE cp.status IN ('available', 'partially_applied')
               AND cp.deleted_at IS NULL
             GROUP BY cp.customer_id`
    );

    // Manual ledger credits (dollars)
    const ledgerResult = await client.query<{
      customer_id: string;
      ledger: string;
    }>(
      `SELECT
                customer_id,
                COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS ledger
             FROM customer_credit_ledger
             GROUP BY customer_id`
    );

    // Merge into a map
    const arMap: Record<string, number> = {};
    for (const row of arResult.rows)
      arMap[row.customer_id] = parseFloat(row.ar);

    const creditMap: Record<string, number> = {};
    for (const row of creditResult.rows)
      creditMap[row.customer_id] = parseFloat(row.credit);

    const ledgerMap: Record<string, number> = {};
    for (const row of ledgerResult.rows)
      ledgerMap[row.customer_id] = parseFloat(row.ledger);

    // Collect all customer IDs that have any non-zero value
    const allIds = new Set([
      ...Object.keys(arMap),
      ...Object.keys(creditMap),
      ...Object.keys(ledgerMap),
    ]);

    const rankings: { customer_id: string; ar: number; balance: number }[] = [];
    for (const id of allIds) {
      const ar = arMap[id] ?? 0;
      const credit = (creditMap[id] ?? 0) + (ledgerMap[id] ?? 0);
      const balance = credit - ar;
      if (ar !== 0 || balance !== 0) {
        rankings.push({ customer_id: id, ar, balance });
      }
    }

    // Sort and slice
    rankings.sort((a, b) => {
      const val = by === "ar" ? a.ar - b.ar : a.balance - b.balance;
      return dir === "DESC" ? -val : val;
    });

    res.json({ rankings: rankings.slice(0, limit) });
  } catch (err: any) {
    console.error("[CUSTOMER-RANKINGS] Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
}
