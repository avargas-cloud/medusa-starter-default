/**
 * E2E — cuándo un bill secundario (service/freight/tariff) llega a QuickBooks.
 * SANDBOX ONLY.
 *
 * ── La regla que prueba ───────────────────────────────────────────────────────
 * Un bill secundario se escribe en QuickBooks cuando ÉL y su regular están los
 * DOS confirmados. El evento que completa el par es el que dispara la escritura:
 *
 *   secundario primero → lo despacha el confirm del REGULAR
 *   regular primero    → lo despacha su PROPIO confirm
 *   sin purchase order → no hay par que esperar, se despacha solo
 *
 * ── Por qué importa la aritmética y no el "se encoló" ─────────────────────────
 * El regular postea una expense line NEGATIVA por hermano para cancelarlo, y
 * `loadClearingSiblings` no filtra por status: confirmar el regular YA resta esa
 * plata de A/P. Si el hermano nunca postea su propio Bill, la resta queda sin
 * contrapartida y QuickBooks queda corto, en un documento que se ve normal.
 * Medido en producción el 2026-08-31: 14 bills, $13,929.48, y creciendo mientras
 * el operador confirmaba regulares esa misma tarde.
 *
 * ── El control negativo es la mitad del test ──────────────────────────────────
 * Un fix que despachara SIEMPRE también pondría en verde los casos felices. Por
 * eso se afirma explícitamente que un hermano cuyo regular sigue en draft
 * produce CERO filas: distinguir "esperando" de "perdido" es la propiedad que se
 * está comprando.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-sibling-bill-dispatch-sandbox.ts
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
  poId: string | null;
  poLineId: string | null;
  vendorId: string;
  regularId: string | null;
  serviceId: string | null;
  freightId: string | null;
  locationId: string | null;
  itemId: string | null;
  variantId: string | null;
}

interface PlantOpts {
  /** Status of the regular bill. `null` = plant no regular at all. */
  regularStatus: string | null;
  /** Status of the two sibling bills. */
  siblingStatus: string;
  /** Give the regular a qb_txn_id (i.e. it already lives in QuickBooks). */
  regularInQb?: boolean;
  /** Give the freight sibling a qb_txn_id. */
  freightInQb?: boolean;
  /** Plant a standalone service bill with NO purchase order. */
  standaloneOnly?: boolean;
}

