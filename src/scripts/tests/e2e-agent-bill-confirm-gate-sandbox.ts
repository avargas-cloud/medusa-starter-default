/**
 * E2E — cuándo un regular bill puede CONFIRMARSE. SANDBOX ONLY.
 *
 * ── La regla ──────────────────────────────────────────────────────────────────
 * Un bill de AGENTE DE COMPRAS cubre el purchase order entero (el agente no
 * emite facturas por embarque), así que sólo se confirma con el PO recibido
 * COMPLETO. Todos los demás conservan el confirm por embarque.
 *
 * ── Qué agrega sobre los unit tests ───────────────────────────────────────────
 * El SQL. `decideConfirmReceiptRequirement` ya está testeada con objetos planos;
 * lo que ahí no se puede tocar es si los JOIN, el GREATEST y los COALESCE de
 * `loadConfirmReceiptFacts` leen lo que dicen leer contra Postgres real. Esa es
 * la mitad que rompe en silencio: un JOIN mal escrito devuelve 0/0, y 0 >= 0 se
 * lee como "llegó completo" — el gate se apaga solo y todo queda en verde.
 * Por eso el caso "0 recibidas" se afirma explícitamente como BLOQUEADO.
 *
 * ── El control negativo es la mitad del test ──────────────────────────────────
 * Un gate que exigiera PO completo a TODOS también pondría en verde el caso del
 * agente, y rompería el billing por embarque de los vendors locales, que es el
 * flujo diario de compras. Se afirma que un vendor normal parcialmente recibido
 * SIGUE pudiendo confirmar.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-agent-bill-confirm-gate-sandbox.ts
 */
import { randomUUID } from "crypto";

import { Client } from "pg";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("\n❌ ABORTADO: sólo contra la DB del sandbox (5499)\n");
  process.exit(2);
}

const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

let seqCounter = 0;

interface Fx {
  poId: string;
  vendorId: string;
  billId: string;
  locationId: string;
  variantId: string;
  itemId: string;
  lineIds: string[];
}

interface PlantOpts {
  isAgent: boolean;
  /** [ordered, cancelled, received] por línea. */
  lines: Array<[number, number, number]>;
  /** Estampa purchase_order.status — el gate NO debe mirarlo. */
  poStatus?: string;
}

