/**
 * E2E — el BillAdd de un bill regular de agente China. SANDBOX ONLY.
 *
 * ── Qué decide este test ──────────────────────────────────────────────────────
 * Cuánta plata postea el documento en A/P. Un bill de agente China lleva sus
 * item lines al costo LANDED COMPLETO —comisión y flete ya adentro— así que sin
 * las expense lines NEGATIVAS que cancelan a los bills hermanos, QuickBooks
 * acepta feliz un documento que sobreestima la deuda por la suma de esos
 * hermanos. No falla: postea mal y parece normal.
 *
 * Por eso la aserción central no es "se encoló" sino la ARITMÉTICA del payload:
 * item total − clearing = lo que realmente se debe.
 *
 * ── La trampa que también cubre ───────────────────────────────────────────────
 * El Mod elige la forma del documento mirando `vendor_bill.qb_clearing_lines`.
 * Si el Add manda las líneas pero no las PERSISTE, el primer Mod lee un array
 * vacío, trata al bill como local, manda item lines al costo crudo y restatea
 * el documento entero en QuickBooks. Así que se verifica la columna, no sólo el
 * payload.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-china-bill-add-sandbox.ts
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

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface Fx {
  poId: string;
  poLineId: string;
  vendorId: string;
  regularId: string;
  serviceId: string;
  freightId: string;
  locationId: string;
  itemId: string;
  variantId: string;
}

/**
 * Plants a PO with a regular bill and, by default, its two sibling bills.
 *
 * `withSiblings=false` is the real control: a bill whose landed cost absorbed
 * nothing, so it must go to QuickBooks at the RAW cost with no clearing lines.
 * The vendor's `is_china_agent` flag is planted but deliberately decides
 * nothing — it is a POS relationship, invisible to QuickBooks.
 */
async function plant(
  db: Client,
  chinaAgent: boolean,
  withSiblings = true
): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    vendorId: `qbvnd_cn_${n}`,
    regularId: randomUUID(),
    serviceId: randomUUID(),
    freightId: randomUUID(),
    locationId: `sloc_cn_${n}`,
    itemId: `iitem_cn_${n}`,
    variantId: `variant_cn_${n}`,
  };

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        metadata, created_at, updated_at)
     VALUES ($1, $2, $4, $4, $4, $3::jsonb, NOW(), NOW())`,
    [
      f.vendorId,
      `QBV-${n}`,
      JSON.stringify({ is_china_agent: chinaAgent }),
      // `full_name` is UNIQUE among live vendors — one per run, or the second
      // fixture collides with the first.
      `CN Agent E2E ${n}`,
    ]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'CN E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
     VALUES ($1, 'CN variant', $2::jsonb, NOW(), NOW())`,
    [f.variantId, JSON.stringify({ quickbooks_id: `QBITEM-${n}` })]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_cn', 'received', $4, $5, $6)`,
    [f.poId, f.vendorId, f.locationId, `PO-CN-${n}`, 994000 + (seqCounter += 1), `QBPO-CN-${n}`]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents, qb_txn_line_id)
     VALUES ($1, $2, $3, $4, 'SKU-CN', 'CN goods', 10, 10, 1000, 10000, $5)`,
    [f.poLineId, f.poId, f.variantId, f.itemId, `QBPOLINE-${n}`]
  );

  // Los hermanos: comisión $328.60 y flete $854.00.
  for (const [id, type, account, name, cents] of withSiblings
    ? ([
    [f.serviceId, "service", `ACC-COMM-${n}`, "Commission for Purchase:Test", 32860],
    [f.freightId, "freight", `ACC-FRT-${n}`, "Freight and Shipping Costs", 85400],
      ] as Array<[string, string, string, string, number]>)
    : []) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date)
       VALUES ($1, $2, 'confirmed', $3, $4, $5, 'QBV-CN', 'CN Agent E2E', NOW())`,
      [id, f.poId, type, `VB-CN-${type}-${n}`, `REF-${type}-${n}`]
    );
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
          qb_account_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, $4, 'Expense', $4, $4, 1, $5, $5, NOW(), NOW())`,
      [`vbl_${randomUUID().replace(/-/g, "")}`, id, account, name, cents]
    );
  }

  // El regular: 10 unidades a $10 crudo, $128.26 landed (el landed absorbe
  // los $1,182.60 de los hermanos repartidos en las 10 unidades).
  await db.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, status, bill_type, number, reference_id,
        vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date,
        service_vendor_bill_id, freight_vendor_bill_id)
     VALUES ($1, $2, 'confirmed', 'regular', $3, $4, 'QBV-CN', 'CN Agent E2E',
             NOW(), $5, $6)`,
    [
      f.regularId,
      f.poId,
      `VB-CN-REG-${n}`,
      `REF-REG-${n}`,
      withSiblings ? f.serviceId : null,
      withSiblings ? f.freightId : null,
    ]
  );
  // El `landed_unit_cost_cents` queda en 11826 incluso sin hermanos, a
  // propósito: es un estado que producción no produce, pero hace que el
  // control negativo distinga las DOS ramas. Si el Add volviera a mandar
  // landed siempre, esta línea saldría a $118.26 y la aserción lo caza.
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
        sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
        created_at, updated_at)
     VALUES ($1, $2, 'product', $3, $4, 'SKU-CN', 'CN goods', 10, 1000, 11826,
             NOW(), NOW())`,
    [`vbl_${randomUUID().replace(/-/g, "")}`, f.regularId, f.variantId, f.poLineId]
  );

  return f;
}

let seqCounter = 0;

async function cleanup(db: Client, all: Fx[]): Promise<void> {
  for (const f of all) {
    await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [f.poId]);
    await db.query(
      `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`,
      [f.poId]
    );
    for (const id of [f.regularId, f.serviceId, f.freightId]) {
      await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`, [id]);
      await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [id]);
      await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
    await db.query(`DELETE FROM product_variant WHERE id = $1`, [f.variantId]);
    await db.query(`DELETE FROM inventory_item WHERE id = $1`, [f.itemId]);
    await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
    await db.query(`DELETE FROM qb_vendor WHERE id = $1`, [f.vendorId]);
  }
}

