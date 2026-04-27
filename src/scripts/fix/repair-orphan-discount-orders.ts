/**
 * scripts/fix/repair-orphan-discount-orders.ts
 *
 * Fixes orders left in the "orphaned discount" state by a previous failed
 * apply-discount-force run: they have `metadata.promotion_code` set but
 * `order_line_item_adjustment` is empty, so Medusa's `total` is inflated.
 *
 * For each affected order:
 *   1. Force-cancel any pending `order_change` rows (zombies that block edits).
 *   2. Compute the line-by-line subtotal (quantity × unit_price).
 *   3. Recreate one prorrated `order_line_item_adjustment` per line so they
 *      sum to `metadata.computed_total - subtotal` (i.e. the missing discount).
 *   4. Create the `order_promotion` link if the canonical promotion exists.
 *   5. Patch `order_summary.totals.discount_total` to match.
 *
 * Idempotent: skips orders that already have adjustments.
 *
 * Run: yarn ts-node src/scripts/fix/repair-orphan-discount-orders.ts
 *      [--dry] to preview without writing.
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const DRY = process.argv.includes("--dry");

interface OrphanRow {
  order_id: string;
  display_id: number;
  promotion_code: string;
  computed_total: string | null;
  metadata_discount_value: string | null;
  metadata_discount_type: string | null;
}

interface LineRow {
  item_id: string;
  quantity: string;
  unit_price: string;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows: orphans } = await client.query<OrphanRow>(`
      SELECT o.id AS order_id,
             o.display_id,
             o.metadata->>'promotion_code' AS promotion_code,
             o.metadata->>'computed_total' AS computed_total,
             o.metadata->>'discount_value' AS metadata_discount_value,
             o.metadata->>'discount_type' AS metadata_discount_type
      FROM "order" o
      WHERE o.metadata->>'promotion_code' IS NOT NULL
        AND o.deleted_at IS NULL
        AND o.is_draft_order = false
        AND NOT EXISTS (
          SELECT 1 FROM order_line_item_adjustment olia
          JOIN order_item oi ON oi.item_id = olia.item_id
          WHERE oi.order_id = o.id AND olia.deleted_at IS NULL
        )
      ORDER BY o.created_at DESC
    `);

    if (orphans.length === 0) {
      console.log("✅ No orphaned-discount orders found.");
      return;
    }
    console.log(
      `Found ${orphans.length} orphaned-discount order(s)${DRY ? " [DRY RUN]" : ""}:\n`
    );

    for (const o of orphans) {
      console.log(`\n--- S${o.display_id} (${o.order_id}) ---`);
      console.log(
        `  promo=${o.promotion_code}  computed_total=${o.computed_total}  type=${o.metadata_discount_type}  value=${o.metadata_discount_value}`
      );

      // 1. Cancel zombie order_change rows
      const cancelRes = await client.query(
        `UPDATE order_change SET status = 'canceled', canceled_at = NOW(), updated_at = NOW()
         WHERE order_id = $1 AND status = 'pending' AND deleted_at IS NULL
         RETURNING id`,
        [o.order_id]
      );
      // Note: with DRY we still ran the UPDATE. Roll back if dry.
      if (DRY && (cancelRes.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE order_change SET status = 'pending', canceled_at = NULL
           WHERE id = ANY($1::text[])`,
          [cancelRes.rows.map((r: any) => r.id)]
        );
      }
      console.log(`  cancelled ${cancelRes.rowCount ?? 0} zombie order_change(s)`);

      // 2. Pull line items
      const linesRes = await client.query<LineRow>(
        `SELECT oi.item_id, oi.quantity::text, oli.unit_price::text
         FROM order_item oi
         JOIN order_line_item oli ON oli.id = oi.item_id
         WHERE oi.order_id = $1 AND oi.deleted_at IS NULL`,
        [o.order_id]
      );
      const lines = linesRes.rows;
      const lineSubs = lines.map((r) => Number(r.quantity) * Number(r.unit_price));
      const subtotal = lineSubs.reduce((s, v) => s + v, 0);
      if (lines.length === 0 || subtotal <= 0) {
        console.log(`  ⚠️ No lines or zero subtotal — skipping`);
        continue;
      }

      // 3. Resolve total discount amount
      const computedTotal = Number(o.computed_total ?? "0");
      const discountFromComputed =
        computedTotal > 0 ? subtotal - computedTotal : 0;

      // Fall back to metadata.discount_value if computed_total is missing
      let discountAmt = discountFromComputed;
      if (discountAmt <= 0) {
        const dv = Number(o.metadata_discount_value ?? "0");
        const dt = (o.metadata_discount_type ?? "").toLowerCase();
        if (dt === "percent" && dv > 0) discountAmt = subtotal * (dv / 100);
        else if (dt === "fixed" && dv > 0) discountAmt = dv;
      }
      if (discountAmt <= 0 || discountAmt >= subtotal) {
        console.log(
          `  ⚠️ Could not resolve a sane discount amount (got $${discountAmt.toFixed(2)} on subtotal $${subtotal.toFixed(2)}) — skipping`
        );
        continue;
      }
      console.log(
        `  subtotal=$${subtotal.toFixed(2)}  target_discount=$${discountAmt.toFixed(2)}`
      );

      // 4. Look up promotion id
      const promoLookup = await client.query<{ id: string }>(
        `SELECT id FROM promotion WHERE code = $1 LIMIT 1`,
        [o.promotion_code]
      );
      const promoId: string | null = promoLookup.rows[0]?.id ?? null;
      if (!promoId) {
        console.log(
          `  ⚠️ Promotion ${o.promotion_code} not found — adjustments will be unlinked`
        );
      }

      if (DRY) {
        console.log(
          `  [DRY] Would insert ${lines.length} adjustments and order_promotion link`
        );
        for (let i = 0; i < lines.length; i++) {
          const proportion = lineSubs[i] / subtotal;
          const adjAmt = Number((proportion * discountAmt).toFixed(6));
          console.log(
            `    line ${i + 1} item=${lines[i].item_id} sub=${lineSubs[i].toFixed(2)} adj=$${adjAmt.toFixed(2)}`
          );
        }
        continue;
      }

      // 5. Insert prorrated adjustments
      for (let i = 0; i < lines.length; i++) {
        const proportion = lineSubs[i] / subtotal;
        const adjAmt = Number((proportion * discountAmt).toFixed(6));
        const rawAmt = JSON.stringify({
          value: String(adjAmt),
          precision: 20,
        });
        const adjId = `adj_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
        await client.query(
          `INSERT INTO order_line_item_adjustment
             (id, item_id, code, amount, raw_amount, promotion_id, description, is_tax_inclusive, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, 1, NOW(), NOW())`,
          [
            adjId,
            lines[i].item_id,
            o.promotion_code,
            adjAmt,
            rawAmt,
            promoId,
            "POS Discount (repaired)",
          ]
        );
      }

      // 6. Create order_promotion link if promo exists
      if (promoId) {
        const linkId = `ordpr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await client.query(
          `INSERT INTO order_promotion (id, order_id, promotion_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (order_id, promotion_id) DO NOTHING`,
          [linkId, o.order_id, promoId]
        );
      }

      // 7. Patch order_summary.totals.discount_total to match
      const sumRes = await client.query<{ id: string; totals: any }>(
        `SELECT id, totals FROM order_summary
         WHERE order_id = $1 AND deleted_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [o.order_id]
      );
      if (sumRes.rows[0]) {
        const { id: sumId, totals } = sumRes.rows[0];
        await client.query(
          `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
          [
            JSON.stringify({
              ...totals,
              discount_total: discountAmt,
              raw_discount_total: {
                value: String(discountAmt),
                precision: 20,
              },
            }),
            sumId,
          ]
        );
      }

      console.log(
        `  ✅ Inserted ${lines.length} adjustments summing $${discountAmt.toFixed(2)} (promo=${o.promotion_code})`
      );
    }

    console.log(`\nDone.${DRY ? " (dry run — nothing persisted)" : ""}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
