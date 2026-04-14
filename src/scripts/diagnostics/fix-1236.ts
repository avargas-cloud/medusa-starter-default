import { MedusaContainer } from "@medusajs/framework/types";
import { getDbPool } from "../../api/utils/db-pool";

export default async function fix1236({
  container,
}: {
  container: MedusaContainer;
}) {
  const pool = getDbPool();
  const id = "order_01KMGWYGD4FEHXPJWAVWATDHC2";

  console.log("Forcing discount removal and tax fix manually...");

  // 1. Delete all adjustments (forces discount to 0)
  const delRes = await pool.query(
    `DELETE FROM order_line_item_adjustment WHERE item_id IN (SELECT oi.item_id FROM order_item oi WHERE oi.order_id = $1)`,
    [id]
  );
  console.log(`Deleted ${delRes.rowCount} stale adjustments (ghost discounts)`);

  // 2. Fix Tax Lines (Delete and re-insert)
  const itemsRes = await pool.query<{ item_id: string }>(
    `SELECT DISTINCT oi.item_id FROM order_item oi WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
    [id]
  );
  const itemIds = itemsRes.rows.map((r) => r.item_id);
  if (itemIds.length > 0) {
    await pool.query(
      `DELETE FROM order_line_item_tax_line WHERE item_id = ANY($1)`,
      [itemIds]
    );
    const rawRate = JSON.stringify({ value: "7", precision: 20 });
    const genId = () =>
      `taxline_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    for (const itemId of itemIds) {
      await pool.query(
        `INSERT INTO order_line_item_tax_line (id, item_id, code, rate, raw_rate, description, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [genId(), itemId, "FL", 7, rawRate, "Florida Sales Tax"]
      );
    }
    console.log(`Inserted FL tax lines at 7% for ${itemIds.length} items`);
  }

  // 3. Fix Order Summary
  const summaryRes = await pool.query<{ id: string; totals: any }>(
    `SELECT id, totals FROM order_summary WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`,
    [id]
  );
  if (summaryRes.rows[0]) {
    const { id: summaryId, totals } = summaryRes.rows[0];
    const newAccountingTotal = 95.23;
    const pos_tax_amount = 6.23;
    await pool.query(
      `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
      [
        JSON.stringify({
          ...totals,
          tax_total: pos_tax_amount,
          raw_tax_total: { value: String(pos_tax_amount), precision: 20 },
          accounting_total: newAccountingTotal,
          raw_accounting_total: {
            value: String(newAccountingTotal),
            precision: 20,
          },
          current_order_total: newAccountingTotal,
          raw_current_order_total: {
            value: String(newAccountingTotal),
            precision: 20,
          },
          pending_difference: newAccountingTotal,
          raw_pending_difference: {
            value: String(newAccountingTotal),
            precision: 20,
          },
          discount_total: 0,
          raw_discount_total: { value: "0", precision: 20 },
        }),
        summaryId,
      ]
    );
    console.log(
      `Injected $${pos_tax_amount} tax to order_summary ${summaryId} and fixed accounting_total`
    );
  }
}
