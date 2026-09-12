/**
 * verify-sales-summary-costs
 *
 * Prueba, contra datos reales, los dos agregados que el tile de Sales sumó el
 * 2026-09-12: subcontratos POSTED por liquidación y el saldo sin facturar de
 * las órdenes abiertas. Corre las funciones REALES del route (no una copia del
 * SQL) y las contrasta con una derivación independiente fila por fila.
 *
 * §1 Servicios: la suma de la función = la suma a mano de los `posted` con
 *    `settled_at` en el mes, y un mes sin servicios da 0 (control negativo).
 * §2 Open orders: la función = SUM por orden de GREATEST(0, total − facturado)
 *    sobre pending/no-void/no-pos_closed; y los DRAFTS (estimates, ~$1M en
 *    prod) quedan afuera — si entraran, el tile mentiría por 25×.
 * §3 Ninguna orden cuenta negativo (sobre-facturada → 0).
 *
 * Read-only. Run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-sales-summary-costs.ts
 */
import { Client } from "pg";

import { fetchPostedOutsourcedServiceCentsForPeriod } from "../../api/admin/reports/_lib/outsourced-services-expr";
import { fetchOpenOrdersUninvoicedCents } from "../../api/admin/reports/_lib/open-orders-uninvoiced";

const TZ = process.env.QB_DOC_TIMEZONE || "America/New_York";

function pgAdapter(client: Client) {
  // knex.raw usa `?`; el pool pg usa `$n`. El route corre por knex, así que el
  // adapter traduce — si el conteo de `?` y de bindings no cuadra, que explote.
  return {
    raw: async (sql: string, bindings: unknown[]) => {
      let i = 0;
      const translated = sql.replace(/\?/g, () => `$${++i}`);
      if (i !== bindings.length) throw new Error(`bindings mismatch: ${i} ? vs ${bindings.length}`);
      return client.query(translated, bindings);
    },
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  const pg = pgAdapter(client);

  try {
    console.log("§1 subcontratos POSTED por liquidación");
    const { rows: months } = await client.query(
      `SELECT to_char(date_trunc('month', s.settled_at AT TIME ZONE $1), 'YYYY-MM-DD') AS m,
              SUM(s.amount_cents)::bigint AS cents, COUNT(*)::int AS n
         FROM order_outsourced_service s
        WHERE s.deleted_at IS NULL AND s.state = 'posted'
        GROUP BY 1 ORDER BY 1`,
      [TZ],
    );
    check("hay al menos un mes con servicios posted (si no, §1 es vacuo)", months.length > 0, `${months.length} meses`);
    for (const m of months) {
      const from = m.m as string;
      const { rows: [{ next }] } = await client.query(
        `SELECT to_char($1::date + interval '1 month', 'YYYY-MM-DD') AS next`, [from]);
      const fn = await fetchPostedOutsourcedServiceCentsForPeriod(pg, from, next);
      check(`${from}: función = suma manual`, fn === Number(m.cents), `${fn} vs ${m.cents} (${m.n} servicios)`);
    }
    const { rows: [{ empty }] } = await client.query(
      `SELECT to_char(MIN(s.settled_at AT TIME ZONE $1) - interval '2 month', 'YYYY-MM-01') AS empty
         FROM order_outsourced_service s WHERE s.deleted_at IS NULL AND s.state = 'posted'`, [TZ]);
    if (empty) {
      const { rows: [{ next }] } = await client.query(
        `SELECT to_char($1::date + interval '1 month', 'YYYY-MM-DD') AS next`, [empty]);
      const zero = await fetchPostedOutsourcedServiceCentsForPeriod(pg, empty, next);
      check(`control negativo: ${empty} sin servicios → 0`, zero === 0, String(zero));
    }
    const { rows: [nonPosted] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM order_outsourced_service WHERE deleted_at IS NULL AND state <> 'posted'`);
    console.log(`  info: ${nonPosted.n} servicios NO posted (approved/draft/void) — no cuentan`);

    console.log("§2 open orders sin facturar");
    const fn = await fetchOpenOrdersUninvoicedCents(pg);
    const { rows: manual } = await client.query(
      `SELECT o.id, o.status, o.display_id,
              GREATEST(0, p.order_total_cents - COALESCE((
                SELECT SUM(i.total) FROM pos_invoice i
                 WHERE i.order_id = o.id AND i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')), 0)) AS cents
         FROM "order" o JOIN order_money_projection p ON p.order_id = o.id
        WHERE o.deleted_at IS NULL
          AND (o.metadata->>'qb_sync_status') IS DISTINCT FROM 'voided'
          AND (o.metadata->>'pos_closed') IS DISTINCT FROM 'true'`);
    const open = manual.filter((r) => r.status === "pending");
    const openCents = open.reduce((s, r) => s + Number(r.cents), 0);
    const openCount = open.filter((r) => Number(r.cents) > 0).length;
    check("función = suma manual por orden (pending)", fn.uninvoicedCents === openCents, `${fn.uninvoicedCents} vs ${openCents}`);
    check("conteo = órdenes pending con saldo > 0", fn.orderCount === openCount, `${fn.orderCount} vs ${openCount}`);
    const draftCents = manual.filter((r) => r.status === "draft").reduce((s, r) => s + Number(r.cents), 0);
    check("los drafts (estimates) NO entran", draftCents === 0 || fn.uninvoicedCents < openCents + draftCents,
      `drafts sumarían ${draftCents}`);
    check("§2 no es vacuo: hay saldo abierto", fn.uninvoicedCents > 0, `${fn.uninvoicedCents} cents en ${fn.orderCount} órdenes`);

    console.log("§3 ninguna orden resta");
    const { rows: [{ over }] } = await client.query(
      `SELECT COUNT(*)::int AS over FROM "order" o JOIN order_money_projection p ON p.order_id = o.id
        WHERE o.deleted_at IS NULL AND o.status = 'pending'
          AND p.order_total_cents < COALESCE((SELECT SUM(i.total) FROM pos_invoice i
               WHERE i.order_id = o.id AND i.deleted_at IS NULL AND i.status NOT IN ('draft','voided')), 0)`);
    console.log(`  info: ${over} órdenes pending sobre-facturadas (cuentan 0, no negativo)`);
    check("la suma no baja por sobre-facturadas", fn.uninvoicedCents >= 0);
  } finally {
    await client.end();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
