import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Client } from "pg";

/**
 * GET /admin/customers/balances?customer_ids=id1,id2,...
 *
 * QB-Style AR Balance:
 *   Net Balance  = unapplied_credit − open_ar_outstanding
 *   Open AR      = SUM(pos_invoice.balance_due) for non-paid/non-voided invoices
 *   Credit       = SUM of unapplied customer_payment amounts
 *                + SUM of customer_credit_ledger manual credits
 *
 * Units:
 *   - pos_invoice.balance_due → cents → ÷100 = dollars
 *   - customer_payment.amount → cents → ÷100 = dollars
 *   - payment_application.amount_applied → cents
 *   - customer_credit_ledger.amount → dollars (NUMERIC 12,2)
 *
 * All values returned are in USD (dollars).
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const ids =
    (req.query.customer_ids as string)?.split(",").filter(Boolean) ?? [];

  if (ids.length === 0) {
    res.json({ balances: {}, ar_outstanding: {} });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // 1. Open AR: sum of pos_invoice.balance_due for unpaid/partial invoices (cents → dollars)
    const arResult = await client.query<{
      customer_id: string;
      ar_outstanding: string;
    }>(
      `SELECT
                o.customer_id,
                COALESCE(SUM(pi.balance_due), 0) / 100.0 AS ar_outstanding
             FROM pos_invoice pi
             JOIN "order" o ON o.id = pi.order_id
             WHERE o.customer_id = ANY($1)
               AND pi.status NOT IN ('paid', 'voided')
               AND pi.deleted_at IS NULL
               AND pi.balance_due > 0
             GROUP BY o.customer_id`,
      [ids]
    );

    // 2a. Unapplied POS payments credit (customer_payment, cents → dollars)
    //     Available payments: full amount unapplied
    //     Partially applied: only the remaining unapplied portion
    const paymentCreditResult = await client.query<{
      customer_id: string;
      payment_credit: string;
    }>(
      // Only INVOICE-BOUND applications (invoice_id IS NOT NULL) consume credit.
      // Order-only applications (invoice_id IS NULL) are soft reservations against
      // an order, not settlements, so they must NOT reduce available credit here —
      // mirrors the per-customer balance endpoint (finance/customers/:id/balance).
      `SELECT
                cp.customer_id,
                COALESCE(SUM(
                    cp.amount - COALESCE(
                        (SELECT SUM(pa.amount_applied)
                         FROM payment_application pa
                         WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL
                           AND pa.invoice_id IS NOT NULL),
                        0
                    )
                ), 0) / 100.0 AS payment_credit
             FROM customer_payment cp
             WHERE cp.customer_id = ANY($1)
               AND cp.status IN ('available', 'partially_applied')
               AND cp.deleted_at IS NULL
             GROUP BY cp.customer_id`,
      [ids]
    );

    // 2b. Manual credit ledger entries (dollars, NUMERIC 12,2)
    const ledgerCreditResult = await client.query<{
      customer_id: string;
      ledger_balance: string;
    }>(
      `SELECT
                customer_id,
                COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS ledger_balance
             FROM customer_credit_ledger
             WHERE customer_id = ANY($1)
             GROUP BY customer_id`,
      [ids]
    );

    // 3. Merge
    const arMap: Record<string, number> = {};
    for (const row of arResult.rows) {
      arMap[row.customer_id] = parseFloat(row.ar_outstanding);
    }

    const paymentCreditMap: Record<string, number> = {};
    for (const row of paymentCreditResult.rows) {
      paymentCreditMap[row.customer_id] = parseFloat(row.payment_credit);
    }

    const ledgerMap: Record<string, number> = {};
    for (const row of ledgerCreditResult.rows) {
      ledgerMap[row.customer_id] = parseFloat(row.ledger_balance);
    }

    const balances: Record<string, number> = {};
    const ar_outstanding: Record<string, number> = {};
    for (const id of ids) {
      const credit = (paymentCreditMap[id] ?? 0) + (ledgerMap[id] ?? 0);
      const ar = arMap[id] ?? 0;
      balances[id] = credit - ar;
      ar_outstanding[id] = ar;
    }

    res.json({ balances, ar_outstanding });
  } catch (err: any) {
    console.error("[AR-BALANCE] Bulk balance error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
}
