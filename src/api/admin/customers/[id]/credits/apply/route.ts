import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Client } from "pg";

/**
 * POST /admin/customers/[id]/credits/apply
 *
 * Applies credit from the customer's balance to a specific order (debit entry).
 * Called by the POS "Receive Payment" screen when allocating credit to an invoice.
 *
 * Body: { order_id: string, amount: number, note?: string }
 *
 * Returns: { success, entry, new_balance, remaining_order_balance }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const customerId = (req.params as any).id;
  const { order_id, amount, note } = req.body as {
    order_id: string;
    amount: number;
    note?: string;
  };

  if (!order_id) {
    res.status(400).json({ error: "order_id is required" });
    return;
  }
  if (!amount || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }

  const createdBy = (req as any).auth_context?.actor_id ?? null;

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    // ── Check available balance ────────────────────────────────────────────
    const balanceRes = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
             FROM customer_credit_ledger WHERE customer_id = $1`,
      [customerId]
    );
    const currentBalance = parseFloat(balanceRes.rows[0]?.balance ?? "0");

    if (amount > currentBalance) {
      res.status(400).json({
        error: `Insufficient credit. Available: $${currentBalance.toFixed(2)}, Requested: $${amount.toFixed(2)}`,
        available_balance: currentBalance,
      });
      return;
    }

    // ── Record the debit ───────────────────────────────────────────────────
    const insertRes = await client.query(
      `INSERT INTO customer_credit_ledger
                (customer_id, amount, type, reference_id, reference_type, note, created_by)
             VALUES ($1, $2, 'debit', $3, 'order', $4, $5)
             RETURNING *`,
      [
        customerId,
        amount,
        order_id,
        note ?? `Credit applied to Order`,
        createdBy,
      ]
    );

    // ── Get new balance ────────────────────────────────────────────────────
    const newBalanceRes = await client.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END), 0) AS balance
             FROM customer_credit_ledger WHERE customer_id = $1`,
      [customerId]
    );
    const newBalance = parseFloat(newBalanceRes.rows[0]?.balance ?? "0");

    // ── Optionally capture payment on the Medusa order ────────────────────
    // Note: For full POS integration, the POS should also call capture_payment
    // on the Medusa order for the applied amount. This endpoint only records
    // the credit ledger debit — the caller is responsible for order capture.

    res.json({
      success: true,
      entry: insertRes.rows[0],
      new_balance: newBalance,
      amount_applied: amount,
      order_id,
    });
  } catch (err: any) {
    console.error("[CREDIT-LEDGER] apply error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    await client.end();
  }
}
