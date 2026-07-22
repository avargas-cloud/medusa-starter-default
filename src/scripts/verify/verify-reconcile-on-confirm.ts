/**
 * Verify reconcile-on-confirm + drift detector logic.
 * READ-ONLY unless RECEIPT_ID drift is found (which shouldn't happen on a clean
 * receipt). Prints the reconcile decision without side effects when clean.
 */
import { reconcileReceiptModIfDrifted, computeReceiptDrift } from "../../lib/purchase-orders/item-receipt-mod-payload";
export default async function verify({ container }: { container: { resolve: (k: string) => unknown } }) {
  const knex = container.resolve("__pg_connection__") as any;
  const rid = process.env.RECEIPT_ID;
  const drift = await computeReceiptDrift(knex);
  console.log(`computeReceiptDrift → ${drift.length} diverged receipt(s)`);
  if (rid) {
    const r = await reconcileReceiptModIfDrifted(knex, rid);
    console.log(`reconcileReceiptModIfDrifted(${rid}) →`, JSON.stringify(r));
  }
}
