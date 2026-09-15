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
  /**
   * Give the regular the CHINA-AGENT shape: persisted negative clearing lines
   * cancelling both siblings. That is the shape whose group Mod deadlocked.
   *
   * The commission is planted STALE on purpose (−$333.00 against a sibling of
   * −$328.60), reproducing VB-1128: QuickBooks held one figure and the sibling
   * had since been corrected to another. A fixture whose column already agreed
   * with its siblings could not tell a Mod that refreshes the column from one
   * that copies it unchanged.
   */
  regularClearing?: boolean;
  /** Flag the vendor as a China purchasing agent (`metadata.is_china_agent`). */
  agentVendor?: boolean;
  /**
   * Plant the siblings the way the POS CREATES them: no purchase order, and no
   * pointer from the regular. That is how every Veetech commission/freight
   * bill is born — the PO and the pointer arrive together when the regular's
   * PATCH links them (2026-09-15).
   */
  siblingsUnlinked?: boolean;
  /** Give the service sibling a qb_txn_id. */
  serviceInQb?: boolean;
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
     VALUES ($1, $2, $3, $3, $3, $4::jsonb, NOW(), NOW())`,
    [
      f.vendorId, `QBV-SD-${n}`, `Sibling Dispatch E2E ${n}`,
      JSON.stringify(o.agentVendor ? { is_china_agent: true } : {}),
    ]
  );

  // ── Caso sin purchase order: una comisión de venta suelta ──────────────────
  if (o.standaloneOnly) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date, vendor_id)
       VALUES ($1, NULL, $2, 'service', $3, $4, $5, 'Sibling Dispatch E2E', NOW(), $6)`,
      [f.serviceId, o.siblingStatus, `VB-SD-SOLO-${n}`, `REF-SOLO-${n}`, `QBV-SD-${n}`, f.vendorId]
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
    [f.serviceId as string, "service", `ACC-COMM-SD-${n}`, "Commission for Purchase:Test", 32860, Boolean(o.serviceInQb)],
    [f.freightId, "freight", `ACC-FRT-SD-${n}`, "Freight and Shipping Costs", 85400, Boolean(o.freightInQb)],
  ];
  const siblingPoId = o.siblingsUnlinked ? null : f.poId;
  for (const [id, type, account, name, cents, inQb] of siblings) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
          document_date, qb_txn_id, vendor_id, qb_edit_sequence, qb_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Sibling Dispatch E2E', NOW(), $8, $9, $10, $11)`,
      [
        id, siblingPoId, o.siblingStatus, type, `VB-SD-${type}-${n}`,
        `REF-SD-${type}-${n}`, `QBV-SD-${n}`, inQb ? `TXN-SD-${type}-${n}` : null,
        // `vendor_id` es lo que el despacho lee para la bandera de agente
        // (0 bills sin vendor_id en prod, 2026-09-15); un bill en QuickBooks
        // tiene TxnID *y* EditSequence, si no `buildPayload` lo rechaza.
        f.vendorId, inQb ? `SEQ-SD-${type}-${n}` : null, inQb ? "owned" : null,
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
          service_vendor_bill_id, freight_vendor_bill_id, qb_txn_id, vendor_id)
       VALUES ($1, $2, $3, 'regular', $4, $5, $6, 'Sibling Dispatch E2E', NOW(),
               $7, $8, $9, $10)`,
      [
        f.regularId, f.poId, o.regularStatus, `VB-SD-REG-${n}`, `REF-SD-REG-${n}`,
        `QBV-SD-${n}`,
        o.siblingsUnlinked ? null : f.serviceId,
        o.siblingsUnlinked ? null : f.freightId,
        o.regularInQb ? `TXN-SD-REG-${n}` : null,
        f.vendorId,
      ]
    );
    // Un regular que vive en QuickBooks tiene TxnID *y* EditSequence: sin la
    // segunda, `buildPayload` lo rechaza a ÉL y el test mediría otra cosa.
    if (o.regularInQb) {
      await db.query(
        `UPDATE vendor_bill SET qb_edit_sequence = $2, qb_source = 'owned'
          WHERE id = $1`,
        [f.regularId, `SEQ-SD-REG-${n}`]
      );
    }
    if (o.regularClearing) {
      await db.query(
        `UPDATE vendor_bill SET qb_clearing_lines = $2::jsonb WHERE id = $1`,
        [
          f.regularId,
          JSON.stringify([
            { kind: "commission", vendor_bill_id: f.serviceId, account_list_id: `ACC-COMM-SD-${n}`,
              account_full_name: "Commission for Purchase:Test", amount_cents: -33300,
              qb_txn_line_id: `QBCLR-COMM-SD-${n}` },
            { kind: "freight", vendor_bill_id: f.freightId, account_list_id: `ACC-FRT-SD-${n}`,
              account_full_name: "Freight and Shipping Costs", amount_cents: -85400,
              qb_txn_line_id: `QBCLR-FRT-SD-${n}` },
          ]),
        ]
      );
    }
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
          sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
          landed_total_cents, qb_txn_line_id, created_at, updated_at)
       VALUES ($1, $2, 'product', $3, $4, 'SKU-SD', 'SD goods', 10, 1000, 11826,
               118260, $5, NOW(), NOW())`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`, f.regularId, f.variantId, f.poLineId,
        o.regularInQb ? `QBLINE-SD-REG-${n}` : null,
      ]
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
  const { enqueueChinaAgencyVendorBillModGroup } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue"
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

    // ── §5 · La forma de VB-1128: el regular YA vive en QB y vuelve a draft ───
    //
    // El caso de producción del 2026-09-03, reproducido entero. El confirm del
    // regular corre DOS cosas en la MISMA transacción, en este orden:
    //
    //   1. dispatchConfirmedSiblings  → BillAdd para los hermanos que faltan
    //   2. enqueueChinaAgencyVendorBillModGroup → BillMod porque ya tiene TxnID
    //
    // El paso 2 armaba un Mod para CADA hermano, y un hermano cuyo Add recién
    // se encoló sigue sin `qb_txn_id` una sentencia después: `buildPayload`
    // tiraba, la transacción se caía, y con ella los Adds del paso 1. VB-1128
    // devolvía 422 `VB-1129: missing QB TxnID/EditSequence` para siempre.
    console.log("\n§5 — regular EN QuickBooks + hermanos confirmados que no llegaron");
    const h = await plant(db, {
      regularStatus: "draft",
      regularInQb: true,
      regularClearing: true,
      siblingStatus: "confirmed",
    });
    planted.push(h);

    // La luz verde nueva: el status dice `draft`, pero el documento existe y su
    // clearing line ya está restando a este hermano de A/P.
    const factsH = await loadSecondaryDispatchFacts(knexLike as never, h.serviceId as string);
    const decH = decideSecondaryDispatch(factsH!);
    check("un regular en DRAFT que ya vive en QB ES luz verde", decH.dispatch === true, decH.reason);
    check("y la razón lo dice, no repite 'ya confirmado'",
      decH.dispatch === true && decH.reason.includes("QuickBooks"), decH.reason);

    const outH = await dispatchConfirmedSiblings(knexLike as never, h.regularId as string);
    check("el confirm del regular encola los DOS Adds",
      outH.filter((o) => o.outcome === "queued").length === 2,
      JSON.stringify(outH.map((o) => [o.bill_type, o.outcome, o.reason])));

    // EL CHECK QUE ANTES ROMPÍA. Sin el filtro esto tira y el `catch` de abajo
    // lo reporta — nunca se lo deja pasar como un `queued:false` cualquiera.
    let modH: Awaited<ReturnType<typeof enqueueChinaAgencyVendorBillModGroup>> | null = null;
    let modErr = "";
    try {
      modH = await enqueueChinaAgencyVendorBillModGroup(knexLike as never, h.regularId as string);
    } catch (err) {
      modErr = err instanceof Error ? err.message : String(err);
    }
    check("el group Mod NO tira por un hermano sin TxnID", modErr === "", modErr);
    check("y queda encolado", modH?.queued === true,
      JSON.stringify(modH));
    check("modifica SÓLO al regular",
      modH?.queued === true && modH.billIds.length === 1 && modH.billIds[0] === h.regularId,
      JSON.stringify(modH && modH.queued ? modH.billIds : null));
    check("y REPORTA los dos hermanos salteados",
      modH?.queued === true &&
        (modH.skippedBillIds ?? []).slice().sort().join(",") ===
          [h.serviceId, h.freightId].sort().join(","),
      JSON.stringify(modH && modH.queued ? modH.skippedBillIds : null));

    // Control POSITIVO: que no tire no alcanza — el regular tiene que quedar
    // con un Mod REAL, y los hermanos con su Add, no con un Mod.
    const intents = await db.query(
      `SELECT vendor_bill_id, intent FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ANY($1) AND deleted_at IS NULL`,
      [[h.regularId, h.serviceId, h.freightId]]
    );
    const intentOf = (id: string | null) =>
      intents.rows.find((r: { vendor_bill_id: string }) => r.vendor_bill_id === id)?.intent;
    check("el regular queda con intent='mod'", intentOf(h.regularId) === "mod", String(intentOf(h.regularId)));
    check("el service queda con intent='add'", intentOf(h.serviceId) === "add", String(intentOf(h.serviceId)));
    check("el freight queda con intent='add'", intentOf(h.freightId) === "add", String(intentOf(h.freightId)));

    // El orden importa igual que en §1: los Adds de los hermanos tienen que
    // entrar a la cadena ANTES del Mod del regular, o A/P queda corto en el
    // intervalo (la clearing line resta hermanos que todavía no existen).
    const chainH = await db.query(
      `SELECT reference_id, step FROM qb_order_pipeline
        WHERE order_id = $1 ORDER BY created_at, id`,
      [h.poId]
    );
    const stepsH = chainH.rows as Array<{ reference_id: string; step: string }>;
    check("los Adds de los hermanos preceden al Mod del regular",
      stepsH.length === 3 &&
        stepsH.slice(0, 2).every((r) => r.step === "vendor_bill_add") &&
        stepsH[2].step === "vendor_bill_mod" &&
        stepsH[2].reference_id === h.regularId,
      stepsH.map((r) => `${r.step}:${r.reference_id === h.regularId ? "REG" : "sib"}`).join(" → "));

    // ── §6 · El Mod deja constancia de lo que manda ───────────────────────────
    //
    // `vendor_bill.qb_clearing_lines` es lo que la pantalla y
    // `verify-clearing-drift` tratan como "lo que tiene QuickBooks". Sólo el
    // ADD la escribía: el Mod mandaba montos frescos y dejaba la columna
    // citando los viejos, así que corregir un hermano y reconfirmar el grupo
    // dejaba el bill marcado "needs review" PARA SIEMPRE contra un documento
    // que, para entonces, estaba bien. Medido en VB-1128: QuickBooks −$380,68,
    // columna −$388,87, cartel trabado.
    //
    // El payload lleva el snapshot; el confirm lo aplica (poll-submitted-rows).
    console.log("\n§6 — el Mod lleva en su payload lo que QuickBooks va a tener");
    const payloadRow = await db.query(
      `SELECT payload FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
      [h.regularId]
    );
    const modPayload = payloadRow.rows[0]?.payload as Record<string, unknown> | undefined;
    const sentClearing = (modPayload?.clearing_lines ?? []) as Array<{
      kind: string; amount_cents: number; account_list_id: string; qb_txn_line_id?: string;
    }>;
    check("el payload del Mod lleva las clearing lines", sentClearing.length === 2,
      JSON.stringify(sentClearing));

    const commissionSent = sentClearing.find((l) => l.kind === "commission");
    const freightSent = sentClearing.find((l) => l.kind === "freight");
    // EL CHECK QUE IMPORTA: el monto es el VIVO del hermano (−328,60), no el
    // desactualizado que la columna traía (−333,00).
    check("la comisión va por el monto VIVO del hermano, no por el guardado",
      commissionSent?.amount_cents === -32860, String(commissionSent?.amount_cents));
    check("el freight, que no cambió, va igual", freightSent?.amount_cents === -85400,
      String(freightSent?.amount_cents));
    // Control NEGATIVO de identidad: refrescar el monto no puede perder la
    // línea de QuickBooks ni la cuenta — sin TxnLineID el Mod la agregaría de
    // nuevo en vez de modificarla, duplicando el cargo en el Bill.
    check("conserva el TxnLineID de la línea en QuickBooks",
      Boolean(commissionSent?.qb_txn_line_id) && Boolean(freightSent?.qb_txn_line_id),
      JSON.stringify([commissionSent?.qb_txn_line_id, freightSent?.qb_txn_line_id]));
    check("y su cuenta", Boolean(commissionSent?.account_list_id) && Boolean(freightSent?.account_list_id));

    // La columna TODAVÍA no cambió: se escribe en el confirm, no al encolar.
    // Un Mod que nunca aterriza tiene que dejar el cartel prendido, porque el
    // documento de QuickBooks sigue estando viejo de verdad.
    const stillStale = await db.query(
      `SELECT qb_clearing_lines AS c FROM vendor_bill WHERE id = $1`,
      [h.regularId]
    );
    const staleCommission = (stillStale.rows[0]?.c as Array<{ kind: string; amount_cents: number }>)
      ?.find((l) => l.kind === "commission");
    check("la columna NO se toca al encolar — falla cerrado si el Mod no aterriza",
      staleCommission?.amount_cents === -33300, String(staleCommission?.amount_cents));

    // ── §7 · Las secciones del digest EMITEN de verdad ────────────────────────
    //
    // Los dos invariantes existían desde agosto y vivían sólo dentro de su
    // `verify-*`. Medido el 2026-09-03: de 167 verificadores del backend, UNO lo
    // corre algo automáticamente. O sea que el chequeo que habría avisado de
    // VB-1129/VB-1130 estaba escrito, era correcto, y no tenía quién lo mirara.
    //
    // Una sección de digest que nunca produjo una fila es un verificador sin
    // probar: acá se plantan los datos que la deben disparar y se comprueba que
    // el mail los nombra — y, lo que importa más, que NO nombra a los sanos.
    console.log("\n§7 — el digest diario emite estas dos secciones");
    const { collectLostSiblingBillSection, collectClearingDriftSection } =
      await import("../../jobs/_lib/_qb-vendor-bill-invariant-sections");
    const quietLogger = { warn: () => undefined };

    // Un grupo con la forma de VB-1128 y SIN despachar: par completo, regular
    // vivo en QuickBooks, hermanos confirmados sin documento. Esto es plata
    // faltante del A/P y tiene que llegar por mail.
    const i = await plant(db, {
      regularStatus: "draft", regularInQb: true, regularClearing: true,
      siblingStatus: "confirmed",
    });
    planted.push(i);

    const lostSection = await collectLostSiblingBillSection(knexLike as never, quietLogger);
    const lostIds = (lostSection?.rows ?? []).map((r) => r.id);
    check("la sección 12 emite una fila por cada hermano perdido",
      lostIds.includes(i.serviceId as string) && lostIds.includes(i.freightId as string),
      JSON.stringify(lostSection?.rows.map((r) => [r.medusa_ref, r.error])));
    check("y su título lleva el monto que falta del A/P",
      Boolean(lostSection?.title.includes("$")), String(lostSection?.title));

    // CONTROL NEGATIVO, que es la mitad del test: el grupo `d` tiene hermanos
    // confirmados esperando a un regular en draft que NUNCA fue a QuickBooks.
    // Ésos están SANOS. Una sección que también los nombrara sería ruido, y un
    // mail ruidoso se aprende a ignorar — que es como este invariante se perdió.
    check("y NO nombra a los que esperan legítimamente a su regular",
      !lostIds.includes(d.freightId as string) && !lostIds.includes(d.serviceId as string),
      JSON.stringify(lostIds));

    // La sección 13 sobre el mismo grupo: su columna de clearing quedó
    // desactualizada (−333,00 contra un hermano de −328,60).
    const driftSection = await collectClearingDriftSection(knexLike as never, quietLogger);
    const driftIds = (driftSection?.rows ?? []).map((r) => r.id);
    check("la sección 13 nombra al regular con clearing desactualizada",
      driftIds.includes(i.regularId as string),
      JSON.stringify(driftSection?.rows.map((r) => [r.medusa_ref, r.error])));
    check("y explica la diferencia por cuenta, no un total mudo",
      Boolean(driftSection?.rows.find((r) => r.id === i.regularId)?.error.includes("commission")),
      String(driftSection?.rows.find((r) => r.id === i.regularId)?.error));
    // El regular de `d` NO está en QuickBooks: su columna todavía no existe y no
    // hay A/P descuadrado que reportar.
    check("y NO nombra a un regular que todavía no llegó a QuickBooks",
      !driftIds.includes(d.regularId as string), JSON.stringify(driftIds));

    // ── §8 · Un hermano de AGENTE nunca es standalone (2026-09-15) ────────────
    //
    // La regla del 08-31 leía "sin purchase order" como "no hay par que
    // esperar". Pero un hermano de Veetech NACE sin PO: el modal no lo manda, y
    // el PO le llega junto con el puntero cuando el regular lo vincula. Así que
    // un hermano confirmado ANTES de vincularlo salía solo a QuickBooks a los 17
    // segundos de creado, con el regular todavía en draft (VB-1235/1236/1239/
    // 1240). La bandera del vendor es lo que separa las dos formas.
    console.log("\n§8 — hermano de agente de China, confirmado ANTES de vincularlo");
    const j = await plant(db, {
      agentVendor: true, siblingsUnlinked: true,
      regularStatus: "draft", siblingStatus: "confirmed",
    });
    planted.push(j);
    const factsJ = await loadSecondaryDispatchFacts(knexLike as never, j.serviceId as string);
    check("los hechos lo ven como agente, sin PO y sin regular",
      factsJ?.vendor_is_china_agent === true && factsJ.has_purchase_order === false &&
        factsJ.parent_regular === null,
      JSON.stringify(factsJ));
    const decJ = decideSecondaryDispatch(factsJ!);
    check("⇒ NO se despacha: espera al regular que lo vincule",
      decJ.dispatch === false && decJ.deferred === true, decJ.reason);
    check("CERO filas de pipeline para él",
      (await pipelineRowCount(db, j.serviceId as string)) === 0);

    // El operador vincula desde el regular (lo que hace el PATCH): puntero en
    // el regular + PO en los hermanos. Después confirma el regular.
    await db.query(
      `UPDATE vendor_bill SET service_vendor_bill_id = $2, freight_vendor_bill_id = $3,
              status = 'confirmed' WHERE id = $1`,
      [j.regularId, j.serviceId, j.freightId]
    );
    await db.query(
      `UPDATE vendor_bill SET purchase_order_id = $2 WHERE id = ANY($1)`,
      [[j.serviceId, j.freightId], j.poId]
    );
    const outJ = await dispatchConfirmedSiblings(knexLike as never, j.regularId as string);
    check("vinculado y regular confirmado ⇒ el confirm del regular despacha los DOS",
      outJ.filter((o) => o.outcome === "queued").length === 2,
      JSON.stringify(outJ.map((o) => [o.bill_type, o.outcome, o.reason])));
    const addJ = await enqueueQbVendorBillAdd(knexLike as never, j.regularId as string);
    check("y el regular encola después", addJ.queued === true, (addJ as { reason?: string }).reason ?? "");
    const payloadJ = (await db.query(
      `SELECT payload FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1 AND intent = 'add'`,
      [j.regularId]
    )).rows[0]?.payload as { expense_lines?: Array<{ amount_cents: number }> } | undefined;
    const negJ = (payloadJ?.expense_lines ?? []).map((l) => l.amount_cents).sort((a, b) => a - b);
    check("con las DOS clearing lines por el total de cada hermano",
      negJ.join(",") === [-85400, -32860].join(","), JSON.stringify(negJ));
    const chainJ = await db.query(
      `SELECT reference_id FROM qb_order_pipeline WHERE order_id = $1 AND step = 'vendor_bill_add'
        ORDER BY created_at, id`,
      [j.poId]
    );
    check("y los hermanos entran a la cadena ANTES que el regular",
      chainJ.rows.length === 3 && chainJ.rows[2].reference_id === j.regularId,
      chainJ.rows.map((r: { reference_id: string }) => (r.reference_id === j.regularId ? "REG" : "sib")).join(" → "));

    // Con PO pero sin regular que lo apunte: mismo veredicto (la fase intermedia
    // de un hermano creado desde el PO en vez de suelto).
    const k = await plant(db, { agentVendor: true, regularStatus: null, siblingStatus: "confirmed" });
    planted.push(k);
    const decK = decideSecondaryDispatch((await loadSecondaryDispatchFacts(knexLike as never, k.freightId as string))!);
    check("agente + PO + ningún regular lo apunta ⇒ espera", decK.dispatch === false && decK.deferred === true, decK.reason);

    // La forma de VB-1234/1237, que el dueño decidió dejar así: el hermano YA
    // está en QuickBooks (fue solo por la regla vieja), el regular llega después.
    console.log("\n§8b — hermanos de agente que YA están en QuickBooks; el regular confirma después");
    const m = await plant(db, {
      agentVendor: true, regularStatus: "confirmed", siblingStatus: "synced",
      serviceInQb: true, freightInQb: true,
    });
    planted.push(m);
    const outM = await dispatchConfirmedSiblings(knexLike as never, m.regularId as string);
    check("los dos se SALTAN — ninguno se re-encola",
      outM.length === 2 && outM.every((o) => o.outcome === "skipped" && o.reason === "already in QuickBooks"),
      JSON.stringify(outM.map((o) => [o.bill_type, o.outcome, o.reason])));
    check("y no son fatales: el confirm del regular sigue",
      fatalSiblingOutcomes(outM).length === 0);
    check("CERO filas nuevas para los hermanos",
      (await pipelineRowCount(db, m.serviceId as string)) === 0 &&
        (await pipelineRowCount(db, m.freightId as string)) === 0);
    const addM = await enqueueQbVendorBillAdd(knexLike as never, m.regularId as string);
    check("el regular se encola igual", addM.queued === true, (addM as { reason?: string }).reason ?? "");
    const payloadM = (await db.query(
      `SELECT payload FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1 AND intent = 'add'`,
      [m.regularId]
    )).rows[0]?.payload as { expense_lines?: Array<{ amount_cents: number }> } | undefined;
    const negM = (payloadM?.expense_lines ?? []).map((l) => l.amount_cents).sort((a, b) => a - b);
    check("y SÍ lleva las clearing lines que cancelan los cargos ya posteados",
      negM.join(",") === [-85400, -32860].join(","), JSON.stringify(negM));

    // La forma de VB-1142: el regular YA está en QuickBooks a costo crudo, sin
    // punteros ni clearing; sus dos cargos también, sueltos. El arreglo es
    // vincular y reconfirmar: un Mod del regular con las dos negativas, y los
    // hermanos se saltan (tienen TxnID).
    console.log("\n§8c — la forma de VB-1142: regular en QB sin clearing + cargos sueltos en QB → vincular + Mod");
    const q = await plant(db, {
      agentVendor: true, siblingsUnlinked: true,
      regularStatus: "draft", regularInQb: true, siblingStatus: "synced",
      serviceInQb: true, freightInQb: true,
    });
    planted.push(q);
    await db.query(
      `UPDATE vendor_bill SET service_vendor_bill_id = $2, freight_vendor_bill_id = $3 WHERE id = $1`,
      [q.regularId, q.serviceId, q.freightId]
    );
    await db.query(`UPDATE vendor_bill SET purchase_order_id = $2 WHERE id = ANY($1)`,
      [[q.serviceId, q.freightId], q.poId]);
    const outQ = await dispatchConfirmedSiblings(knexLike as never, q.regularId as string);
    check("los cargos ya en QB se saltan", outQ.every((o) => o.outcome === "skipped"),
      JSON.stringify(outQ.map((o) => [o.bill_type, o.outcome])));
    const modQ = await enqueueChinaAgencyVendorBillModGroup(knexLike as never, q.regularId as string);
    check("el Mod del regular se encola", modQ.queued === true, JSON.stringify(modQ));
    const modPayloadQ = (await db.query(
      `SELECT payload FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
      [q.regularId]
    )).rows[0]?.payload as { clearing_lines?: Array<{ kind: string; amount_cents: number }> } | undefined;
    const clrQ = (modPayloadQ?.clearing_lines ?? []).map((l) => `${l.kind}:${l.amount_cents}`).sort();
    // EL LÍMITE, medido acá el 2026-09-15: el Mod CONSERVA la forma que mandó el
    // Add — refresca clearing lines que ya existen (por TxnLineID), nunca agrega
    // una. Un regular que llegó a QuickBooks crudo (VB-1142) y después vincula
    // sus cargos NO se arregla con Reconfirm: es un cambio de forma, o sea un
    // REBUILD (TxnDel + Add nuevo con landed + negativas). Se afirma el
    // contrato real para que nadie crea que "link + reconfirm" balancea.
    check("el Mod NO agrega clearing lines — cambiar de forma es rebuild, no Mod",
      clrQ.length === 0, JSON.stringify(clrQ));
    // El grupo modifica a todo miembro con TxnID (regla del 09-03), así que los
    // cargos reciben un Mod de contenido idéntico — nunca un Add, que es lo que
    // duplicaría el documento. En prod, VB-1142 = 3 Mods.
    const intentsQ = await db.query(
      `SELECT vendor_bill_id, intent FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = ANY($1) AND deleted_at IS NULL`,
      [[q.serviceId, q.freightId]]
    );
    check("los hermanos reciben un Mod de grupo, NUNCA un Add",
      intentsQ.rows.length === 2 && intentsQ.rows.every((r: { intent: string }) => r.intent === "mod"),
      JSON.stringify(intentsQ.rows));

    // ── §8d · El carril que SÍ arregla la forma de VB-1142: el rebuild ───────
    //
    // El guard del rebuild sólo conocía "línea nueva de PO". Un cambio de forma
    // (crudo → landed + negativas) lo decide ahora el predicado compartido; el
    // control negativo es la mitad: un regular que YA tiene sus negativas no se
    // borra — a ése lo refresca el Mod.
    console.log("\n§8d — el rebuild acepta el cambio de forma y rechaza al que ya está bien");
    const { claimUnlock } = await import("../../lib/purchase-orders/qb-vendor-bill-unlock");
    const { loadRebuildShapeFacts, needsShapeRebuild } = await import(
      "../../lib/purchase-orders/vendor-bill-rebuild-shape"
    );
    // `q` sigue plantado: regular en QB sin clearing, hermanos apuntados y en QB.
    const shapeQ = needsShapeRebuild((await loadRebuildShapeFacts(knexLike as never, q.regularId as string))!);
    check("el predicado pide rebuild para la forma de VB-1142", shapeQ.required === true, shapeQ.reason);
    check("y nombra a los dos hermanos",
      shapeQ.required && shapeQ.reason.includes("VB-SD-service") && shapeQ.reason.includes("VB-SD-freight"),
      shapeQ.reason);
    // Un Mod en vuelo (§8c lo encoló) bloquea el unlock — se limpia para probar el guard.
    await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ANY($1)`,
      [[q.regularId, q.serviceId, q.freightId]]);
    await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [q.poId]);
    const unlockQ = await claimUnlock(knexLike as never, q.regularId as string, {
      reason: "e2e shape change", actorId: "user_sd",
    });
    check("claimUnlock ACEPTA el rebuild sin línea nueva de PO", unlockQ.ok === true, JSON.stringify(unlockQ));
    const stagedQ = await db.query(
      `SELECT intent FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [q.regularId]
    );
    check("y deja la fila en rebuild_prepare (TxnDel primero, el Add lo trae el Reconfirm)",
      stagedQ.rows[0]?.intent === "rebuild_prepare", JSON.stringify(stagedQ.rows));

    // CONTROL NEGATIVO: `h` está en QB CON clearing lines persistidas y sin
    // línea nueva — es el caso del Mod, no del rebuild.
    const shapeH = needsShapeRebuild((await loadRebuildShapeFacts(knexLike as never, h.regularId as string))!);
    check("un regular que YA tiene sus negativas NO pide rebuild", shapeH.required === false, shapeH.reason);
    await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ANY($1)`,
      [[h.regularId, h.serviceId, h.freightId]]);
    await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [h.poId]);
    const unlockH = await claimUnlock(knexLike as never, h.regularId as string, {
      reason: "e2e must refuse", actorId: "user_sd",
    });
    check("y claimUnlock lo RECHAZA con bill_rebuild_not_required",
      unlockH.ok === false && unlockH.code === "bill_rebuild_not_required", JSON.stringify(unlockH));

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
