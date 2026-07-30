/**
 * e2e-order-discount-lifecycle-sandbox.ts
 *
 * Reproduce, paso a paso y contra el sandbox, qué le pasa a un descuento de ORDEN
 * cuando se aplica, se borra, y se lo reemplaza por descuentos de ÍTEM.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Siete documentos de producción tienen filas de `order_line_item_adjustment`
 * que el POS no muestra y cuyo monto no se corresponde con ningún porcentaje del
 * subtotal actual:
 *
 *   E2146  el POS muestra 10% sobre 21.786,40 = 2.178,64
 *          la base tiene 1.960,78, que es 10% de 19.607,76 (el subtotal YA descontado)
 *   E2606  QuickBooks recibió "Order Discount (1%)" = 15,99
 *          15,99 es 1% de 1.599,00 — un subtotal que el documento ya no tiene
 *
 * Los artefactos no dicen CÓMO llegaron a ese estado. Este script lo hace pasar.
 *
 * ── Qué mide en cada paso ───────────────────────────────────────────────────
 *   POS       lo que computeTotals del navegador mostraría (la fórmula replicada)
 *   ADJ       Σ de las filas de adjustment vivas, que es lo que el backend resta
 *   GUARDADO  metadata.computed_total
 *   Δ         POS − GUARDADO. Distinto de cero = el documento y el sistema difieren
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-order-discount-lifecycle-sandbox.ts
 *
 * Sandbox-only: aborta si la URL no apunta a localhost:5499. QB Bridge apagado.
 */
import { Pool } from "pg";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const SB_API = process.env.SANDBOX_API ?? "http://localhost:9099";
const EMAIL = process.env.SANDBOX_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.SANDBOX_PASSWORD ?? "sandbox123";

const CUSTOMER_ID = process.env.SANDBOX_CUSTOMER_ID ?? "cus_01KYT2F0B56Q2MKYYKXMSC95HJ";
const TAX_RATE = 0.07;

type Line = {
  variantId: string;
  title: string;
  unitPrice: number;
  quantity: number;
  /** porcentaje de descuento de línea, 0 = ninguno */
  linePct: number;
};

type Snapshot = {
  paso: string;
  posTotal: number;
  posOrderDiscount: number;
  adjSum: number;
  adjCodes: string;
  lineNet: number;
  guardado: number | null;
  computedDiscount: number | null;
  metaTipo: string | null;
  metaValor: string | null;
};

/**
 * `medusa develop` reinicia con CADA escritura en `src/` — incluidas las de otra
 * sesión de Claude Code trabajando en el mismo worktree, que fue exactamente lo
 * que tumbó tres corridas de este script (ECONNREFUSED en medio de un paso).
 * Reintentar sobre "conexión rechazada" hace que el experimento sobreviva al
 * reinicio en vez de reportar un falso fallo.
 */
async function fetchResiliente(
  url: string,
  init: RequestInit,
  intentos = 12
): Promise<Response> {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fetch(url, init);
    } catch (e: any) {
      const rechazada = /ECONNREFUSED|fetch failed/i.test(String(e?.cause ?? e));
      if (!rechazada || i === intentos) throw e;
      console.log(`   … server reiniciando, reintento ${i}/${intentos}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("inalcanzable");
}

async function login(): Promise<string> {
  const r = await fetchResiliente(`${SB_API}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`login falló: ${r.status} ${await r.text()}`);
  return (await r.json()).token as string;
}

/**
 * La MISMA convención que `computeTotals` del POS (store-pos/lib/pos-totals.ts):
 * el descuento de línea redondea por unidad, y el de ORDEN se aplica sobre el
 * neto POST-descuento-de-línea, redondeando por línea.
 */
function posTotals(
  lines: Line[],
  orderPct: number
): { subtotal: number; orderDiscount: number; tax: number; total: number } {
  let afterLineCents = 0;
  let orderDiscCents = 0;
  for (const l of lines) {
    const unitCents = Math.round(l.unitPrice * 100);
    const netUnit =
      l.linePct > 0
        ? Math.round(unitCents * (1 - l.linePct / 100))
        : unitCents;
    const lineNet = netUnit * l.quantity;
    afterLineCents += lineNet;
    if (orderPct > 0) orderDiscCents += Math.round(lineNet * (orderPct / 100));
  }
  const taxable = afterLineCents - orderDiscCents;
  const taxCents = Math.round(taxable * TAX_RATE);
  return {
    subtotal: afterLineCents / 100,
    orderDiscount: orderDiscCents / 100,
    tax: taxCents / 100,
    total: (taxable + taxCents) / 100,
  };
}

