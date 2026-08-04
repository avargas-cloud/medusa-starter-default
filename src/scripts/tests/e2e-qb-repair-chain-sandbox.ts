/**
 * E2E — la CADENA de la reparación PO↔Bill. SANDBOX ONLY.
 *
 * QuickBooks está apagado en sandbox, así que esto NO prueba el round-trip
 * QBXML. Prueba lo otro, que es donde vive el riesgo real de este diseño: que
 * cada operación nazca colgada de la correcta y que su payload lleve lo que el
 * paso siguiente necesita.
 *
 * Por qué importa: la cadena por PO serializa tomando el TAIL bajo lock, así
 * que el orden CORRECTO sale gratis... siempre que las cosas se encolen en el
 * orden correcto. Si el Save encola el PO Mod ANTES de que arranque la
 * reparación, el PO Mod queda adelante y muere con 3060 igual — que es
 * exactamente el bug que motivó todo esto.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-repair-chain-sandbox.ts
 *
 * Planta sus fixtures y los borra al final, pase o falle.
 */
import { randomUUID } from "crypto";

import { Client } from "pg";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("\n❌ ABORTADO: sólo corre contra la DB del sandbox (5499)\n");
  process.exit(2);
}

const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

interface Fx {
  poId: string;
  poLineId: string;
  billId: string;
  receiptId: string;
  locationId: string;
  itemId: string;
  /** `vendor_bill.qb_txn_id` is UNIQUE among active bills — one per fixture. */
  billTxnId: string;
  poTxnId: string;
}

let plantSeq = 0;

