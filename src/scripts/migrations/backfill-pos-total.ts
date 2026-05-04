/**
 * backfill-pos-total.ts
 * 
 * Backfills metadata.pos_total for all existing orders.
 * Computes the correct total using POS logic (respects taxable=false items).
 * 
 * Run: npx ts-node -r tsconfig-paths/register src/scripts/migrations/backfill-pos-total.ts
 */

import { getDbPool } from "../../utils/db-pool";

const TAX_RATE = 0.07;

async function main() {
  const pool = getDbPool();
  
  // Fetch all orders with their items
  const { rows: orders } = await pool.query(`
    SELECT 
      o.id,
      o.metadata,
      o.total as medusa_total,
      json_agg(
        json_build_object(
          'id', oi.item_id,
          'quantity', oi.quantity,
          'unit_price', oli.unit_price,
          'taxable', COALESCE(
            (SELECT oi2.metadata->>'taxable' FROM order_item oi2 WHERE oi2.item_id = oi.item_id AND oi2.version = oi.version),
            'true'
          )
        )
      ) as items
    FROM "order" o
    LEFT JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
    LEFT JOIN order_line_item oli ON oli.id = oi.item_id
    WHERE o.deleted_at IS NULL
    GROUP BY o.id, o.metadata, o.total
    ORDER BY o.created_at DESC
  `);

  console.log(`Found ${orders.length} orders to process\n`);

  let updated = 0;
  let skipped = 0;

  for (const order of orders) {
    const orderId = order.id;
    const currentPosTotal = order.metadata?.pos_total;
    const items = order.items?.filter((i: any) => i !== null) || [];

    if (items.length === 0) {
      skipped++;
      continue;
    }

    // Compute POS total
    let afterLineDiscountsSubtotalCents = 0;
    let taxableAfterLineDiscCents = 0;
    let orderDiscountTotalCents = 0;

    const discountType = order.metadata?.discount_type || 'percent';
    const discountValue = order.metadata?.discount_value || 0;
    const discountRate = discountType === 'percent' ? discountValue / 100 : 0;

    for (const item of items) {
      const unitPriceCents = Math.round((item.unit_price || 0) * 100);
      const lineBaseTotalCents = unitPriceCents * (item.quantity || 0);

      // Line discount
      let lineDiscountCents = 0;
      const lineDiscount = item.metadata?.line_discount;
      if (lineDiscount?.value && lineDiscount.value > 0) {
        if (lineDiscount.type === 'percent') {
          lineDiscountCents = Math.round(lineBaseTotalCents * lineDiscount.value / 100);
        } else {
          const fixedPerUnitCents = Math.round(lineDiscount.value * 100);
          lineDiscountCents = Math.min(lineBaseTotalCents, fixedPerUnitCents * (item.quantity || 0));
        }
      }
      const lineAfterLineDiscountCents = Math.max(0, lineBaseTotalCents - lineDiscountCents);
      afterLineDiscountsSubtotalCents += lineAfterLineDiscountCents;

      // Track taxable base
      const itemTaxable = item.taxable !== 'false';
      if (itemTaxable) {
        taxableAfterLineDiscCents += lineAfterLineDiscountCents;
      }

      // Order discount (percent only)
      if (discountType === 'percent' && discountRate > 0) {
        orderDiscountTotalCents += Math.round(lineAfterLineDiscountCents * discountRate);
      }
    }

    // Fixed order discount
    if (discountType === 'fixed') {
      orderDiscountTotalCents = Math.round(discountValue * 100);
    }

    const taxableAmountCents = Math.max(0, afterLineDiscountsSubtotalCents - orderDiscountTotalCents);

    // Tax base calculation
    let taxBaseCents: number;
    if (discountType === 'percent' && afterLineDiscountsSubtotalCents > 0) {
      const ratio = taxableAmountCents / afterLineDiscountsSubtotalCents;
      taxBaseCents = Math.round(taxableAfterLineDiscCents * ratio);
    } else if (discountType === 'fixed' && afterLineDiscountsSubtotalCents > 0) {
      const taxableShare = taxableAfterLineDiscCents / afterLineDiscountsSubtotalCents;
      const fixedReduction = Math.round(orderDiscountTotalCents * taxableShare);
      taxBaseCents = Math.max(0, taxableAfterLineDiscCents - fixedReduction);
    } else {
      taxBaseCents = taxableAfterLineDiscCents;
    }

    const taxTotalCents = Math.round(taxBaseCents * TAX_RATE);
    const totalCents = taxableAmountCents + taxTotalCents;
    const computedTotal = totalCents / 100;

    // Update only if different
    if (Math.abs(computedTotal - (currentPosTotal || 0)) > 0.01) {
      await pool.query(
        `UPDATE "order" SET metadata = COALESCE(metadata, '{}') || jsonb_build_object('pos_total', $1) WHERE id = $2`,
        [computedTotal, orderId]
      );
      updated++;
      console.log(`✓ ${orderId.slice(0, 8)}... | Medusa: $${order.medusa_total} → POS: $${computedTotal}`);
    } else {
      skipped++;
    }
  }

  console.log(`\nDone! Updated: ${updated}, Skipped: ${skipped}`);
  pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
