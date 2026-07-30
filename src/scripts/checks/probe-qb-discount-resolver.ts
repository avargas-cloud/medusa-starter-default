/**
 * Fase 1 — ¿qué descuento le entrega `getEffectiveOrderDiscount` a QuickBooks?
 *
 * Read-only. Corre contra el SANDBOX y lee la orden EXACTAMENTE como la leen
 * los dos caminos que mandan Estimate y Sales Order a QB
 * (`handle-order-placed.ts:73` y `qb-draft-order-subscriber.ts:208`), o sea con
 * `items.adjustments.*` de `query.graph`, y compara contra:
 *
 *   - lo que devuelve hoy `getEffectiveOrderDiscount`
 *   - la suma DEDUPLICADA por (línea, code, versión más nueva), que es la que
 *     usa `loadOrderMoneyBase` y la única que reproduce lo que QB facturó
 *
 * La sospecha a confirmar o descartar: Medusa RE-CREA las filas de adjustment en
 * cada edición en vez de actualizarlas, así que una línea editada dos veces
 * tiene tres filas vivas. `loadOrderMoneyBase` las deduplica; este resolver no.
 * Si `query.graph` las entrega todas, el descuento que viaja a QB en Estimate y
 * Sales Order está multiplicado por la cantidad de versiones.
 *
 * Run:
 *   cd backend && env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/medusa exec ./src/scripts/checks/probe-qb-discount-resolver.ts
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";

import type { ExecArgs } from "@medusajs/framework/types";

import { getEffectiveOrderDiscount } from "../../lib/quickbooks/order-flow-core";

export default async function probeQbDiscountResolver({ container }: ExecArgs) {
  // `logger` no llega por ExecArgs en esta versión — venía undefined y el script
  // moría en la primera línea de salida.
  const logger = { info: console.log, error: console.error };
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const knex = container.resolve("__pg_connection__");

  // Órdenes con descuento de orden y más de una versión — donde la trampa,
  // si existe, tiene que verse.
  const rows: { id: string; doc: string; versions: number }[] = await knex.raw(
    `SELECT o.id,
            COALESCE(o.metadata->>'document_number', o.display_id::text) AS doc,
            o.version AS versions
       FROM "order" o
      WHERE o.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM order_item oi
            JOIN order_line_item_adjustment a ON a.item_id = oi.item_id
           WHERE oi.order_id = o.id AND oi.version = o.version
             AND a.deleted_at IS NULL)
        AND (
          ? = ''
          OR COALESCE(o.metadata->>'document_number', o.display_id::text) = ANY(string_to_array(?, ','))
        )
      ORDER BY o.version DESC
      LIMIT 25`
  , [process.env.PROBE_DOCS ?? '', process.env.PROBE_DOCS ?? '']).then((r: { rows: { id: string; doc: string; versions: number }[] }) => r.rows);

  logger.info(`\nprobando ${rows.length} órdenes con adjustments\n${"=".repeat(92)}`);
  logger.info(
    `${"doc".padEnd(14)}${"vers".padStart(5)}${"resolver QB".padStart(14)}${"dedup+línea".padStart(14)}${"filas".padStart(7)}  veredicto`
  );

  let inflated = 0;
  let centsOff = 0;

  for (const r of rows) {
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "discount_total", "metadata", "items.adjustments.*"],
      filters: { id: r.id },
    });
    const order = data?.[0];
    if (!order) continue;

    const viaResolver = getEffectiveOrderDiscount(order);

    // La convención canónica: por línea, deduplicada por code/versión, en centavos.
    const canonical: { c: string }[] = await knex
      .raw(
        `SELECT COALESCE(SUM(line_cents), 0)::text AS c
           FROM (
             SELECT ROUND(SUM(ABS(latest.amount)) * 100) AS line_cents
               FROM order_item oi
               JOIN LATERAL (
                 SELECT DISTINCT ON (a.code) a.amount
                   FROM order_line_item_adjustment a
                  WHERE a.item_id = oi.item_id AND a.deleted_at IS NULL
                  ORDER BY a.code, a.version DESC
               ) latest ON true
              WHERE oi.order_id = ? AND oi.version = (SELECT version FROM "order" WHERE id = ?)
                AND oi.deleted_at IS NULL
              GROUP BY oi.item_id
           ) per_line`,
        [r.id, r.id]
      )
      .then((x: { rows: { c: string }[] }) => x.rows);
    const viaCanonical = Number(canonical[0]?.c ?? 0) / 100;

    const nAdj = (order.items ?? []).reduce(
      (s: number, it: { adjustments?: unknown[] }) =>
        s + (Array.isArray(it.adjustments) ? it.adjustments.length : 0),
      0
    );

    const delta = Math.round((viaResolver - viaCanonical) * 100) / 100;
    let verdict = "=";
    if (Math.abs(delta) >= 0.005) {
      // Un múltiplo casi exacto delata el conteo por versión; unos centavos, el redondeo.
      const ratio = viaCanonical > 0 ? viaResolver / viaCanonical : 0;
      if (ratio > 1.5) {
        verdict = `⛔ INFLADO ×${ratio.toFixed(2)}  (+${delta.toFixed(2)})`;
        inflated++;
      } else {
        verdict = `⚠️  ${delta > 0 ? "+" : ""}${delta.toFixed(2)} (redondeo)`;
        centsOff++;
      }
    }
    logger.info(
      `${r.doc.padEnd(14)}${String(r.versions).padStart(5)}` +
        `${viaResolver.toFixed(2).padStart(14)}${viaCanonical.toFixed(2).padStart(14)}` +
        `${String(nAdj).padStart(7)}  ${verdict}`
    );
  }

  logger.info(`${"=".repeat(92)}`);
  logger.info(
    `inflados por versión: ${inflated} · desviados por redondeo: ${centsOff} · de ${rows.length}`
  );
  if (inflated > 0) {
    logger.error(
      "⛔ El resolver que alimenta Estimate y Sales Order NO deduplica adjustments por versión.\n" +
        "   Eso NO es un problema de centavos: multiplica el descuento por la cantidad de ediciones."
    );
  }
}