function body(
  lines: Line[],
  orderPct: number,
  id?: string,
  promoCode?: string | null
) {
  const t = posTotals(lines, orderPct);
  return {
    // El descuento de ORDEN no lo materializan `discount_type`/`discount_value`:
    // los adjustments los crea la PROMOCIÓN (`/admin/pos-discount` →
    // `CPOS-PCT-####`). Mandar sólo los dos primeros deja el descuento sin
    // efecto — medido: ADJ 0.00 y el total guardado ignora el descuento.
    promotion_code: promoCode ?? null,
    // `action` NO es opcional: sin él la ruta contesta 200 con
    // {success:true, cart_id:null} y no crea ni actualiza nada — el
    // `resolvedId` queda undefined y sólo se nota en el log del server
    // (`GET /admin/draft-orders/undefined/compute-tax → 404`).
    action: id ? "update" : "create",
    payload: id
      ? undefined
      : { email: "sandbox@test.com", customer_id: CUSTOMER_ID },
    customer_id: CUSTOMER_ID,
    ...(id ? { id } : {}),
    items: lines.map((l, i) => {
      const unitCents = Math.round(l.unitPrice * 100);
      const netUnit =
        l.linePct > 0 ? Math.round(unitCents * (1 - l.linePct / 100)) : unitCents;
      return {
        variantId: l.variantId,
        quantity: l.quantity,
        effectiveUnitPrice: netUnit / 100,
        unitPrice: l.unitPrice,
        lineDiscount:
          l.linePct > 0 ? { type: "percent", value: l.linePct } : null,
        title: l.title,
        salesDescription: l.title,
        sortOrder: i,
        priceListId: null,
        priceListLabel: "Default",
      };
    }),
    shipping_option_id: null,
    shipping_price: 0,
    promotion_id: null,
    discount_type: orderPct > 0 ? "percent" : null,
    discount_value: orderPct > 0 ? orderPct : null,
    order_discount: t.orderDiscount,
  };
}

async function save(
  token: string,
  lines: Line[],
  orderPct: number,
  id?: string,
  promoCode?: string | null
): Promise<string> {
  const r = await fetchResiliente(`${SB_API}/admin/draft-orders/sync-pos`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body(lines, orderPct, id, promoCode)),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`sync-pos ${r.status}: ${txt.slice(0, 400)}`);
  const j = JSON.parse(txt);
  const oid = (j.draft_order_id ?? id) as string | undefined;
  if (!oid) {
    throw new Error(
      `sync-pos contestó 200 sin draft_order_id — no creó nada. Respuesta: ${txt.slice(0, 200)}`
    );
  }
  return oid;
}

async function snapshot(
  pool: Pool,
  id: string,
  paso: string,
  lines: Line[],
  orderPct: number
): Promise<Snapshot> {
  const t = posTotals(lines, orderPct);
  const { rows } = await pool.query<{
    adj_sum: string | null;
    adj_codes: string | null;
    line_net: string | null;
    computed_total: string | null;
    computed_discount: string | null;
    meta_tipo: string | null;
    meta_valor: string | null;
  }>(
    `SELECT
       (SELECT COALESCE(SUM(ABS(x.amount)),0) FROM order_item oi
          JOIN order_line_item li ON li.id = oi.item_id
          CROSS JOIN LATERAL (
            SELECT DISTINCT ON (a.code) a.amount
              FROM order_line_item_adjustment a
             WHERE a.item_id = li.id AND a.deleted_at IS NULL
             ORDER BY a.code, a.version DESC) x
         WHERE oi.order_id = o.id AND oi.version = o.version) AS adj_sum,
       (SELECT string_agg(DISTINCT a.code, ',') FROM order_item oi
          JOIN order_line_item_adjustment a ON a.item_id = oi.item_id
         WHERE oi.order_id = o.id AND oi.version = o.version AND a.deleted_at IS NULL) AS adj_codes,
       (SELECT COALESCE(SUM(li2.unit_price*oi2.quantity),0) FROM order_item oi2
          JOIN order_line_item li2 ON li2.id = oi2.item_id
         WHERE oi2.order_id = o.id AND oi2.version = o.version) AS line_net,
       o.metadata->>'computed_total'    AS computed_total,
       o.metadata->>'computed_discount' AS computed_discount,
       o.metadata->>'discount_type'     AS meta_tipo,
       o.metadata->>'discount_value'    AS meta_valor
     FROM "order" o WHERE o.id = $1`,
    [id]
  );
  const r = rows[0]!;
  return {
    paso,
    posTotal: t.total,
    posOrderDiscount: t.orderDiscount,
    adjSum: Number(r.adj_sum ?? 0),
    adjCodes: r.adj_codes ?? "—",
    lineNet: Number(r.line_net ?? 0),
    guardado: r.computed_total == null ? null : Number(r.computed_total),
    computedDiscount:
      r.computed_discount == null ? null : Number(r.computed_discount),
    metaTipo: r.meta_tipo,
    metaValor: r.meta_valor,
  };
}

