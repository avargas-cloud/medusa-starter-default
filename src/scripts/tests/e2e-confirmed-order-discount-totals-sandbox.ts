/**
 * e2e-confirmed-order-discount-totals-sandbox.ts
 *
 * Aplica y quita descuentos de ORDEN sobre una orden CONFIRMADA por el camino
 * real del POS (`POST /admin/orders/:id/post-edit-sync`) y asserta que los TRES
 * campos de total (metadata.pos_total, metadata.computed_total,
 * order_summary.totals.current_order_total) y la proyección de dinero queden
 * consistentes con las líneas después de CADA save.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * S11432 (2026-08-12): un save que QUITABA un descuento fijo de $4,933.04 dejó
 * pos_total = 26,116.47 sobre una orden cuyas líneas suman 31,049.51. La ruta
 * derivaba el total ANTES de reconciliar los adjustments (que el save estaba
 * matando) y además trataba el `pos_discount_amount: 0` explícito como "no sé".
 * El E2E preexistente (`e2e-order-discount-lifecycle-sandbox.ts`) cubre DRAFTS
 * vía sync-pos; este cubre el camino de órdenes confirmadas, que era el hueco.
 *
 * Mutation test: esta misma secuencia, corrida contra el código pre-fix el
 * 2026-08-13, produjo el veneno exacto (26,116.47) en el paso "quitar" — el
 * assert de ese paso falla en rojo sin el fix.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-confirmed-order-discount-totals-sandbox.ts
 *
 * Sandbox-only: aborta si la DB no apunta a localhost:5499. Read-write SOLO
 * contra el sandbox; QB Bridge apagado en ese entorno.
 */
import { Pool } from "pg";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const SB_API = process.env.SANDBOX_API ?? "http://localhost:9099";
const EMAIL = process.env.SANDBOX_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.SANDBOX_PASSWORD ?? "sandbox123";

if (!SB_DB.includes("localhost:5499") && !SB_DB.includes("127.0.0.1:5499")) {
  console.error("❌ SANDBOX_DATABASE_URL no apunta al sandbox (5499). Abortando.");
  process.exit(2);
}

