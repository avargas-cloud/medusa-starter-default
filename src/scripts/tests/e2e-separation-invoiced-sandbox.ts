/**
 * E2E — separación vs facturado (2026-08-14). SANDBOX ONLY.
 *
 * ── Qué prueba ───────────────────────────────────────────────────────────────
 *  1. BASELINE — orden abierta sin invoices: la lista (`/admin/orders/filter`,
 *     la ruta de la pantalla) reporta `separation_pending.pending` = qty, y el
 *     modal (`product-status`) coincide.
 *  2. LEGACY (allocator FIFO) — un invoice SIN order_line_item_id insertado por
 *     SQL (la forma de todo invoice pre-2026-08-08) baja `pending` y sube
 *     `invoiced`/`open_qty` del modal SIN ningún evento: la derivación es por
 *     request, no por flag.
 *  3. STAMP (el fix del gate) — un invoice REAL por API por el resto de la
 *     línea dispara pos.invoice.created y el subscriber estampa
 *     metadata.fully_invoiced=true en una orden con CERO separación — el gate
 *     viejo retornaba antes de computar para estas órdenes, exactamente el bug
 *     (S2918). Control positivo: el flag APARECE, no solo "no hay pending".
 *  4. VOID (reversión derivada) — voidear el invoice API dispara
 *     pos.invoice.voided → flag vuelve a false y pending vuelve a 1 (el legacy
 *     sigue cubriendo el resto). Nada que "des-escribir": era derivado.
 *  5. NEGATIVAS — order_line_separation queda VACÍA para la orden (facturar
 *     jamás fabrica separación física) y reservation_item/inventory_level
 *     quedan byte-iguales (facturar no toca stock ni reservas).
 *  2b/3b/4b. PISO EN EL ESTADO (2026-08-25) — `separation_status` derivado por
 *     product-status sigue al piso facturado en las dos direcciones: piso
 *     parcial ⇒ partial, piso total ⇒ full (sin una sola fila física), y tras
 *     el void vuelve a partial. Pre-fix los tres decían `none` (el botón del
 *     toolbar contra el modal y la lista — 3021/S11432).
 *
 * Todos los writes se revierten (invoices borrados, metadata restaurada).
 *
 * ── Cómo correrlo ────────────────────────────────────────────────────────────
 *   ./back-sb    # backend sandbox en :9099 (con el código NUEVO — reiniciar)
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-separation-invoiced-sandbox.ts
 */
import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`ABORT: ${why}`);
  process.exit(2);
}
if (!SB_DB.includes("5499")) abort("SANDBOX_DATABASE_URL no apunta al sandbox (5499)");
if (!BASE.includes("9099")) abort("SANDBOX_BASE_URL no apunta al sandbox (9099)");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — status alone decides */
  }
  return { status: res.status, json };
}

async function filterRow(token: string, orderId: string): Promise<any | null> {
  const res = await api(token, "GET", "/admin/orders/filter?tab=all");
  if (res.status !== 200) return null;
  const rows = (res.json?.orders ?? res.json?.rows ?? []) as any[];
  return rows.find((r) => r.id === orderId) ?? null;
}

const MEILI = process.env.SANDBOX_MEILI_URL ?? "http://localhost:7799";
const MEILI_KEY = process.env.SANDBOX_MEILI_KEY ?? "sandbox_master_key";