async function main(): Promise<void> {
  console.log("=== e2e-china-bill-add (sandbox) ===\n");
  process.env.QB_VENDOR_BILL_MODE = "bill";

  const db = new Client({ connectionString: SB_DB });
  await db.connect();
  const knexLike = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pg = sql.replace(/\?/g, () => `$${++i}`);
      const r = await db.query(pg, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    // The dependency chain refuses to enqueue without one — it takes the PO's
    // tail under lock, and doing that outside a transaction would let two
    // enqueues become siblings instead of a chain.
    transaction: async <T,>(handler: (trx: unknown) => Promise<T>): Promise<T> => {
      await db.query("BEGIN");
      try {
        const out = await handler(knexLike);
        await db.query("COMMIT");
        return out;
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }
    },
  };

  const { enqueueQbVendorBillAdd } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-enqueue"
  );

  const planted: Fx[] = [];
  try {
    console.log("Bill regular de AGENTE CHINA");
    const cn = await plant(db, true);
    planted.push(cn);

    const res = await enqueueQbVendorBillAdd(knexLike as never, cn.regularId);
    check(
      "el Add se encola (antes: 'Phase 2 handles QB dispatch')",
      res.queued === true,
      `reason=${(res as { reason?: string }).reason}`
    );

    const row = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline
        WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [cn.poId]
    );
    const payload = row.rows[0]?.payload as {
      item_lines: Array<{ quantity: number; unit_cost_cents: number }>;
      expense_lines: Array<{ amount_cents: number; account_list_id: string }>;
    };

    check(
      "las item lines van al costo LANDED, no al crudo",
      payload?.item_lines?.[0]?.unit_cost_cents === 11826,
      `unit_cost=${payload?.item_lines?.[0]?.unit_cost_cents} (esperado 11826, crudo sería 1000)`
    );

    const negatives = (payload?.expense_lines ?? []).filter(
      (l) => l.amount_cents < 0
    );
    check(
      "hay una expense line NEGATIVA por cada hermano",
      negatives.length === 2,
      JSON.stringify(payload?.expense_lines)
    );
    check(
      "por sus montos exactos: −$328.60 y −$854.00",
      negatives.some((l) => l.amount_cents === -32860) &&
        negatives.some((l) => l.amount_cents === -85400),
      negatives.map((l) => money(l.amount_cents)).join(", ")
    );

    // LA aserción: la aritmética que QuickBooks va a postear.
    const itemTotal = payload.item_lines.reduce(
      (s, l) => s + Math.round(l.unit_cost_cents * l.quantity),
      0
    );
    const clearing = negatives.reduce((s, l) => s + Math.abs(l.amount_cents), 0);
    check(
      `el A/P neto cierra: ${money(itemTotal)} − ${money(clearing)} = ${money(itemTotal - clearing)}`,
      itemTotal === 118260 && clearing === 118260 && itemTotal - clearing === 0,
      `item=${itemTotal} clearing=${clearing}`
    );

    // La trampa del Mod: la forma tiene que quedar PERSISTIDA.
    const persisted = await db.query<{ n: number | null }>(
      `SELECT jsonb_array_length(qb_clearing_lines) AS n
         FROM vendor_bill WHERE id = $1`,
      [cn.regularId]
    );
    check(
      "las clearing lines quedaron PERSISTIDAS — sin esto el primer Mod restatea el bill",
      Number(persisted.rows[0]?.n) === 2,
      `qb_clearing_lines=${persisted.rows[0]?.n}`
    );

    // ── El flag del vendor NO decide nada ───────────────────────────────────
    // Mismo bill, mismos hermanos, vendor NO marcado como agente China: tiene
    // que salir IGUAL. La forma la decide la estructura — si el costo de los
    // hermanos ya está dentro del landed — no de dónde viene el proveedor.
    // (Decisión del owner 2026-08-04: el flag es una relación del POS, algo que
    // QuickBooks no sabe ni le importa.)
    console.log("\nEl flag del vendor no cambia la forma");
    const notFlagged = await plant(db, false);
    planted.push(notFlagged);
    const resNotFlagged = await enqueueQbVendorBillAdd(
      knexLike as never,
      notFlagged.regularId
    );
    check("se encola igual", resNotFlagged.queued === true);
    const nfRow = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline
        WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [notFlagged.poId]
    );
    const nf = nfRow.rows[0]?.payload as {
      item_lines: Array<{ unit_cost_cents: number }>;
      expense_lines: Array<{ amount_cents: number }>;
    };
    check(
      "y con la MISMA forma: landed + clearing, porque tiene hermanos",
      nf?.item_lines?.[0]?.unit_cost_cents === 11826 &&
        nf.expense_lines.filter((l) => l.amount_cents < 0).length === 2,
      `unit_cost=${nf?.item_lines?.[0]?.unit_cost_cents} negativas=${nf?.expense_lines?.filter((l) => l.amount_cents < 0).length}`
    );

    // ── Control negativo REAL: un bill SIN hermanos ─────────────────────────
    console.log("\nControl negativo — bill SIN hermanos enlazados");
    const local = await plant(db, false, false);
    planted.push(local);
    const resLocal = await enqueueQbVendorBillAdd(knexLike as never, local.regularId);
    check("el bill local también se encola", resLocal.queued === true);

    const localRow = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline
        WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [local.poId]
    );
    const lp = localRow.rows[0]?.payload as {
      item_lines: Array<{ unit_cost_cents: number }>;
      expense_lines: Array<{ amount_cents: number }>;
    };
    check(
      "pero al costo CRUDO — la forma local no cambió",
      lp?.item_lines?.[0]?.unit_cost_cents === 1000,
      `unit_cost=${lp?.item_lines?.[0]?.unit_cost_cents}`
    );
    check(
      "y SIN clearing lines negativas",
      (lp?.expense_lines ?? []).every((l) => l.amount_cents >= 0),
      JSON.stringify(lp?.expense_lines)
    );
    const localPersisted = await db.query<{ c: unknown }>(
      `SELECT qb_clearing_lines AS c FROM vendor_bill WHERE id = $1`,
      [local.regularId]
    );
    check(
      "y su columna qb_clearing_lines quedó intacta",
      localPersisted.rows[0]?.c === null,
      JSON.stringify(localPersisted.rows[0]?.c)
    );
  } finally {
    await cleanup(db, planted);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length} passed, ${failed.length} failed\n`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