async function plant(db: Client, o: PlantOpts): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    poId: null,
    poLineId: null,
    vendorId: `qbvnd_sd_${n}`,
    regularId: null,
    serviceId: randomUUID(),
    freightId: null,
    locationId: null,
    itemId: null,
    variantId: null,
  };

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, '{}'::jsonb, NOW(), NOW())`,
    [f.vendorId, `QBV-SD-${n}`, `Sibling Dispatch E2E ${n}`]
  );

  // ── Caso sin purchase order: una comisión de venta suelta ──────────────────
  if (o.standaloneOnly) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date)
       VALUES ($1, NULL, $2, 'service', $3, $4, $5, 'Sibling Dispatch E2E', NOW())`,
      [f.serviceId, o.siblingStatus, `VB-SD-SOLO-${n}`, `REF-SOLO-${n}`, `QBV-SD-${n}`]
    );
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
          qb_account_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, 'Commission for Sale:Referral', 'Expense',
               'COMM', 'Referral commission', 1, 245000, 245000, NOW(), NOW())`,
      [`vbl_${randomUUID().replace(/-/g, "")}`, f.serviceId, `ACC-SALE-${n}`]
    );
    return f;
  }

  f.poId = randomUUID();
  f.poLineId = randomUUID();
  f.freightId = randomUUID();
  f.locationId = `sloc_sd_${n}`;
  f.itemId = `iitem_sd_${n}`;
  f.variantId = `variant_sd_${n}`;

  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'SD E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
     VALUES ($1, 'SD variant', $2::jsonb, NOW(), NOW())`,
    [f.variantId, JSON.stringify({ quickbooks_id: `QBITEM-SD-${n}` })]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_sd', 'received', $4, $5, $6)`,
    [f.poId, f.vendorId, f.locationId, `PO-SD-${n}`, 993000 + (seqCounter += 1), `QBPO-SD-${n}`]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents, qb_txn_line_id)
     VALUES ($1, $2, $3, $4, 'SKU-SD', 'SD goods', 10, 10, 1000, 10000, $5)`,
    [f.poLineId, f.poId, f.variantId, f.itemId, `QBPOLINE-SD-${n}`]
  );

  const siblings: Array<[string, string, string, string, number, boolean]> = [
    [f.serviceId as string, "service", `ACC-COMM-SD-${n}`, "Commission for Purchase:Test", 32860, false],
    [f.freightId, "freight", `ACC-FRT-SD-${n}`, "Freight and Shipping Costs", 85400, Boolean(o.freightInQb)],
  ];
  for (const [id, type, account, name, cents, inQb] of siblings) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
          document_date, qb_txn_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Sibling Dispatch E2E', NOW(), $8)`,
      [
        id, f.poId, o.siblingStatus, type, `VB-SD-${type}-${n}`,
        `REF-SD-${type}-${n}`, `QBV-SD-${n}`, inQb ? `TXN-SD-${type}-${n}` : null,
      ]
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

  if (o.regularStatus) {
    f.regularId = randomUUID();
    await db.query(
      `INSERT INTO vendor_bill
         (id, purchase_order_id, status, bill_type, number, reference_id,
          vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date,
          service_vendor_bill_id, freight_vendor_bill_id, qb_txn_id)
       VALUES ($1, $2, $3, 'regular', $4, $5, $6, 'Sibling Dispatch E2E', NOW(),
               $7, $8, $9)`,
      [
        f.regularId, f.poId, o.regularStatus, `VB-SD-REG-${n}`, `REF-SD-REG-${n}`,
        `QBV-SD-${n}`, f.serviceId, f.freightId,
        o.regularInQb ? `TXN-SD-REG-${n}` : null,
      ]
    );
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
          sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
          landed_total_cents, created_at, updated_at)
       VALUES ($1, $2, 'product', $3, $4, 'SKU-SD', 'SD goods', 10, 1000, 11826,
               118260, NOW(), NOW())`,
      [`vbl_${randomUUID().replace(/-/g, "")}`, f.regularId, f.variantId, f.poLineId]
    );
  }

  return f;
}

async function cleanup(db: Client, all: Fx[]): Promise<void> {
  for (const f of all) {
    if (f.poId) {
      await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [f.poId]);
      await db.query(
        `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`,
        [f.poId]
      );
    }
    for (const id of [f.regularId, f.serviceId, f.freightId]) {
      if (!id) continue;
      await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1 OR reference_id = $1`, [id]);
      await db.query(`DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`, [id]);
      await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`, [id]);
      await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [id]);
      await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [id]);
    }
    if (f.poId) {
      await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
      await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
    }
    if (f.variantId) await db.query(`DELETE FROM product_variant WHERE id = $1`, [f.variantId]);
    if (f.itemId) await db.query(`DELETE FROM inventory_item WHERE id = $1`, [f.itemId]);
    if (f.locationId) await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
    await db.query(`DELETE FROM qb_vendor WHERE id = $1`, [f.vendorId]);
  }
}

async function pipelineRowCount(db: Client, billId: string): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM qb_vendor_bill_pipeline
      WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
    [billId]
  );
  return Number(r.rows[0].n);
}

async function main(): Promise<void> {
  console.log("=== e2e-sibling-bill-dispatch (sandbox) ===\n");
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

  const {
    dispatchConfirmedSiblings,
    fatalSiblingOutcomes,
    decideSecondaryDispatch,
    loadSecondaryDispatchFacts,
  } = await import("../../lib/purchase-orders/qb-vendor-bill-sibling-dispatch");
  const { enqueueQbVendorBillAdd } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-enqueue"
  );

  const planted: Fx[] = [];
  try {
    // ── §1 · Secundario primero, regular después ───────────────────────────────
    console.log("§1 — hermanos confirmados ANTES; el confirm del regular los despacha");
    const a = await plant(db, { regularStatus: "confirmed", siblingStatus: "confirmed" });
    planted.push(a);

    const outA = await dispatchConfirmedSiblings(knexLike as never, a.regularId as string);
    check("despacha los DOS hermanos", outA.filter((o) => o.outcome === "queued").length === 2,
      JSON.stringify(outA.map((o) => [o.bill_type, o.outcome, o.reason])));
    check("ninguno es fatal", fatalSiblingOutcomes(outA).length === 0);
    check("el service tiene fila de pipeline", (await pipelineRowCount(db, a.serviceId as string)) === 1);
    check("el freight tiene fila de pipeline", (await pipelineRowCount(db, a.freightId as string)) === 1);

    // El orden es la propiedad que evita el A/P corto: la cadena es serial por
    // PO, así que el orden de encolado es el orden en que QuickBooks recibe.
    const addRegular = await enqueueQbVendorBillAdd(knexLike as never, a.regularId as string);
    check("el regular encola después", addRegular.queued === true,
      (addRegular as { reason?: string }).reason ?? "");
    const orderRows = await db.query(
      `SELECT reference_id, created_at FROM qb_order_pipeline
        WHERE order_id = $1 AND step = 'vendor_bill_add' ORDER BY created_at`,
      [a.poId]
    );
    const lastIsRegular =
      orderRows.rows.length === 3 &&
      orderRows.rows[2].reference_id === a.regularId;
    check("los hermanos entran a la cadena ANTES que el regular", lastIsRegular,
      orderRows.rows.map((r: { reference_id: string }) => r.reference_id).join(" → "));

    // ── §2 · Regular primero, secundario después ───────────────────────────────
    console.log("\n§2 — el regular YA está confirmado; el confirm del secundario lo despacha");
    const b = await plant(db, {
      regularStatus: "synced", regularInQb: true, siblingStatus: "confirmed",
    });
    planted.push(b);

    const factsB = await loadSecondaryDispatchFacts(knexLike as never, b.freightId as string);
    const decB = decideSecondaryDispatch(factsB!);
    check("la regla da LUZ VERDE", decB.dispatch === true, decB.reason);
    const addB = await enqueueQbVendorBillAdd(knexLike as never, b.freightId as string);
    check("el freight se encola solo", addB.queued === true,
      (addB as { reason?: string }).reason ?? "");
    check("y quedó su fila", (await pipelineRowCount(db, b.freightId as string)) === 1);

    // ── §3 · Sin purchase order ────────────────────────────────────────────────
    console.log("\n§3 — comisión de venta SIN purchase order (camino que nunca corrió en prod)");
    const c = await plant(db, {
      regularStatus: null, siblingStatus: "confirmed", standaloneOnly: true,
    });
    planted.push(c);

    const factsC = await loadSecondaryDispatchFacts(knexLike as never, c.serviceId as string);
    const decC = decideSecondaryDispatch(factsC!);
    check("no espera a nadie", decC.dispatch === true, decC.reason);
    const addC = await enqueueQbVendorBillAdd(knexLike as never, c.serviceId as string);
    check("el guard 'bill has no purchase order' ya NO lo bloquea", addC.queued === true,
      (addC as { reason?: string }).reason ?? "");
    check("quedó su fila", (await pipelineRowCount(db, c.serviceId as string)) === 1);
    const chainC = await db.query(
      `SELECT order_id FROM qb_order_pipeline WHERE reference_id = $1`,
      [c.serviceId]
    );
    check("keyea su cadena por su PROPIO id (no hay PO)",
      chainC.rows.length === 1 && chainC.rows[0].order_id === c.serviceId,
      JSON.stringify(chainC.rows));

    // ── §4 · Controles negativos ──────────────────────────────────────────────
    console.log("\n§4 — controles negativos");
    const d = await plant(db, { regularStatus: "draft", siblingStatus: "confirmed" });
    planted.push(d);
    const factsD = await loadSecondaryDispatchFacts(knexLike as never, d.freightId as string);
    const decD = decideSecondaryDispatch(factsD!);
    check("hermano confirmado + regular en DRAFT ⇒ NO se despacha",
      decD.dispatch === false, decD.reason);
    check("y se reporta como ESPERANDO, no como perdido",
      decD.dispatch === false && decD.deferred === true);
    check("CERO filas de pipeline para él",
      (await pipelineRowCount(db, d.freightId as string)) === 0);

    const e = await plant(db, { regularStatus: "confirmed", siblingStatus: "draft" });
    planted.push(e);
    const outE = await dispatchConfirmedSiblings(knexLike as never, e.regularId as string);
    check("hermanos en DRAFT: el confirm del regular no los manda",
      outE.every((o) => o.outcome === "skipped"),
      JSON.stringify(outE.map((o) => [o.bill_type, o.outcome])));
    check("y no son fatales (se despacharán en su propio confirm)",
      fatalSiblingOutcomes(outE).length === 0);
    check("CERO filas para el freight en draft",
      (await pipelineRowCount(db, e.freightId as string)) === 0);

    const g = await plant(db, {
      regularStatus: "confirmed", siblingStatus: "confirmed", freightInQb: true,
    });
    planted.push(g);
    const outG = await dispatchConfirmedSiblings(knexLike as never, g.regularId as string);
    const freightOutcome = outG.find((o) => o.bill_type === "freight");
    check("un hermano que YA está en QuickBooks no se re-encola",
      freightOutcome?.outcome === "skipped",
      JSON.stringify(freightOutcome));
    check("re-encolarlo mintearía un Bill duplicado — cero filas nuevas",
      (await pipelineRowCount(db, g.freightId as string)) === 0);
    // Control POSITIVO del mismo caso: el hermano que SÍ falta se manda igual.
    check("pero el service que falta sí se despacha",
      outG.find((o) => o.bill_type === "service")?.outcome === "queued");

    // Idempotencia: correrlo dos veces no duplica.
    const outAgain = await dispatchConfirmedSiblings(knexLike as never, a.regularId as string);
    check("re-despachar no duplica filas",
      outAgain.every((o) => o.outcome === "skipped") &&
        (await pipelineRowCount(db, a.serviceId as string)) === 1,
      JSON.stringify(outAgain.map((o) => [o.bill_type, o.outcome, o.reason])));
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
  console.error("e2e-sibling-bill-dispatch crashed:", err);
  process.exit(2);
});