async function meiliDoc(orderId: string): Promise<any | null> {
  const res = await fetch(`${MEILI}/indexes/orders/documents/${orderId}`, {
    headers: { Authorization: `Bearer ${MEILI_KEY}` },
  });
  return res.ok ? await res.json() : null;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20000
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - start > timeoutMs) {
      console.error(`  (timeout esperando: ${what})`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const loginRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  const token = (await loginRes.json())?.token;
  if (!token) abort("login sandbox falló");

  // ── Fixture: orden pending de UNA línea (qty ≥ 2), sin invoices, sin
  // separación, con variant y customer (el invoice API los necesita) ─────────
  const fx = await db.query(`
    SELECT o.id AS order_id, o.display_id, o.customer_id,
           oli.id AS line_id, oli.variant_id, oli.variant_sku AS sku,
           oli.title AS title, oi.quantity::numeric AS qty
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
     WHERE o.deleted_at IS NULL AND o.status = 'pending' AND o.is_draft_order = false
       AND o.customer_id IS NOT NULL
       AND oli.variant_id IS NOT NULL
       -- Una línea sin inventory item está FUERA del dominio de separación
       -- (2026-08-24): con un servicio de fixture todo deriva none/pending=0
       -- y los 19 checks miden la exclusión, no la feature.
       AND EXISTS (SELECT 1 FROM product_variant_inventory_item pvii
                    WHERE pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL)
       AND oi.quantity::numeric >= 2
       AND COALESCE(oi.fulfilled_quantity::numeric, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM pos_invoice pi
                        WHERE pi.order_id = o.id AND pi.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM order_line_separation s WHERE s.order_id = o.id)
       AND COALESCE(o.metadata->>'is_separated', 'false') <> 'true'
       AND COALESCE(o.metadata->>'fully_invoiced', 'false') <> 'true'
       AND (SELECT COUNT(*) FROM order_item oi2
             WHERE oi2.order_id = o.id AND oi2.version = o.version
               AND oi2.deleted_at IS NULL) = 1
     ORDER BY o.created_at DESC
     LIMIT 10`);
  if (!fx.rows.length) abort("no hay orden fixture (1 línea, sin invoices) en el sandbox");

  // La ruta de la pantalla resuelve membership por Meili: elegir un candidato
  // que el índice del sandbox realmente conozca.
  let f: any = null;
  for (const cand of fx.rows) {
    if (await filterRow(token, cand.order_id)) {
      f = cand;
      break;
    }
  }
  if (!f)
    abort(
      "ningún candidato está en el índice orders del sandbox — correr sync-meili-orders"
    );
  const qty = Number(f.qty);
  console.log(`Fixture: S${f.display_id} (${f.order_id}) línea ${f.line_id} qty ${qty}`);

  const metaBefore = (
    await db.query(`SELECT metadata FROM "order" WHERE id = $1`, [f.order_id])
  ).rows[0].metadata;

  // Filas completas, no sólo el hash: un byte-igual que falla sin nombrar la
  // fila que cambió no se puede diagnosticar (pasó 2026-08-25 — el md5 global
  // dijo "distinto" y nada decía qué ni por qué).
  const invSnapshot = async (): Promise<Map<string, string>> => {
    const res = await db.query(
      `SELECT id || ':' || COALESCE(quantity::text,'') AS row_text FROM reservation_item WHERE deleted_at IS NULL
       UNION ALL
       SELECT id || ':' || COALESCE(stocked_quantity::text,'') || ':' ||
              COALESCE(reserved_quantity::text,'')
         FROM inventory_level WHERE deleted_at IS NULL`
    );
    const m = new Map<string, string>();
    for (const r of res.rows as Array<{ row_text: string }>) {
      const [id] = r.row_text.split(":", 1);
      m.set(id, r.row_text);
    }
    return m;
  };
  const diffSnapshots = (a: Map<string, string>, b: Map<string, string>): string[] => {
    const out: string[] = [];
    for (const [id, v] of a) if (b.get(id) !== v) out.push(`${v} → ${b.get(id) ?? "(gone)"}`);
    for (const [id, v] of b) if (!a.has(id)) out.push(`(new) → ${v}`);
    return out;
  };
  const invBefore = await invSnapshot();

  const e2eIds = {
    invoice: `e2esep_inv_${Date.now()}`,
    item: `e2esep_item_${Date.now()}`,
  };
  let apiInvoiceId: string | null = null;

  try {
    // ── 1. Baseline ──────────────────────────────────────────────────────────
    console.log("\n1. Baseline sin invoices");
    const row0 = await filterRow(token, f.order_id);
    check(
      `lista: pending=${qty} (todo por separar)`,
      row0?.separation_pending?.pending === qty,
      JSON.stringify(row0?.separation_pending)
    );
    const ps0 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    const line0 = ps0.json?.lines?.find((l: any) => l.line_id === f.line_id);
    check("modal: invoiced=0, open_qty=qty", line0?.invoiced === 0 && line0?.open_qty === qty,
      `invoiced=${line0?.invoiced} open=${line0?.open_qty}`);

    // ── 2. Invoice LEGACY por SQL (sin order_line_item_id, sin evento) ──────
    console.log(`\n2. Invoice legacy por SQL (${qty - 1} unidades, sin line id)`);
    const raw = (v: number) => JSON.stringify({ value: String(v), precision: 20 });
    await db.query(
      `INSERT INTO pos_invoice (id, invoice_number, order_id, customer_id, status,
                                subtotal, discount, shipping, tax, total, amount_paid, balance_due,
                                untaxed_total, refunded_amount, refunded_shipping,
                                raw_subtotal, raw_discount, raw_tax, raw_total, raw_amount_paid, raw_balance_due,
                                created_at, updated_at)
       VALUES ($1, 'E2E-999901', $2, $3, 'paid',
               1000, 0, 0, 0, 1000, 1000, 0,
               1000, 0, 0,
               $4::jsonb, $5::jsonb, $5::jsonb, $4::jsonb, $4::jsonb, $5::jsonb,
               now(), now())`,
      [e2eIds.invoice, f.order_id, f.customer_id, raw(1000), raw(0)]
    );
    await db.query(
      `INSERT INTO pos_invoice_item (id, invoice_id, variant_id, sku, description,
                                     quantity, unit_price, total, refunded_quantity, taxable,
                                     raw_unit_price, raw_total, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'e2e legacy line', $5, 100, 100, 0, true,
               $6::jsonb, $6::jsonb, now(), now())`,
      [e2eIds.item, e2eIds.invoice, f.variant_id, f.sku, qty - 1, raw(100)]
    );

    // Facturar NO baja el pending ni el open (2026-08-20, supersede la
    // expectativa original de este archivo): la factura es acto de cobro, no
    // de depósito — fija el PISO de la separación. El allocator FIFO sí
    // ATRIBUYE lo facturado a la línea (invoiced sube), que es lo que este
    // paso existe para probar.
    const row1 = await filterRow(token, f.order_id);
    check(
      `lista: pending=${qty} intacto (facturar no es trabajo de depósito)`,
      row1?.separation_pending?.pending === qty,
      JSON.stringify(row1?.separation_pending)
    );
    const ps1 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    const line1 = ps1.json?.lines?.find((l: any) => l.line_id === f.line_id);
    check(
      `modal: invoiced=${qty - 1} (allocator FIFO), open_qty=${qty} veraz`,
      line1?.invoiced === qty - 1 && line1?.open_qty === qty,
      `invoiced=${line1?.invoiced} open=${line1?.open_qty}`
    );
    const flagAfterSql = (
      await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
    ).rows[0].v;
    check("flag sigue ausente (ningún evento corrió — derivación pura)", flagAfterSql === null, `v=${flagAfterSql}`);
    // 2b. El PISO cuenta como apartado para el ESTADO (2026-08-25): qty−1
    // facturadas sin fila física ⇒ partial, no none. Pre-fix los llamadores
    // pasaban el `separated` crudo y esta orden derivaba `none` — la clase que
    // dejó a 3021/S11432 con el botón en "Partially Separated" contra un modal
    // y una lista en full.
    check(
      "product-status: separation_status=partial (piso parcial, cero filas físicas)",
      ps1.json?.order?.separation_status === "partial",
      `status=${ps1.json?.order?.separation_status}`
    );

    // ── 3. Invoice REAL por API → evento → stamp (el fix) ────────────────────
    console.log("\n3. Invoice real por API (última unidad) → pos.invoice.created");
    // Idempotency-Key único por corrida: sin él, el dedup por content
    // fingerprint matchea el attempt de una corrida ANTERIOR (cuyo invoice el
    // revert ya borró) y la ruta devuelve 404 sobre un id muerto.
    const invRes = await api(token, "POST", "/admin/invoices", {
      order_id: f.order_id,
      order_display_id: f.display_id,
      customer_id: f.customer_id,
      items: [
        {
          order_line_item_id: f.line_id,
          variant_id: f.variant_id,
          sku: f.sku ?? undefined,
          description: f.title || f.sku || "e2e line",
          quantity: 1,
          unit_price: 1000,
          total: 1000,
        },
      ],
      subtotal: 1000,
      shipping: 0,
      tax: 0,
      total: 1000,
      amount_paid: 0,
    }, { "Idempotency-Key": `e2e-sep-inv-${Date.now()}` });
    apiInvoiceId = invRes.json?.invoice?.id ?? null;
    check("invoice API creado", (invRes.status === 200 || invRes.status === 201) && !!apiInvoiceId,
      `status ${invRes.status} ${JSON.stringify(invRes.json).slice(0, 200)}`);

    const stamped = await waitFor("stamp de fully_invoiced tras el evento", async () => {
      const v = (
        await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
      ).rows[0].v;
      return v === "true" ? true : null;
    });
    check(
      "CONTROL POSITIVO: fully_invoiced=true estampado en orden con CERO separación",
      stamped === true
    );
    // Facturado al 100% NO anula el trabajo de depósito (2026-08-20, supersede
    // el `pending=0` original de este check): la mercadería sigue en el
    // estante hasta el pickup/despacho, y la lista lo anuncia. El estado full
    // (3b abajo) y el pending>0 conviven — son los dos slots de la columna.
    const row2 = await filterRow(token, f.order_id);
    check(
      `lista: pending=${qty} aún con todo facturado (la factura no mueve mercadería)`,
      row2?.separation_pending?.pending === qty,
      JSON.stringify(row2?.separation_pending)
    );
    // Badge + tab (owner 2026-08-14): una orden ABIERTA fully invoiced entra al
    // tab Separated — el doc Meili (lo que SEPARATED_TAB_FILTER filtra) dice
    // "full", y is_separated NO se ensancha (sigue espejo del metadata físico).
    const docFull = await waitFor("doc Meili separation_state=full", async () => {
      const d = await meiliDoc(f.order_id);
      return d?.separation_state === "full" ? d : null;
    });
    check(
      "doc Meili: separation_state=full (membership del tab Separated)",
      docFull?.separation_state === "full",
      `state=${docFull?.separation_state}`
    );
    check(
      "doc Meili: is_separated sigue false (no se ensancha)",
      docFull?.is_separated === false,
      `is_separated=${docFull?.is_separated}`
    );
    // 3b. Con TODO facturado y ninguna fila física, la derivación viva dice
    // full — el mismo valor que el badge de la lista deriva por el atajo
    // fully_invoiced. Pre-fix decía `none` y el botón contradecía a la lista.
    const ps2 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    check(
      "product-status: separation_status=full (piso cubre todo, cero filas físicas)",
      ps2.json?.order?.separation_status === "full",
      `status=${ps2.json?.order?.separation_status}`
    );

    // ── 4. Void → evento → el flag y el pending REVIERTEN solos ─────────────
    console.log("\n4. Void del invoice API → pos.invoice.voided");
    const voidRes = await api(token, "POST", `/admin/invoices/${apiInvoiceId}/void`, {
      reason: "e2e revert",
    });
    check("void 200", voidRes.status === 200, `status ${voidRes.status}`);
    const unstamped = await waitFor("flag vuelve a false tras el void", async () => {
      const v = (
        await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
      ).rows[0].v;
      return v === "false" ? true : null;
    });
    check("flag=false tras void (recompute por evento)", unstamped === true);
    const row3 = await filterRow(token, f.order_id);
    check(
      `lista: pending=${qty} de nuevo (cae el gate de fully_invoiced, nada se facturó al depósito)`,
      row3?.separation_pending?.pending === qty,
      JSON.stringify(row3?.separation_pending)
    );
    const docNone = await waitFor("doc Meili vuelve a none tras void", async () => {
      const d = await meiliDoc(f.order_id);
      return d?.separation_state === "none" ? d : null;
    });
    check(
      "doc Meili: separation_state=none tras void (sale del tab)",
      docNone?.separation_state === "none",
      `state=${docNone?.separation_state}`
    );
    // 4b. El void baja el piso de la línea a qty−1 (queda el invoice legacy):
    // la derivación viva vuelve a partial — sigue al piso en las dos
    // direcciones, nunca queda pegada en full.
    const ps3 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    check(
      "product-status: separation_status=partial tras void (el piso baja con él)",
      ps3.json?.order?.separation_status === "partial",
      `status=${ps3.json?.order?.separation_status}`
    );

    // ── 5. Negativas ─────────────────────────────────────────────────────────
    console.log("\n5. Negativas");
    const sepRows = await db.query(
      `SELECT COUNT(*)::int AS n FROM order_line_separation WHERE order_id = $1`,
      [f.order_id]
    );
    check("order_line_separation VACÍA — facturar jamás fabrica separación física",
      sepRows.rows[0].n === 0);
    const invAfter = await invSnapshot();
    const invDiff = diffSnapshots(invBefore, invAfter);
    check(
      "reservation_item + inventory_level byte-iguales",
      invDiff.length === 0,
      invDiff.slice(0, 5).join(" | ")
    );
  } finally {
    // ── Revert ───────────────────────────────────────────────────────────────
    console.log("\nRevert del sandbox…");
    await db.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [e2eIds.invoice]);
    await db.query(`DELETE FROM pos_invoice WHERE id = $1`, [e2eIds.invoice]);
    if (apiInvoiceId) {
      await db.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [apiInvoiceId]);
      await db.query(`DELETE FROM invoice_payment WHERE invoice_id = $1`, [apiInvoiceId]).catch(() => {});
      await db.query(`DELETE FROM invoice_tracking WHERE invoice_id = $1`, [apiInvoiceId]).catch(() => {});
      await db.query(`DELETE FROM pos_invoice WHERE id = $1`, [apiInvoiceId]);
      await db.query(
        `DELETE FROM qb_order_pipeline WHERE reference_id = $1`,
        [apiInvoiceId]
      ).catch(() => {});
    }
    // El claim de idempotencia sobrevive al DELETE del invoice y una corrida
    // futura con el mismo payload heredaría un id muerto → limpiarlo también.
    await db.query(
      `DELETE FROM invoice_create_attempt
        WHERE invoice_id = ANY($1::text[])`,
      [[e2eIds.invoice, apiInvoiceId].filter(Boolean)]
    ).catch(() => {});
    await db.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [
      f.order_id,
      JSON.stringify(metaBefore ?? {}),
    ]);
    await db.end();
  }

  console.log(`\n${pass} ✓ / ${fail} ✗`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
