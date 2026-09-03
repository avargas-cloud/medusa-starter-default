/**
 * E2E — service / freight / tariff bills reaching QuickBooks. SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Estos bills son documentos propios de QuickBooks (36 ya viven allá), pero su
 * confirm sólo hacía `UPDATE status='confirmed'` y su edición de monto sólo
 * hacía `UPDATE vendor_bill_line`. Ninguno de los dos encolaba nada. Resultado
 * medido en producción el 2026-08-04: cuatro bills por US$2.325,25 confirmados
 * que QuickBooks nunca vio, y VB-1061 editado a $346,43 mientras QuickBooks
 * seguía diciendo $328,60 — sin fila roja, sin badge, sin nada.
 *
 * ── Qué prueba y qué NO ───────────────────────────────────────────────────────
 * QuickBooks está apagado en sandbox, así que esto NO prueba el round-trip
 * QBXML. Prueba lo que sí se puede: que la operación se ENCOLE, con el step
 * correcto, y —lo que más importa— que el payload de un bill de puras cuentas
 * (sin ítems) se construya, porque ese es el caso que nunca había viajado.
 *
 * La aserción decisiva es sobre `expense_lines`: un payload que se encola con
 * cero líneas llegaría a QuickBooks como un Bill vacío.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-service-bill-qb-sync-sandbox.ts
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

interface Fx {
  poId: string;
  billId: string;
  lineId: string;
  locationId: string;
  accountListId: string;
  billTxnId: string;
}

let seq = 0;

async function plant(
  db: Client,
  billType: "service" | "freight" | "tariff",
  // `withPo: false` plants the shape the owner actually has in production — a
  // sales-commission or outsourced-services bill, which has nothing to purchase.
  // The purchase_order row is still created (it costs nothing and keeps cleanup
  // uniform); what changes is that the BILL does not point at it.
  opts: { synced: boolean; withPo?: boolean }
): Promise<Fx> {
  const n = `${++seq}-${randomUUID().slice(0, 6)}`;
  const f: Fx = {
    poId: randomUUID(),
    billId: randomUUID(),
    lineId: `vbl_${randomUUID().replace(/-/g, "")}`,
    locationId: `sloc_sft_${randomUUID().slice(0, 8)}`,
    accountListId: `ACC-SFT-${n}`,
    billTxnId: `QBTXN-SFT-${n}`,
  };
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'SFT E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, 'vendor_sft', $2, 'user_sft', 'received', $3, $4, $5)`,
    [f.poId, f.locationId, `PO-SFT-${n}`, 993000 + seq, `QBPO-SFT-${n}`]
  );
  await db.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, status, bill_type, number, reference_id,
        vendor_qb_list_id_snapshot, vendor_name_snapshot, qb_txn_id,
        qb_edit_sequence, document_date)
     VALUES ($1, $2, 'draft', $3, $4, $5, 'QBVND-SFT', 'SFT Vendor', $6, $7, NOW())`,
    [
      f.billId,
      opts.withPo === false ? null : f.poId,
      billType,
      `VB-SFT-${n}`,
      `REF-${n}`,
      opts.synced ? f.billTxnId : null,
      opts.synced ? "ES-1" : null,
    ]
  );
  // An ACCOUNT line — no product, no variant. This is the shape that had never
  // travelled to QuickBooks.
  //
  // A SYNCED bill carries `qb_txn_line_id` on every line: a BillMod addresses
  // existing QuickBooks lines by their TxnLineID, so without it the Mod is
  // refused. Production's 36 synced bills all have it — the 2026-07-24 backfill
  // linked them line by line, not just at the header — so the fixture has to as
  // well or it tests a state that does not occur.
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
        qb_account_type, sku, description, qty, unit_cost_cents,
        landed_unit_cost_cents, qb_txn_line_id, created_at, updated_at)
     VALUES ($1, $2, 'qb_account', $3, 'Commission for Purchase:Test',
             'Expense', 'Commission for Purchase:Test', 'commission',
             1, 32860, 32860, $4, NOW(), NOW())`,
    [f.lineId, f.billId, f.accountListId, opts.synced ? `QBLINE-${n}` : null]
  );
  return f;
}

async function cleanup(db: Client, all: Fx[]): Promise<void> {
  for (const f of all) {
    // A bill with no purchase order keys its chain by its OWN id, so both keys
    // have to be swept or the no-PO fixture leaks rows into the next run.
    await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = ANY($1)`, [
      [f.poId, f.billId],
    ]);
    await db.query(
      `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = ANY($1)`,
      [[f.poId, f.billId]]
    );
    await db.query(
      `DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`,
      [f.billId]
    );
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [f.billId]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [f.billId]);
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
    await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
  }
}

async function main(): Promise<void> {
  console.log("=== e2e-service-bill-qb-sync (sandbox) ===\n");
  // The enqueues are gated on this flag, exactly as production is.
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
  const { enqueueVendorBillModSingle } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue"
  );

  const planted: Fx[] = [];
  try {
    // ── ADD: un service bill nuevo llega a QuickBooks ───────────────────────
    console.log("ADD — service bill sin qb_txn_id");
    const svc = await plant(db, "service", { synced: false });
    planted.push(svc);
    const add = await enqueueQbVendorBillAdd(knexLike as never, svc.billId);
    check(
      "el Add se encola (antes: 'bill not found or not regular')",
      add.queued === true,
      `reason=${(add as { reason?: string }).reason}`
    );

    const addRow = await db.query<{ step: string; payload: Record<string, unknown> }>(
      `SELECT step, payload FROM qb_order_pipeline WHERE order_id = $1`,
      [svc.poId]
    );
    check(
      "queda una fila vendor_bill_add",
      addRow.rows.length === 1 && addRow.rows[0].step === "vendor_bill_add",
      addRow.rows.map((r) => r.step).join(", ")
    );

    // LA aserción: un bill de puras cuentas no tiene item lines, y un payload
    // sin ninguna línea llegaría a QuickBooks como un Bill vacío.
    const p = addRow.rows[0]?.payload as {
      item_lines?: unknown[];
      expense_lines?: Array<{ amount_cents: number; account_list_id: string }>;
    };
    check(
      "el payload no lleva item lines — es un bill de cuentas",
      Array.isArray(p?.item_lines) && p.item_lines.length === 0,
      JSON.stringify(p?.item_lines)
    );
    check(
      "PERO lleva su expense line, con monto y cuenta",
      p?.expense_lines?.length === 1 &&
        p.expense_lines[0].amount_cents === 32860 &&
        p.expense_lines[0].account_list_id === svc.accountListId,
      JSON.stringify(p?.expense_lines)
    );

    // ── MOD individual: no arrastra al grupo ────────────────────────────────
    console.log("\nMOD — freight bill ya sincronizado");
    const frt = await plant(db, "freight", { synced: true });
    planted.push(frt);
    const mod = await enqueueVendorBillModSingle(knexLike as never, frt.billId);
    check(
      "el Mod individual se encola",
      mod.queued === true,
      `reason=${(mod as { reason?: string }).reason}`
    );
    check(
      "y toca UN SOLO bill — nunca el grupo",
      mod.queued === true && mod.billIds.length === 1 && mod.billIds[0] === frt.billId,
      JSON.stringify(mod.queued === true ? mod.billIds : null)
    );
    const modRow = await db.query<{ step: string }>(
      `SELECT step FROM qb_order_pipeline WHERE order_id = $1`,
      [frt.poId]
    );
    check(
      "la fila es vendor_bill_mod",
      modRow.rows.length === 1 && modRow.rows[0].step === "vendor_bill_mod",
      modRow.rows.map((r) => r.step).join(", ")
    );

    // ── MOD sin purchase order: comisión de venta / subcontrato ─────────────
    //
    // EL CASO QUE FALTABA. El Add se generalizó el 2026-08-31 (bdfbecaf: "sólo
    // un regular exige PO") pero el Mod nunca se tocó, así que un service bill
    // sin PO ENTRABA a QuickBooks y después no se podía corregir NUNCA: cada
    // edición contestaba 500 "bill has no purchase order". Medido en producción
    // el 2026-09-03: VB-1146, 1147, 1148 y 1149 ya en QB y los cuatro trabados.
    //
    // Que el Add funcione no cubre esto — son dos guards distintos en dos
    // archivos distintos, y ahí estuvo la brecha durante tres días.
    console.log("\nMOD — service bill SIN purchase order (comisión / subcontrato)");
    const noPo = await plant(db, "service", { synced: true, withPo: false });
    planted.push(noPo);
    const modNoPo = await enqueueVendorBillModSingle(knexLike as never, noPo.billId);
    check(
      "el Mod de un bill sin PO se encola (antes: 'bill has no purchase order')",
      modNoPo.queued === true,
      `reason=${(modNoPo as { reason?: string }).reason}`
    );
    check(
      "y toca UN SOLO bill",
      modNoPo.queued === true &&
        modNoPo.billIds.length === 1 &&
        modNoPo.billIds[0] === noPo.billId,
      JSON.stringify(modNoPo.queued === true ? modNoPo.billIds : null)
    );
    // La aserción que prueba que la cadena no quedó huérfana: sin PO, la
    // operación se serializa por el id del PROPIO bill — la misma clave que usó
    // su Add, que es lo que mantiene Add → Mod en orden sobre un mismo documento.
    const noPoChain = await db.query<{ step: string; order_id: string }>(
      `SELECT step, order_id FROM qb_order_pipeline WHERE order_id = $1`,
      [noPo.billId]
    );
    check(
      "la cadena se keyea por el id del bill, no por un PO inexistente",
      noPoChain.rows.length === 1 && noPoChain.rows[0].step === "vendor_bill_mod",
      JSON.stringify(noPoChain.rows)
    );
    const noPoPipe = await db.query<{ intent: string; purchase_order_id: string | null }>(
      `SELECT intent, purchase_order_id FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [noPo.billId]
    );
    check(
      "la fila de pipeline queda intent='mod' con purchase_order_id NULL",
      noPoPipe.rows.length === 1 &&
        noPoPipe.rows[0].intent === "mod" &&
        noPoPipe.rows[0].purchase_order_id === null,
      JSON.stringify(noPoPipe.rows)
    );

    // ── Controles negativos ────────────────────────────────────────────────
    console.log("\nControles negativos");
    const notSynced = await plant(db, "tariff", { synced: false });
    planted.push(notSynced);
    const noMod = await enqueueVendorBillModSingle(
      knexLike as never,
      notSynced.billId
    );
    check(
      "un bill que aún no está en QuickBooks NO recibe Mod",
      noMod.queued === false &&
        (noMod as { reason?: string }).reason === "bill is not linked to QuickBooks",
      (noMod as { reason?: string }).reason
    );

    const adopted = await plant(db, "service", { synced: true });
    planted.push(adopted);
    await db.query(`UPDATE vendor_bill SET qb_source = 'adopted' WHERE id = $1`, [
      adopted.billId,
    ]);
    const noAdopted = await enqueueVendorBillModSingle(
      knexLike as never,
      adopted.billId
    );
    check(
      "un bill ADOPTADO sigue siendo read-only — la valla no se tocó",
      noAdopted.queued === false &&
        (noAdopted as { reason?: string }).reason === "adopted_bill_readonly",
      (noAdopted as { reason?: string }).reason
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