function fila(s: Snapshot): string {
  const d =
    s.guardado == null ? "—" : (s.posTotal - s.guardado).toFixed(2).padStart(9);
  const flag =
    s.guardado != null && Math.abs(s.posTotal - s.guardado) > 0.005 ? " ⟵ DIFIEREN" : "";
  return (
    `${s.paso.padEnd(38)} POS ${s.posTotal.toFixed(2).padStart(9)} · ` +
    `descOrden ${s.posOrderDiscount.toFixed(2).padStart(8)} · ` +
    `ADJ ${s.adjSum.toFixed(2).padStart(8)} · ` +
    `guardado ${(s.guardado?.toFixed(2) ?? "—").padStart(9)} · Δ ${d}${flag}`
  );
}

async function main(): Promise<void> {
  if (!/@(localhost|127\.0\.0\.1):5499/.test(SB_DB)) {
    throw new Error(`ABORTA: ${SB_DB} no es la sandbox`);
  }
  const pool = new Pool({ connectionString: SB_DB });
  const token = await login();

  const { rows: vs } = await pool.query<{ id: string; title: string }>(
    `SELECT pv.id, COALESCE(p.title,'item') AS title
       FROM product_variant pv JOIN product p ON p.id = pv.product_id
      WHERE pv.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status='published'
        AND p.title NOT ILIKE '%shipping%'
      ORDER BY pv.id LIMIT 3`
  );
  if (vs.length < 3) throw new Error("no hay 3 variantes publicadas en sandbox");

  // Precios redondos para que la aritmética se lea sin esfuerzo.
  const base: Line[] = vs.map((v, i) => ({
    variantId: v.id,
    title: v.title.slice(0, 28),
    unitPrice: [100, 200, 300][i]!,
    quantity: 1,
    linePct: 0,
  }));
  const conItemDisc: Line[] = base.map((l) => ({ ...l, linePct: 20 }));

  console.log("\nE2E — ciclo de vida del descuento de ORDEN (sandbox)");
  console.log("=".repeat(122));
  console.log(
    "líneas: 100 + 200 + 300 = 600 bruto · impuesto 7% · descuento de ítem 20% donde aplique\n"
  );

  const out: Snapshot[] = [];

  /** El camino real del POS: crea/encuentra la promo canónica CPOS-PCT-#### y la aplica. */
  const aplicarPromo = async (oid: string, pct: number): Promise<string | null> => {
    const r = await fetchResiliente(`${SB_API}/admin/pos-discount`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        order_id: oid,
        discount_type: "percent",
        discount_value: pct,
      }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`pos-discount ${r.status}: ${txt.slice(0, 300)}`);
    return (JSON.parse(txt).promotion_code as string | undefined) ?? null;
  };

  const step = async (
    paso: string,
    lines: Line[],
    pct: number,
    id?: string
  ): Promise<string> => {
    let promo: string | null = null;
    if (pct > 0 && id) promo = await aplicarPromo(id, pct);
    const oid = await save(token, lines, pct, id, promo);
    await new Promise((r) => setTimeout(r, 1200)); // dejar asentar el write
    const s = await snapshot(pool, oid, paso, lines, pct);
    out.push(s);
    console.log(fila(s));
    console.log(
      `${" ".repeat(38)}   base en DB (Σ precio×qty) ${s.lineNet.toFixed(2)} · códigos: ${s.adjCodes} · metadata: ${s.metaTipo ?? "—"} ${s.metaValor ?? ""}`
    );
    return oid;
  };

  const stepPreset = async (
    paso: string,
    lines: Line[],
    oid: string
  ): Promise<string> => {
    const r = await fetchResiliente(`${SB_API}/admin/pos-discount/apply-existing`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        order_id: oid,
        promotion_code: "ORDER-DISCOUNT-10%",
        promotion_id: "promo_01KKCPPYT83DWS2S9MKDM557T9",
      }),
    });
    if (!r.ok)
      throw new Error(`apply-existing ${r.status}: ${(await r.text()).slice(0, 300)}`);
    // Snapshot INTERMEDIO: separa lo que hizo apply-existing de lo que hace el
    // guardado posterior. Sin esto los dos efectos se leen como uno solo.
    await new Promise((res) => setTimeout(res, 1200));
    const sMid = await snapshot(pool, oid, `${paso} [tras apply-existing]`, lines, 10);
    out.push(sMid);
    console.log(fila(sMid));
    console.log(
      `${" ".repeat(38)}   base en DB (Σ precio×qty) ${sMid.lineNet.toFixed(2)} · códigos: ${sMid.adjCodes}`
    );
    const out2 = await save(token, lines, 10, oid, "ORDER-DISCOUNT-10%");
    await new Promise((res) => setTimeout(res, 1200));
    const s2 = await snapshot(pool, out2, paso, lines, 10);
    out.push(s2);
    console.log(fila(s2));
    console.log(
      `${" ".repeat(38)}   base en DB (Σ precio×qty) ${s2.lineNet.toFixed(2)} · códigos: ${s2.adjCodes} · metadata: ${s2.metaTipo ?? "—"} ${s2.metaValor ?? ""}`
    );
    return out2;
  };

  let id = await step("1. creado, SIN descuentos", base, 0);
  id = await step("2. aplico descuento de ORDEN 10%", base, 10, id);
  id = await step("3. BORRO el descuento de orden", base, 0, id);
  id = await step("4. aplico descuentos de ÍTEM 20%", conItemDisc, 0, id);
  id = await step("5. re-aplico ORDEN 10% encima", conItemDisc, 10, id);
  id = await step("6. BORRO el de orden otra vez", conItemDisc, 0, id);
  // La hipótesis de E2146: el mismo descuento aplicado DOS veces se recalcula
  // sobre su propio resultado. 10% de 480 = 48; si se re-aplica, 10% de 432 = 43,20.
  id = await step("7. aplico ORDEN 10%", conItemDisc, 10, id);
  id = await step("8. re-aplico el MISMO 10% sin tocar nada", conItemDisc, 10, id);
  id = await step("9. y una tercera vez", conItemDisc, 10, id);
  // Cambiar el PORCENTAJE crea un código distinto: el viejo tiene que morir.
  id = await step("10. cambio el porcentaje a 5%", conItemDisc, 5, id);
  id = await step("11. y de vuelta a 10%", conItemDisc, 10, id);
  // La ruta de promo PRESET — la que dejó ORDER-DISCOUNT-* en los documentos rotos.
  id = await stepPreset("12. aplico promo PRESET ORDER-DISCOUNT-10%", conItemDisc, id);
  id = await step("13. borro TODO descuento de orden", conItemDisc, 0, id);

  console.log("=".repeat(122));
  const rotos = out.filter(
    (s) => s.guardado != null && Math.abs(s.posTotal - s.guardado) > 0.005
  );
  const huerfanos = out.filter((s) => s.posOrderDiscount === 0 && s.adjSum > 0.005);

  console.log(`\ndocumento de prueba: ${id}\n`);
  if (huerfanos.length > 0) {
    console.log(
      `⚠️  ADJUSTMENTS HUÉRFANOS en ${huerfanos.length} paso(s): el POS no muestra descuento de orden y la base igual tiene filas:`
    );
    for (const h of huerfanos)
      console.log(`      ${h.paso} → ADJ ${h.adjSum.toFixed(2)} (${h.adjCodes})`);
  } else {
    console.log("✅ ningún paso dejó adjustments huérfanos");
  }
  if (rotos.length > 0) {
    console.log(
      `\n❌ el total guardado se separó del documento en ${rotos.length} paso(s)`
    );
    process.exitCode = 1;
  } else {
    console.log("\n✅ el total guardado siguió al documento en todos los pasos");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