const pool = new Pool({ connectionString: SB_DB });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** medusa develop reinicia con cada write en src/ — reintentar ECONNREFUSED. */
async function api(path: string, init: RequestInit, tries = 6): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${SB_API}${path}`, init);
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
      return await res.json();
    } catch (e: any) {
      const retriable =
        String(e?.cause?.code ?? e?.message).includes("ECONNREFUSED") ||
        String(e?.message).includes("fetch failed");
      if (!retriable || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

type Estado = {
  posTotal: number | null;
  computedTotal: number | null;
  summaryTotal: number | null;
  adjRows: number;
  adjSum: number;
  promoLinks: number;
  projTotalCents: number | null;
};

async function leerEstado(orderId: string): Promise<Estado> {
  const { rows } = await pool.query(
    `SELECT
       NULLIF(o.metadata->>'pos_total','')::numeric        AS pos_total,
       NULLIF(o.metadata->>'computed_total','')::numeric   AS computed_total,
       (SELECT NULLIF(s.totals->>'current_order_total','')::numeric
          FROM order_summary s
         WHERE s.order_id = o.id AND s.version = o.version AND s.deleted_at IS NULL
         LIMIT 1)                                          AS summary_total,
       (SELECT COUNT(*) FROM order_line_item_adjustment a
         WHERE a.item_id IN (SELECT item_id FROM order_item WHERE order_id = o.id)
           AND a.deleted_at IS NULL)                       AS adj_rows,
       (SELECT COALESCE(ROUND(SUM(ABS(a.amount)), 2), 0) FROM order_line_item_adjustment a
         WHERE a.item_id IN (SELECT item_id FROM order_item WHERE order_id = o.id)
           AND a.deleted_at IS NULL)                       AS adj_sum,
       (SELECT COUNT(*) FROM order_promotion op WHERE op.order_id = o.id) AS promo_links,
       (SELECT p.order_total_cents FROM order_money_projection p
         WHERE p.order_id = o.id)                          AS proj_total_cents
     FROM "order" o WHERE o.id = $1`,
    [orderId]
  );
  const r = rows[0];
  return {
    posTotal: r.pos_total === null ? null : Number(r.pos_total),
    computedTotal: r.computed_total === null ? null : Number(r.computed_total),
    summaryTotal: r.summary_total === null ? null : Number(r.summary_total),
    adjRows: Number(r.adj_rows),
    adjSum: Number(r.adj_sum),
    promoLinks: Number(r.promo_links),
    projTotalCents: r.proj_total_cents === null ? null : Number(r.proj_total_cents),
  };
}

let fallas = 0;
function assertPaso(paso: string, e: Estado, esperado: number, extra?: Partial<Estado>) {
  const cents = Math.round(esperado * 100);
  const checks: Array<[string, unknown, unknown]> = [
    ["metadata.pos_total", e.posTotal, esperado],
    ["metadata.computed_total", e.computedTotal, esperado],
    ["summary.current_order_total", e.summaryTotal, esperado],
    ["projection.order_total_cents", e.projTotalCents, cents],
  ];
  if (extra?.adjRows !== undefined) checks.push(["adjustment rows", e.adjRows, extra.adjRows]);
  if (extra?.adjSum !== undefined) checks.push(["adjustment sum", e.adjSum, extra.adjSum]);
  if (extra?.promoLinks !== undefined) checks.push(["order_promotion links", e.promoLinks, extra.promoLinks]);
  const rotos = checks.filter(([, got, want]) => String(got) !== String(want));
  if (rotos.length === 0) {
    console.log(`✅ ${paso} — total ${esperado.toFixed(2)} consistente en las 4 capas`);
  } else {
    fallas++;
    console.error(`❌ ${paso}:`);
    for (const [campo, got, want] of rotos) {
      console.error(`     ${campo}: esperado ${want}, obtenido ${got}`);
    }
  }
}

async function main() {
  // Login
  const { token } = await api("/auth/user/emailpass", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // Orden confirmada del POS, sin descuento vivo, sin invoices, con líneas.
  const { rows: cand } = await pool.query(
    `SELECT o.id, o.metadata->>'document_number' AS doc
       FROM "order" o
      WHERE o.is_draft_order = false AND o.status = 'pending'
        AND o.metadata->>'pos_created' = 'true'
        AND COALESCE(o.metadata->>'discount_type','') = ''
        AND NOT EXISTS (SELECT 1 FROM pos_invoice pi
                         WHERE pi.order_id = o.id AND pi.deleted_at IS NULL)
        AND (SELECT COUNT(*) FROM order_item oi
              WHERE oi.order_id = o.id AND oi.deleted_at IS NULL
                AND oi.version = o.version) BETWEEN 2 AND 20
      ORDER BY o.created_at DESC LIMIT 1`
  );
  if (!cand[0]) {
    console.error("❌ No hay orden candidata en el sandbox.");
    process.exit(2);
  }
  const orderId: string = cand[0].id;
  console.log(`Orden bajo prueba: ${cand[0].doc} (${orderId})\n`);

  // Subtotal esperado desde las líneas, con la convención per-línea del POS.
  const { rows: lines } = await pool.query(
    `SELECT li.unit_price, oi.quantity, li.metadata->>'taxable' AS taxable
       FROM order_item oi JOIN order_line_item li ON li.id = oi.item_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
        AND oi.version = (SELECT version FROM "order" WHERE id = $1)`,
    [orderId]
  );
  let subtotalCents = 0;
  let taxableCents = 0;
  for (const l of lines) {
    const c = Math.round(Number(l.unit_price) * Number(l.quantity) * 100);
    subtotalCents += c;
    if (l.taxable !== "false") taxableCents += c;
  }
  const subtotal = subtotalCents / 100;
  const RATE = 7;
  const taxFull = round2((taxableCents / 100) * (RATE / 100));
  const totalFull = round2(subtotal + taxFull);
  console.log(`Líneas: subtotal ${subtotal.toFixed(2)} · tax ${taxFull.toFixed(2)} · total ${totalFull.toFixed(2)}\n`);

  const save = (body: Record<string, unknown>) =>
    api(`/admin/orders/${orderId}/post-edit-sync`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ pos_tax_rate: RATE, skip_qb: true, ...body }),
    });

  // Paso 1 — save de normalización sin descuento.
  await save({ pos_discount_amount: 0, pos_total: totalFull, pos_tax_amount: taxFull });
  assertPaso("Paso 1: save sin descuento", await leerEstado(orderId), totalFull, {
    adjRows: 0,
  });

  // Paso 2 — aplicar descuento FIJO del 10% del subtotal.
  const dFixed = round2(subtotal * 0.1);
  const taxDisc = round2(((taxableCents / 100) - dFixed * (taxableCents / subtotalCents)) * (RATE / 100));
  const totalDisc = round2(subtotal - dFixed + taxDisc);
  await save({
    discount_type: "fixed",
    discount_value: dFixed,
    pos_discount_amount: dFixed,
    pos_total: totalDisc,
    pos_tax_amount: taxDisc,
  });
  assertPaso(`Paso 2: aplicar fijo ${dFixed.toFixed(2)}`, await leerEstado(orderId), totalDisc, {
    adjSum: dFixed,
  });

  // Paso 3 — QUITARLO con 0 explícito. El caso S11432: sin el fix, acá queda
  // subtotal + taxFull − dFixed en vez de totalFull.
  await save({ pos_discount_amount: 0, pos_total: totalFull, pos_tax_amount: taxFull });
  assertPaso("Paso 3: quitar el fijo (0 explícito)", await leerEstado(orderId), totalFull, {
    adjRows: 0,
    promoLinks: 0,
  });

  // Paso 4 — aplicar 5% PORCENTUAL.
  const dPct = round2(subtotal * 0.05);
  const taxPct = round2(((taxableCents / 100) - dPct * (taxableCents / subtotalCents)) * (RATE / 100));
  const totalPct = round2(subtotal - dPct + taxPct);
  await save({
    discount_type: "percent",
    discount_value: 5,
    pos_discount_amount: dPct,
    pos_total: totalPct,
    pos_tax_amount: taxPct,
  });
  assertPaso(`Paso 4: aplicar 5% (${dPct.toFixed(2)})`, await leerEstado(orderId), totalPct);

  // Paso 5 — quitarlo.
  await save({ pos_discount_amount: 0, pos_total: totalFull, pos_tax_amount: taxFull });
  assertPaso("Paso 5: quitar el 5%", await leerEstado(orderId), totalFull, {
    adjRows: 0,
    promoLinks: 0,
  });

  // Paso 6 — save legacy SIN campo de descuento: el fallback lee la base ya
  // limpia y no debe mover nada.
  await save({ pos_total: totalFull, pos_tax_amount: taxFull });
  assertPaso("Paso 6: save legacy sin campo", await leerEstado(orderId), totalFull, {
    adjRows: 0,
  });

  await pool.end();
  if (fallas > 0) {
    console.error(`\n❌ ${fallas} paso(s) fallaron`);
    process.exit(1);
  }
  console.log("\n✅ E2E completo: aplicar/quitar descuento deja los totales consistentes");
}

main().catch((e) => {
  console.error("❌ E2E abortó:", e?.message ?? e);
  process.exit(1);
});
