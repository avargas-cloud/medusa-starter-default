/**
 * E2E COMPREHENSIVE del chokepoint de descuentos — SANDBOX ONLY.
 *
 * La matriz pedida por el operador (2026-08-14): órdenes POS y WEB × descuento
 * de orden percent/fixed × aplicar → re-aplicar (idempotencia) → cambiar →
 * quitar → re-aplicar; descuentos de PRODUCTO (per-línea, horneados en
 * unit_price) que las operaciones de orden JAMÁS tocan; orden mixta
 * taxable/exempt; payment_collection (el "cuarto total"); link order_promotion
 * único; rollback transaccional inyectado (nada queda a medias).
 *
 * Complementa a los dos gates existentes (6 pasos S11432 + 13 pasos lifecycle
 * drafts), que DEBEN seguir verdes sin editarse.
 *
 *   ./back-sb
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-order-discount-chokepoint-sandbox.ts
 */
import { Client, Pool } from "pg";

import { applyOrderDiscount } from "../../lib/order-discount/apply-order-discount";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE))
  abort(`BASE=${BASE} no es el sandbox :9099`);
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB))
  abort(`DB no es la del sandbox :5499`);

const results: Array<{ ok: boolean; name: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ ok, name });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

async function main(): Promise<void> {
  console.log("=== e2e-order-discount-chokepoint (sandbox) ===\n");
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { token } = (await authRes.json().catch(() => ({}))) as {
    token?: string;
  };
  if (!token) abort(`login falló (HTTP ${authRes.status})`);

  const { rows: pinRows } = await db.query<{ pin: string | null }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
      WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
  );
  const realPin = pinRows[0]?.pin;
  if (!realPin) abort("sandbox sin PIN de supervisor");

  // ── Orden de prueba: pending POS, ≥2 líneas, sin descuento previo ─────────
  const { rows: ordRows } = await db.query<{ id: string; display_id: string }>(
    `SELECT o.id, o.display_id::text FROM "order" o
      WHERE o.deleted_at IS NULL AND o.is_draft_order = false AND o.status = 'pending'
        AND o.metadata->>'pos_created' = 'true'
        AND (SELECT count(*) FROM order_item oi WHERE oi.order_id = o.id AND oi.deleted_at IS NULL) >= 2
        AND NOT EXISTS (
          SELECT 1 FROM order_line_item_adjustment a
            JOIN order_item oi ON oi.item_id = a.item_id
           WHERE oi.order_id = o.id AND a.deleted_at IS NULL)
      ORDER BY o.created_at DESC LIMIT 1`
  );
  const ord = ordRows[0];
  if (!ord) abort("no hay orden pending POS sin descuento con ≥2 líneas");
  console.log(`  · orden bajo prueba: #${ord.display_id} (${ord.id})\n`);

  // Snapshot de líneas (los descuentos de PRODUCTO viven acá — jamás se tocan)
  const lineSnapshot = async () =>
    (
      await db.query<{ item_id: string; unit_price: string; quantity: string; taxable: boolean | null }>(
        `SELECT oi.item_id, oli.unit_price::text, oi.quantity::text, oli.taxable
           FROM order_item oi JOIN order_line_item oli ON oli.id = oi.item_id
          WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
            AND oi.version = (SELECT MAX(version) FROM order_item WHERE order_id = $1)
          ORDER BY oi.item_id`,
        [ord.id]
      )
    ).rows;
  const linesBefore = await lineSnapshot();
  const netCents = linesBefore.reduce(
    (s, l) => s + Math.round(Number(l.unit_price) * 100) * Number(l.quantity),
    0
  );
  const shippingRes = await db.query<{ ship: string | null }>(
    `SELECT COALESCE(SUM(amount),0)::text AS ship FROM order_shipping_method osm
      JOIN order_shipping os ON os.shipping_method_id = osm.id
     WHERE os.order_id = $1 AND os.deleted_at IS NULL`,
    [ord.id]
  );
  const shipCents = Math.round(Number(shippingRes.rows[0]?.ship ?? 0) * 100);

  const state = async () => {
    const { rows } = await db.query<{
      adj_sum: string;
      adj_rows: string;
      links: string;
      m_type: string | null;
      m_value: string | null;
      m_amount: string | null;
      m_schema: string | null;
      m_pos_total: string | null;
      m_computed: string | null;
      s_total: string | null;
      s_tax: string | null;
      pc_amount: string | null;
    }>(
      `SELECT
         COALESCE((SELECT ROUND(SUM(a.amount)::numeric,2) FROM order_line_item_adjustment a
            JOIN order_item oi ON oi.item_id = a.item_id
           WHERE oi.order_id = $1 AND a.deleted_at IS NULL), 0)::text AS adj_sum,
         (SELECT count(*) FROM order_line_item_adjustment a
            JOIN order_item oi ON oi.item_id = a.item_id
           WHERE oi.order_id = $1 AND a.deleted_at IS NULL)::text AS adj_rows,
         (SELECT count(*) FROM order_promotion WHERE order_id = $1)::text AS links,
         o.metadata->>'discount_type'  AS m_type,
         o.metadata->>'discount_value' AS m_value,
         o.metadata->>'pos_discount_amount' AS m_amount,
         o.metadata->>'discount_schema' AS m_schema,
         o.metadata->>'pos_total' AS m_pos_total,
         o.metadata->>'computed_total' AS m_computed,
         (SELECT (totals->>'current_order_total') FROM order_summary
           WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1) AS s_total,
         (SELECT (totals->>'tax_total') FROM order_summary
           WHERE order_id = $1 AND deleted_at IS NULL ORDER BY version DESC LIMIT 1) AS s_tax,
         (SELECT pc.amount::text FROM payment_collection pc
           WHERE pc.id IN (SELECT payment_collection_id FROM order_payment_collection WHERE order_id = $1)
             AND pc.deleted_at IS NULL LIMIT 1) AS pc_amount
       FROM "order" o WHERE o.id = $1`,
      [ord.id]
    );
    return rows[0]!;
  };

  const save = async (
    body: Record<string, unknown>,
    pin?: string
  ): Promise<{ status: number; raw: string }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (pin) headers["x-supervisor-pin"] = pin;
    const r = await fetch(`${BASE}/admin/orders/${ord.id}/post-edit-sync`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, raw: await r.text() };
  };

  // Espeja pos-totals.ts para el caso todo-taxable / mixto
  const expect = (opts: { pct?: number; fixed?: number; taxableCents: number; rate?: number }) => {
    const rate = (opts.rate ?? 7) / 100;
    let discCents = 0;
    let taxBase: number;
    if (opts.pct) {
      // per-line round — recomputado por línea afuera; acá el agregado
      discCents = linesBefore.reduce(
        (s, l) =>
          s +
          Math.round(
            Math.round(Number(l.unit_price) * 100) * Number(l.quantity) * (opts.pct! / 100)
          ),
        0
      );
      const taxableAmount = Math.max(0, netCents - discCents);
      taxBase = Math.round(opts.taxableCents * (taxableAmount / netCents));
    } else if (opts.fixed) {
      discCents = Math.round(opts.fixed * 100);
      const share = opts.taxableCents / netCents;
      taxBase = Math.max(0, opts.taxableCents - Math.round(discCents * share));
    } else {
      taxBase = opts.taxableCents;
    }
    const taxCents = Math.round(taxBase * rate);
    const totalCents = netCents - discCents + shipCents + taxCents;
    return {
      disc: discCents / 100,
      tax: taxCents / 100,
      total: totalCents / 100,
    };
  };

  const near = (a: string | null, b: number, cents = 1) =>
    a != null && Math.abs(Number(a) - b) <= cents / 100 + 1e-9;

  const allTaxable = linesBefore.every((l) => l.taxable !== false);
  if (!allTaxable) console.log("  (orden con líneas exempt propias — se usa igual)");
  const taxableCents = linesBefore.reduce(
    (s, l) =>
      s +
      (l.taxable !== false
        ? Math.round(Number(l.unit_price) * 100) * Number(l.quantity)
        : 0),
    0
  );

  try {
    // ── 1 · aplicar percent 10 ───────────────────────────────────────────────
    let exp = expect({ pct: 10, taxableCents });
    let r = await save({
      discount_type: "percent",
      discount_value: 10,
      pos_discount_amount: exp.disc,
      pos_total: exp.total,
      pos_tax_amount: exp.tax,
      pos_tax_rate: 7,
    });
    let st = await state();
    check("1a percent 10 → 200", r.status === 200, `HTTP ${r.status}: ${r.raw.slice(0, 160)}`);
    check("1b adjustments suman el descuento", near(st.adj_sum, exp.disc), `${st.adj_sum} vs ${exp.disc}`);
    check("1c metadata (type/value/amount/schema)", st.m_type === "percent" && Number(st.m_value) === 10 && near(st.m_amount, exp.disc) && st.m_schema === "1", JSON.stringify([st.m_type, st.m_value, st.m_amount, st.m_schema]));
    check("1d los 3 totales alineados", near(st.m_pos_total, exp.total) && near(st.m_computed, exp.total) && near(st.s_total, exp.total), `pos=${st.m_pos_total} comp=${st.m_computed} sum=${st.s_total} esp=${exp.total}`);
    check("1e payment_collection = total derivado", st.pc_amount === null || near(st.pc_amount, exp.total), `pc=${st.pc_amount}`);
    check("1f UN link order_promotion", st.links === "1", `${st.links}`);

    // ── 2 · idempotencia: EXACTAMENTE el mismo save ─────────────────────────
    const stBefore = JSON.stringify(st);
    r = await save({
      discount_type: "percent",
      discount_value: 10,
      pos_discount_amount: exp.disc,
      pos_total: exp.total,
      pos_tax_amount: exp.tax,
      pos_tax_rate: 7,
    });
    st = await state();
    check("2 idempotente: mismo estado tras repetir", r.status === 200 && JSON.stringify(st) === stBefore, "difirió");

    // ── 3 · cambiar a fixed ──────────────────────────────────────────────────
    exp = expect({ fixed: 50, taxableCents });
    r = await save({
      discount_type: "fixed",
      discount_value: 50,
      pos_discount_amount: 50,
      pos_total: exp.total,
      pos_tax_amount: exp.tax,
      pos_tax_rate: 7,
    });
    st = await state();
    check("3a cambiar a fixed 50 → suma exacta", r.status === 200 && Number(st.adj_sum) === 50, `${st.adj_sum}`);
    check("3b totales del fixed", near(st.s_total, exp.total) && near(st.s_tax, exp.tax), `sum=${st.s_total}/${st.s_tax} esp=${exp.total}/${exp.tax}`);
    check("3c sigue UN link (no acumula)", st.links === "1", st.links);

    // ── 4 · quitar (0 explícito) ─────────────────────────────────────────────
    exp = expect({ taxableCents });
    r = await save({ pos_discount_amount: 0, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
    st = await state();
    check("4a quitar → 0 adjustments, 0 links", r.status === 200 && st.adj_rows === "0" && st.links === "0", `adj=${st.adj_rows} links=${st.links}`);
    check("4b metadata en null explícito", st.m_type === null && st.m_value === null && Number(st.m_amount) === 0, JSON.stringify([st.m_type, st.m_value, st.m_amount]));
    check("4c total restaurado", near(st.s_total, exp.total), `${st.s_total} vs ${exp.total}`);

    // ── 5 · re-aplicar percent 5 y re-quitar ─────────────────────────────────
    exp = expect({ pct: 5, taxableCents });
    r = await save({ discount_type: "percent", discount_value: 5, pos_discount_amount: exp.disc, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
    st = await state();
    check("5a re-aplicar 5%", r.status === 200 && near(st.adj_sum, exp.disc), `${st.adj_sum} vs ${exp.disc}`);
    exp = expect({ taxableCents });
    r = await save({ pos_discount_amount: 0, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
    st = await state();
    check("5b re-quitar limpio", r.status === 200 && st.adj_rows === "0", st.adj_rows);

    // ── 6 · mixto taxable/exempt con fixed ──────────────────────────────────
    const exemptItem = linesBefore[0]!.item_id;
    await db.query(`UPDATE order_line_item SET taxable = false WHERE id = $1`, [exemptItem]);
    const mixedTaxable = linesBefore.reduce(
      (s, l) =>
        s +
        (l.item_id !== exemptItem && l.taxable !== false
          ? Math.round(Number(l.unit_price) * 100) * Number(l.quantity)
          : 0),
      0
    );
    exp = expect({ fixed: 40, taxableCents: mixedTaxable });
    r = await save({ discount_type: "fixed", discount_value: 40, pos_discount_amount: 40, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
    st = await state();
    check("6a mixto: tax = fórmula POS (proporción taxable)", r.status === 200 && near(st.s_tax, exp.tax), `${st.s_tax} vs ${exp.tax}`);
    check("6b mixto: total coherente", near(st.s_total, exp.total), `${st.s_total} vs ${exp.total}`);
    // limpiar
    exp = expect({ taxableCents: mixedTaxable });
    await save({ pos_discount_amount: 0, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
    await db.query(`UPDATE order_line_item SET taxable = $2 WHERE id = $1`, [exemptItem, linesBefore[0]!.taxable]);
    exp = expect({ taxableCents });
    await save({ pos_discount_amount: 0, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });

    // ── 7 · rollback inyectado: nada queda a medias ──────────────────────────
    const stClean = await state();
    const pool = new Pool({ connectionString: SB_DB });
    let threw = false;
    try {
      await applyOrderDiscount(pool, ord.id, {
        intent: { type: "fixed", value: Number.NaN },
        tax: { ratePercent: 7, posTaxAmount: 0 },
        promo: { id: null, code: "CPOS-E2E-ROLLBACK" },
      });
    } catch {
      threw = true;
    }
    await pool.end();
    const stAfter = await state();
    check("7a intent ilegible TIRA (refuse-no-guess)", threw, "no tiró");
    check("7b y NADA cambió (rollback completo)", JSON.stringify(stAfter) === JSON.stringify(stClean), "estado difirió tras el rollback");

    // ── 8 · líneas (descuento de PRODUCTO) jamás tocadas ─────────────────────
    const linesAfter = await lineSnapshot();
    check(
      "8 unit_price/quantity de TODAS las líneas intactos",
      JSON.stringify(linesAfter) === JSON.stringify(linesBefore),
      "las líneas cambiaron"
    );

    // ── 9 · orden WEB: el descuento exige PIN y deja huella ──────────────────
    const { rows: chRows } = await db.query<{ id: string }>(
      `SELECT id FROM sales_channel WHERE name ILIKE 'web%' AND deleted_at IS NULL LIMIT 1`
    );
    const { rows: origRows } = await db.query<{ sc: string | null }>(
      `SELECT sales_channel_id AS sc FROM "order" WHERE id = $1`,
      [ord.id]
    );
    await db.query(
      `UPDATE "order" SET sales_channel_id = $2, metadata = metadata - 'pos_created' WHERE id = $1`,
      [ord.id, chRows[0]!.id]
    );
    try {
      exp = expect({ pct: 10, taxableCents });
      r = await save({ discount_type: "percent", discount_value: 10, pos_discount_amount: exp.disc, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 });
      check("9a orden web sin PIN → 403", r.status === 403, `HTTP ${r.status}`);
      const opId = `e2e-chk-${Date.now()}`;
      r = await save(
        { discount_type: "percent", discount_value: 10, pos_discount_amount: exp.disc, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7, web_edit_operation_id: opId },
        realPin
      );
      st = await state();
      check("9b con PIN aplica por el chokepoint", r.status === 200 && near(st.adj_sum, exp.disc), `HTTP ${r.status} adj=${st.adj_sum}`);
      const { rows: fpRows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM order_change
          WHERE order_id = $1 AND change_type = 'pos_activity' AND internal_note LIKE $2`,
        [ord.id, `%"operation_id":"${opId}"%`]
      );
      check("9c huella web_order_edit sellada", fpRows[0]?.n === "1", `${fpRows[0]?.n}`);
      exp = expect({ taxableCents });
      await save({ pos_discount_amount: 0, pos_total: exp.total, pos_tax_amount: exp.tax, pos_tax_rate: 7 }, realPin);
    } finally {
      await db.query(
        `UPDATE "order" SET sales_channel_id = $2,
                metadata = COALESCE(metadata,'{}'::jsonb) || '{"pos_created": true}'::jsonb
          WHERE id = $1`,
        [ord.id, origRows[0]?.sc ?? null]
      );
    }
  } finally {
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks OK ===`);
  if (failed.length) {
    for (const f of failed) console.error(`  • ${f.name}`);
    process.exit(1);
  }
  console.log("✅ el chokepoint cubre la matriz completa");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
