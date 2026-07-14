import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import {
  buildCreditMemoQuery,
  buildReceivePaymentQuery,
  parseCreditMemos,
  parsePayments,
  runDirectQuery,
  type QbCustomerCredit,
} from "./_lib/qb-credit-query";

interface CustomerCreditRow extends QbCustomerCredit {
  /** true when a POS store-credit already points at this QB TxnID. */
  already_imported: boolean;
  imported_payment_id: string | null;
}

/**
 * GET /admin/quickbooks/customer-credits?customer_id=cus_xxx
 *
 * Live-queries QuickBooks for a customer's UNAPPLIED credits (credit memos with
 * CreditRemaining > 0 and receive-payments with UnusedPayment > 0) so a cashier
 * can import one as a redeemable POS store-credit — WITHOUT minting a new QB doc.
 *
 * Returns { success, customer_qb_linked, credits: CustomerCreditRow[] }.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const customerId = String(req.query.customer_id ?? "").trim();
  if (!customerId) {
    res.status(400).json({ error: "customer_id is required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    const { rows } = await client.query<{ qb_list_id: string | null }>(
      `SELECT metadata->>'qb_list_id' AS qb_list_id FROM customer WHERE id = $1`,
      [customerId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: `Customer ${customerId} not found` });
      return;
    }
    const qbListId = rows[0]?.qb_list_id ?? null;
    if (!qbListId) {
      res.json({ success: true, customer_qb_linked: false, credits: [] });
      return;
    }

    // Query both doc types in parallel.
    const [cmRaw, payRaw] = await Promise.all([
      runDirectQuery(buildCreditMemoQuery({ listId: qbListId })),
      runDirectQuery(buildReceivePaymentQuery({ listId: qbListId })),
    ]);

    const credits: QbCustomerCredit[] = [
      ...parseCreditMemos(cmRaw),
      ...parsePayments(payRaw),
    ];

    // Flag any that are already imported into the POS ledger.
    const txnIds = credits.map((c) => c.txn_id);
    const importedByTxn = new Map<string, string>();
    if (txnIds.length > 0) {
      const { rows: imported } = await client.query<{
        id: string;
        qb_txn_id: string;
      }>(
        `SELECT id, metadata->>'qb_txn_id' AS qb_txn_id
           FROM customer_payment
          WHERE metadata->>'qb_txn_id' = ANY($1::text[])
            AND status <> 'voided'`,
        [txnIds]
      );
      for (const r of imported) {
        if (r.qb_txn_id) importedByTxn.set(r.qb_txn_id, r.id);
      }
    }

    const enriched: CustomerCreditRow[] = credits
      .map((c) => ({
        ...c,
        already_imported: importedByTxn.has(c.txn_id),
        imported_payment_id: importedByTxn.get(c.txn_id) ?? null,
      }))
      .sort((a, b) => (b.txn_date ?? "").localeCompare(a.txn_date ?? ""));

    res.json({ success: true, customer_qb_linked: true, credits: enriched });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to query QB credits";
    console.error(`[QB Customer Credits ${customerId}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