async function plant(db: Client, o: PlantOpts): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    poId: randomUUID(),
    vendorId: `qbvnd_ag_${n}`,
    billId: randomUUID(),
    locationId: `sloc_ag_${n}`,
    variantId: `variant_ag_${n}`,
    itemId: `iitem_ag_${n}`,
    lineIds: [],
  };

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, $4::jsonb, NOW(), NOW())`,
    [
      f.vendorId,
      `QBV-AG-${n}`,
      `Agent Gate E2E ${n}`,
      JSON.stringify(o.isAgent ? { is_china_agent: true } : {}),
    ]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'AG E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
     VALUES ($1, 'AG variant', '{}'::jsonb, NOW(), NOW())`,
    [f.variantId]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_ag', $4, $5, $6, $7)`,
    [
      f.poId, f.vendorId, f.locationId,
      o.poStatus ?? "partially_received",
      `PO-AG-${n}`, 992000 + (seqCounter += 1), `QBPO-AG-${n}`,
    ]
  );
  for (const [ordered, cancelled, received] of o.lines) {
    const lineId = randomUUID();
    f.lineIds.push(lineId);
    await db.query(
      `INSERT INTO purchase_order_line
         (id, purchase_order_id, product_variant_id, inventory_item_id,
          sku_snapshot, description_snapshot, qty_ordered, qty_cancelled,
          qty_received, unit_cost_cents, total_cents)
       VALUES ($1, $2, $3, $4, 'SKU-AG', 'AG goods', $5, $6, $7, 1000, $8)`,
      [lineId, f.poId, f.variantId, f.itemId, ordered, cancelled, received, ordered * 1000]
    );
  }
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
        reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date)
     VALUES ($1, $2, 'draft', 'regular', $3, $4, $5, 'Agent Gate E2E', NOW())`,
    [f.billId, f.poId, `VB-AG-${n}`, `REF-AG-${n}`, `QBV-AG-${n}`]
  );
  return f;
}

async function cleanup(db: Client, all: Fx[]): Promise<void> {
  for (const f of all) {
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [f.billId]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [f.billId]);
    await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
    await db.query(`DELETE FROM product_variant WHERE id = $1`, [f.variantId]);
    await db.query(`DELETE FROM inventory_item WHERE id = $1`, [f.itemId]);
    await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
    await db.query(`DELETE FROM qb_vendor WHERE id = $1`, [f.vendorId]);
  }
}

async function main(): Promise<void> {
  console.log("=== e2e-agent-bill-confirm-gate (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();
  const knexLike = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pg = sql.replace(/\?/g, () => `$${++i}`);
      const r = await db.query(pg, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };

  const { loadConfirmReceiptFacts, decideConfirmReceiptRequirement } = await import(
    "../../lib/purchase-orders/po-receipt-completeness"
  );
  const verdictFor = async (billId: string) => {
    const f = await loadConfirmReceiptFacts(knexLike as never, billId);
    if (!f) throw new Error("facts not found");
    return { f, v: decideConfirmReceiptRequirement(f) };
  };

  const planted: Fx[] = [];
  try {
    // ── §1 · Agente con el PO incompleto ──────────────────────────────────────
    console.log("§1 — agente, PO incompleto (el caso de PO-1153: 320/327)");
    const a = await plant(db, { isAgent: true, lines: [[300, 0, 300], [27, 0, 20]] });
    planted.push(a);
    const ra = await verdictFor(a.billId);
    check("el SQL mide 327 ordenadas", ra.f.qty_ordered === 327, `dio ${ra.f.qty_ordered}`);
    check("y 320 recibidas", ra.f.qty_received === 320, `dio ${ra.f.qty_received}`);
    check("lo reconoce como compra de AGENTE", ra.f.is_agent_purchase === true);
    check("BLOQUEA el confirm", ra.v.satisfied === false, ra.v.reason);
    check("y dice cuántas faltan", !ra.v.satisfied && ra.v.qty_outstanding === 7,
      JSON.stringify(ra.v));

    // ── §2 · El mismo PO, ya completo ─────────────────────────────────────────
    console.log("\n§2 — agente, PO completo");
    const b = await plant(db, { isAgent: true, lines: [[300, 0, 300], [27, 0, 27]] });
    planted.push(b);
    const rb = await verdictFor(b.billId);
    check("deja confirmar", rb.v.satisfied === true, rb.v.reason);

    // ── §3 · Las unidades canceladas NO cuentan como faltantes ────────────────
    console.log("\n§3 — lo cancelado sale del denominador (mismo yardstick que Billed)");
    const c = await plant(db, { isAgent: true, lines: [[100, 30, 70]] });
    planted.push(c);
    const rc = await verdictFor(c.billId);
    check("ordenado facturable = 70, no 100", rc.f.qty_ordered === 70, `dio ${rc.f.qty_ordered}`);
    check("deja confirmar con 70/70", rc.v.satisfied === true, rc.v.reason);

    // ── §4 · CONTROL NEGATIVO: vendor normal ──────────────────────────────────
    console.log("\n§4 — control negativo: vendor NO agente, parcialmente recibido");
    const d = await plant(db, { isAgent: false, lines: [[100, 0, 10]] });
    planted.push(d);
    const rd = await verdictFor(d.billId);
    check("no lo marca como agente", rd.f.is_agent_purchase === false);
    check("SIGUE pudiendo confirmar por embarque", rd.v.satisfied === true, rd.v.reason);

    // ── §5 · 0 recibidas debe BLOQUEAR, no leerse como completo ───────────────
    console.log("\n§5 — 0 recibidas: la forma que produce un SQL roto");
    const e = await plant(db, { isAgent: true, lines: [[170, 0, 0]] });
    planted.push(e);
    const re = await verdictFor(e.billId);
    check("mide 170 ordenadas, no 0", re.f.qty_ordered === 170, `dio ${re.f.qty_ordered}`);
    check("BLOQUEA (0 >= 0 sería el falso verde)", re.v.satisfied === false, re.v.reason);

    // ── §6 · po.status NO decide ──────────────────────────────────────────────
    console.log("\n§6 — un PO tageado 'received' A MANO con unidades faltantes");
    const g = await plant(db, {
      isAgent: true, lines: [[100, 0, 90]], poStatus: "received",
    });
    planted.push(g);
    const rg = await verdictFor(g.billId);
    check("el tag dice 'received' y el gate igual BLOQUEA", rg.v.satisfied === false,
      rg.v.reason);
    check("porque mide 90/100", rg.f.qty_received === 90 && rg.f.qty_ordered === 100,
      `${rg.f.qty_received}/${rg.f.qty_ordered}`);

    // ── §7 · Sobre-recepción no bloquea ───────────────────────────────────────
    console.log("\n§7 — llegaron de más");
    const h = await plant(db, { isAgent: true, lines: [[100, 0, 105]] });
    planted.push(h);
    check("deja confirmar", (await verdictFor(h.billId)).v.satisfied === true);
  } finally {
    await cleanup(db, planted);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "PASS" : "FAIL"} — ${results.length - failed.length}/${results.length}\n`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e-agent-bill-confirm-gate crashed:", err);
  process.exit(2);
});
