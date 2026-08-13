/**
 * Compara la función PURA de allocation (`lib/order-discount/allocation.ts`)
 * contra los adjustments REALES de órdenes vivas — READ-ONLY, cero escrituras.
 *
 * Fase 5 del plan descuentos-canonicos-v1: antes de que el facade transaccional
 * reemplace a los tres escritores actuales, la fórmula única tiene que
 * demostrar que reproduce (o mejora con desvío conocido y acotado) lo que el
 * sistema ya materializó. Un reemplazo que cambia números en silencio es un
 * restatement, no un refactor.
 *
 * Semántica de "adjustment efectivo" = la de order-tax-lines.ts: el más nuevo
 * por (item, code), líneas de la versión ACTUAL de la orden, redondeo por
 * línea. Los descuentos por ítem van horneados en unit_price (no son
 * adjustments), así que el neto de línea es unit_price × quantity.
 *
 * Correr:
 *   cd backend && env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/checks/compare-discount-allocation.ts
 * (o con la DB del sandbox para ensayar)
 */
import { Client } from "pg";

import {
  allocateOrderDiscount,
  type AllocationLine,
  type DiscountIntent,
} from "../../lib/order-discount/allocation";

const DB = process.env.DATABASE_URL;
if (!DB) {
  console.error("DATABASE_URL requerido");
  process.exit(2);
}

interface OrderRow {
  id: string;
  display_id: string;
  discount_type: string | null;
  discount_value: string | null;
  pos_discount_amount: string | null;
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: DB });
  await db.connect();

  const { rows: orders } = await db.query<OrderRow>(`
    SELECT o.id, o.display_id::text,
           o.metadata->>'discount_type'  AS discount_type,
           o.metadata->>'discount_value' AS discount_value,
           o.metadata->>'pos_discount_amount' AS pos_discount_amount
      FROM "order" o
     WHERE o.deleted_at IS NULL
       AND o.metadata->>'discount_type' IN ('percent','fixed')
       AND NULLIF(o.metadata->>'discount_value','')::numeric > 0
       AND EXISTS (
         SELECT 1 FROM order_line_item_adjustment a
           JOIN order_item oi ON oi.item_id = a.item_id
          WHERE oi.order_id = o.id AND a.deleted_at IS NULL
       )
     ORDER BY o.display_id`);

  console.log(`=== compare-discount-allocation — ${orders.length} órdenes con declaración + adjustments ===\n`);

  let okOrders = 0;
  let lineMismatchOrders = 0;
  let totalMismatchOrders = 0;
  const details: string[] = [];

  for (const o of orders) {
    // Líneas de la versión ACTUAL, con su adjustment efectivo (más nuevo por item+code)
    const { rows: lines } = await db.query<{
      item_id: string;
      net_cents: string;
      adj_cents: string;
    }>(
      `
      WITH current_items AS (
        SELECT oi.item_id, oli.unit_price, oi.quantity
          FROM order_item oi
          JOIN order_line_item oli ON oli.id = oi.item_id
          JOIN "order" o ON o.id = oi.order_id
         WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
           AND oi.version = o.version
      ),
      effective_adj AS (
        SELECT DISTINCT ON (a.item_id, a.code) a.item_id, a.amount
          FROM order_line_item_adjustment a
         WHERE a.deleted_at IS NULL
           AND a.item_id IN (SELECT item_id FROM current_items)
         ORDER BY a.item_id, a.code, a.updated_at DESC, a.id DESC
      )
      SELECT ci.item_id,
             ROUND(ci.unit_price * ci.quantity * 100)::text AS net_cents,
             COALESCE(ROUND(SUM(ea.amount) * 100), 0)::text AS adj_cents
        FROM current_items ci
        LEFT JOIN effective_adj ea ON ea.item_id = ci.item_id
       GROUP BY ci.item_id, ci.unit_price, ci.quantity`,
      [o.id]
    );
    if (lines.length === 0) continue;

    const intent: DiscountIntent =
      o.discount_type === "percent"
        ? { type: "percent", value: Number(o.discount_value) }
        : { type: "fixed", value: Number(o.discount_value) };

    const input: AllocationLine[] = lines.map((l) => ({
      itemId: l.item_id,
      netCents: Number(l.net_cents),
      taxable: true, // irrelevante para la asignación en sí
    }));

    let result;
    try {
      result = allocateOrderDiscount(input, intent);
    } catch (e) {
      details.push(`#${o.display_id}: allocation TIRÓ — ${(e as Error).message}`);
      totalMismatchOrders++;
      continue;
    }

    const existingTotal = lines.reduce((s, l) => s + Number(l.adj_cents), 0);
    const totalDiff = result.totalCents - existingTotal;

    let worstLineDiff = 0;
    for (let i = 0; i < lines.length; i++) {
      const diff = Math.abs(
        result.lines[i]!.adjustmentCents - Number(lines[i]!.adj_cents)
      );
      if (diff > worstLineDiff) worstLineDiff = diff;
    }

    // Umbrales: total exacto para percent (misma fórmula) · ±(n líneas) cents
    // para fixed (los escritores viejos prorratean con toFixed(6), el nuevo
    // asigna cents enteros — media línea de desvío por línea es el costo
    // declarado de pasar a enteros).
    const lineSlack = o.discount_type === "fixed" ? 1 : 0;
    const totalSlack = o.discount_type === "fixed" ? lines.length : 0;

    if (Math.abs(totalDiff) > totalSlack) {
      totalMismatchOrders++;
      details.push(
        `#${o.display_id} [${o.discount_type} ${o.discount_value}]: TOTAL difiere ${totalDiff}¢ (nuevo ${result.totalCents} vs existente ${existingTotal}, ${lines.length} líneas, declarado $${o.pos_discount_amount ?? "?"})`
      );
    } else if (worstLineDiff > lineSlack) {
      lineMismatchOrders++;
      details.push(
        `#${o.display_id} [${o.discount_type} ${o.discount_value}]: peor línea difiere ${worstLineDiff}¢ (total ok, ${lines.length} líneas)`
      );
    } else {
      okOrders++;
    }
  }

  console.log(`  ✓ coinciden dentro del umbral: ${okOrders}`);
  console.log(`  ~ desvío de línea fuera de umbral: ${lineMismatchOrders}`);
  console.log(`  ✗ desvío de TOTAL: ${totalMismatchOrders}\n`);
  for (const d of details) console.log("  " + d);

  await db.end();
  process.exit(totalMismatchOrders > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