async function plant(db: Client): Promise<Fx> {
  // Random, not a counter: a run that dies mid-fixture leaves rows behind, and
  // a counter would collide with them on the very next attempt.
  const n = `${++plantSeq}-${randomUUID().slice(0, 8)}`;
  const f: Fx = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    billId: randomUUID(),
    receiptId: randomUUID(),
    locationId: `sloc_chain_${randomUUID().slice(0, 8)}`,
    itemId: `iitem_chain_${randomUUID().slice(0, 8)}`,
    billTxnId: `QBTXN-CHAIN-${n}`,
    poTxnId: `QBPO-CHAIN-${n}`,
  };
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'Chain E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO purchase_order
       (id, vendor_id, stock_location_id, created_by_user_id, status, number, seq,
        qb_purchase_order_list_id)
     VALUES ($1, 'vendor_chain', $2, 'user_chain', 'partially_received',
             $3, $4, $5)`,
    [f.poId, f.locationId, `PO-CHAIN-${n}`, 992000 + plantSeq, f.poTxnId]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents)
     VALUES ($1, $2, 'variant_chain', $3, 'SKU-CHAIN', 'chain line',
             50, 20, 500, 25000)`,
    [f.poLineId, f.poId, f.itemId]
  );
  // A Bill that LIVES IN QUICKBOOKS — the whole premise of the repair.
  await db.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, status, bill_type, number, qb_txn_id)
     VALUES ($1, $2, 'draft', 'regular', $3, $4)`,
    [f.billId, f.poId, `VB-CHAIN-${n}`, f.billTxnId]
  );
  await db.query(
    `INSERT INTO qb_vendor_bill_pipeline
       (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id)
     VALUES ($1, $2, $3, 'synced', 'add', $4)`,
    [randomUUID(), f.billId, f.poId, f.billTxnId]
  );
  return f;
}

async function cleanup(db: Client, f: Fx | null): Promise<void> {
  if (!f) return;
  await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [f.poId]);
  await db.query(
    `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`,
    [f.poId]
  );
  await db.query(
    `DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`,
    [f.billId]
  );
  await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [f.billId]);
  await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
  await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
  await db.query(`DELETE FROM inventory_item WHERE id = $1`, [f.itemId]);
  await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
}

async function main(): Promise<void> {
  console.log("=== e2e-qb-repair-chain (sandbox) ===\n");
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  // The chain helper wants a knex-shaped connection with `.transaction`.
  const knexLike = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pg = sql.replace(/\?/g, () => `$${++i}`);
      const r = await db.query(pg, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
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

  const { enqueuePurchaseQbOperation, purchaseOperationKey } = await import(
    "../../lib/purchase-orders/qb-purchase-dependency-chain"
  );

  let f: Fx | null = null;
  try {
    f = await plant(db);
    console.log("Orden de encolado: TxnDel del bill → PO Mod → Item Receipt\n");

    const del = await enqueuePurchaseQbOperation(knexLike as never, {
      purchaseOrderId: f.poId,
      referenceId: f.billId,
      referenceType: "vendor_bill",
      step: "vendor_bill_rebuild_delete",
      qbTxnId: f.billTxnId,
      payload: { txn_id: f.billTxnId, vendor_bill_id: f.billId },
      operationKey: purchaseOperationKey("vendor_bill_rebuild_delete", f.billId, {}),
    });
    check(
      "el TxnDel es la CABEZA de la cadena y se despacha ya",
      del.status === "pending" && del.dependsOn === null,
      `status=${del.status} depends_on=${del.dependsOn}`
    );

    const poMod = await enqueuePurchaseQbOperation(knexLike as never, {
      purchaseOrderId: f.poId,
      referenceId: f.poId,
      referenceType: "purchase_order",
      step: "purchase_order_mod",
      qbTxnId: f.poTxnId,
      payload: { txn_id: f.poTxnId, po_id: f.poId },
      operationKey: purchaseOperationKey("purchase_order_mod", f.poId, {}),
    });
    check(
      "el PO Mod ESPERA, colgado del TxnDel",
      poMod.status === "waiting" && poMod.dependsOn === del.id,
      `status=${poMod.status} depends_on=${poMod.dependsOn} (esperado ${del.id})`
    );

    const receipt = await enqueuePurchaseQbOperation(knexLike as never, {
      purchaseOrderId: f.poId,
      referenceId: f.receiptId,
      referenceType: "item_receipt",
      step: "item_receipt_add",
      payload: { receipt_id: f.receiptId, po_id: f.poId },
      operationKey: purchaseOperationKey("item_receipt_add", f.receiptId, {}),
    });
    check(
      "el Item Receipt ESPERA, colgado del PO Mod — la espera es transitiva",
      receipt.status === "waiting" && receipt.dependsOn === poMod.id,
      `status=${receipt.status} depends_on=${receipt.dependsOn} (esperado ${poMod.id})`
    );

    // El orden REAL en la tabla, no el que devolvieron los helpers.
    const chain = await db.query<{
      step: string;
      status: string;
      depends_on: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT step, status, depends_on, payload
         FROM qb_order_pipeline
        WHERE order_id = $1
        ORDER BY created_at, seq`,
      [f.poId]
    );
    check(
      "la tabla guarda las 3 operaciones en el orden que exige QuickBooks",
      chain.rows.map((r) => r.step).join(" → ") ===
        "vendor_bill_rebuild_delete → purchase_order_mod → item_receipt_add",
      chain.rows.map((r) => r.step).join(" → ")
    );
    check(
      "exactamente UNA está despachable; las otras dos esperan",
      chain.rows.filter((r) => r.status === "pending").length === 1 &&
        chain.rows.filter((r) => r.status === "waiting").length === 2,
      chain.rows.map((r) => `${r.step}:${r.status}`).join(", ")
    );

    // Los payloads: cada paso tiene que llevar la identidad de SU documento.
    const byStep = new Map(chain.rows.map((r) => [r.step, r]));
    check(
      "el payload del TxnDel lleva el TxnID del bill en QuickBooks",
      byStep.get("vendor_bill_rebuild_delete")?.payload?.txn_id === f.billTxnId,
      JSON.stringify(byStep.get("vendor_bill_rebuild_delete")?.payload)
    );
    check(
      "el payload del PO Mod lleva el ListID del PO, no el del bill",
      byStep.get("purchase_order_mod")?.payload?.txn_id === f.poTxnId,
      JSON.stringify(byStep.get("purchase_order_mod")?.payload)
    );
    check(
      "cada fila guarda su reference_type real (bill / purchase_order / item_receipt)",
      (
        await db.query(
          `SELECT COUNT(DISTINCT reference_type)::int AS n
             FROM qb_order_pipeline WHERE order_id = $1`,
          [f.poId]
        )
      ).rows[0].n === 3
    );

    // Y el punto que motivó todo: encolar el PO Mod PRIMERO lo deja adelante.
    console.log(
      "\nControl negativo — si el Save encola el PO Mod antes de la reparación:"
    );
    const f2 = await plant(db);
    const early = await enqueuePurchaseQbOperation(knexLike as never, {
      purchaseOrderId: f2.poId,
      referenceId: f2.poId,
      referenceType: "purchase_order",
      step: "purchase_order_mod",
      qbTxnId: f2.poTxnId,
      payload: { txn_id: f2.poTxnId },
      operationKey: purchaseOperationKey("purchase_order_mod", f2.poId, {}),
    });
    const lateDel = await enqueuePurchaseQbOperation(knexLike as never, {
      purchaseOrderId: f2.poId,
      referenceId: f2.billId,
      referenceType: "vendor_bill",
      step: "vendor_bill_rebuild_delete",
      qbTxnId: f2.billTxnId,
      payload: { txn_id: f2.billTxnId },
      operationKey: purchaseOperationKey("vendor_bill_rebuild_delete", f2.billId, {}),
    });
    check(
      "el PO Mod queda ADELANTE y se despacharía primero — por eso el Save no debe encolarlo",
      early.status === "pending" &&
        early.dependsOn === null &&
        lateDel.status === "waiting" &&
        lateDel.dependsOn === early.id,
      `po_mod=${early.status} del=${lateDel.status}`
    );
    await cleanup(db, f2);
  } finally {
    await cleanup(db, f);
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
