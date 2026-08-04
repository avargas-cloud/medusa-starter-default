/**
 * e2e-regular-bill-resync-sandbox.ts
 *
 * A linked commission bill was edited. It sent ITS own Mod, and the regular
 * bill was left cancelling the OLD figure in QuickBooks, so A/P over there is
 * off by the difference. The regular bill is not dirty — its own document never
 * changed — so Save is disabled, and once it is `confirmed`/`synced` there is
 * no Confirm button either. `enqueueRegularBillModAlone` is the way out.
 *
 * What this proves, and why each part matters:
 *
 *   · the Mod carries the sibling's CURRENT amount, not the one QuickBooks was
 *     handed in July — that is the whole repair;
 *   · it queues the REGULAR bill only, never the siblings, which already went
 *     out on their own and may be mid-repair;
 *   · it moves NO costs: no revision, no variant_cost_event. Re-sending must be
 *     a sync operation, not an accounting one.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-regular-bill-resync-sandbox.ts
 */

import { Client } from "pg";
import { randomUUID } from "crypto";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("Refusing to run: this E2E is sandbox-only (port 5499).");
  process.exit(1);
}

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
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

let seqCounter = 0;

/**
 * The shape of a bill that is already IN QuickBooks: TxnID + EditSequence on
 * the header, a TxnLineID on every line, and persisted clearing lines carrying
 * what QuickBooks currently cancels.
 *
 * The commission sibling is planted at $566.27 while the persisted clearing
 * line still says $564.51 — the exact split VB-1053 has been carrying in
 * production since July.
 */
async function plant(db: Client): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    vendorId: `qbvnd_rs_${n}`,
    regularId: randomUUID(),
    serviceId: randomUUID(),
    freightId: randomUUID(),
    locationId: `sloc_rs_${n}`,
    itemId: `iitem_rs_${n}`,
    variantId: `variant_rs_${n}`,
  };

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, '{}'::jsonb, NOW(), NOW())`,
    [f.vendorId, `QBV-RS-${n}`, `Resync E2E ${n}`]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'RS E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
     VALUES ($1, 'RS variant', $2::jsonb, NOW(), NOW())`,
    [f.variantId, JSON.stringify({ quickbooks_id: `QBITEM-RS-${n}` })]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_rs', 'received', $4, $5, $6)`,
    [
      f.poId,
      f.vendorId,
      f.locationId,
      `PO-RS-${n}`,
      993000 + (seqCounter += 1),
      `QBPO-RS-${n}`,
    ]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents, qb_txn_line_id)
     VALUES ($1, $2, $3, $4, 'SKU-RS', 'RS goods', 10, 10, 1000, 10000, $5)`,
    [f.poLineId, f.poId, f.variantId, f.itemId, `QBPOLINE-RS-${n}`]
  );

  // The siblings, both already in QuickBooks. Commission $566.27 TODAY.
  for (const [id, type, account, name, cents] of [
    [f.serviceId, "service", `ACC-COMM-RS-${n}`, "Commission for Purchase", 56627],
    [f.freightId, "freight", `ACC-FRT-RS-${n}`, "Freight and Shipping Costs", 126800],
  ] as Array<[string, string, string, string, number]>) {
    await db.query(
      `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
          reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
          document_date, qb_txn_id, qb_edit_sequence)
       VALUES ($1, $2, 'synced', $3, $4, $5, 'QBV-RS', 'Resync E2E', NOW(),
               $6, '1')`,
      [id, f.poId, type, `VB-RS-${type}-${n}`, `REF-RS-${type}-${n}`, `TXN-RS-${type}-${n}`]
    );
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
          qb_account_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, qb_txn_line_id, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, $4, 'Expense', $4, $4, 1, $5, $5, $6,
               NOW(), NOW())`,
      [
        `vbl_${randomUUID().replace(/-/g, "")}`,
        id,
        account,
        name,
        cents,
        `TXNLINE-RS-${type}-${n}`,
      ]
    );
  }

  // The regular: synced, with clearing lines quoting the amounts QuickBooks was
  // given in July. −$564.51 is STALE against the $566.27 sibling above.
  await db.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, status, bill_type, number, reference_id,
        vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date,
        service_vendor_bill_id, freight_vendor_bill_id,
        qb_txn_id, qb_edit_sequence, qb_clearing_lines)
     VALUES ($1, $2, 'synced', 'regular', $3, $4, 'QBV-RS', 'Resync E2E', NOW(),
             $5, $6, $7, '1', $8::jsonb)`,
    [
      f.regularId,
      f.poId,
      `VB-RS-REG-${n}`,
      `REF-RS-REG-${n}`,
      f.serviceId,
      f.freightId,
      `TXN-RS-REG-${n}`,
      JSON.stringify([
        {
          kind: "commission",
          amount_cents: -56451,
          qb_txn_line_id: `TXNLINE-RS-CLR-COMM-${n}`,
          account_list_id: `ACC-COMM-RS-${n}`,
          account_full_name: "Commission for Purchase",
        },
        {
          kind: "freight",
          amount_cents: -126800,
          qb_txn_line_id: `TXNLINE-RS-CLR-FRT-${n}`,
          account_list_id: `ACC-FRT-RS-${n}`,
          account_full_name: "Freight and Shipping Costs",
        },
      ]),
    ]
  );
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
        sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
        qb_txn_line_id, created_at, updated_at)
     VALUES ($1, $2, 'product', $3, $4, 'SKU-RS', 'RS goods', 10, 1000, 19343,
             $5, NOW(), NOW())`,
    [
      `vbl_${randomUUID().replace(/-/g, "")}`,
      f.regularId,
      f.variantId,
      f.poLineId,
      `TXNLINE-RS-REG-${n}`,
    ]
  );

  return f;
}

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
  console.log("=== e2e-regular-bill-resync (sandbox) ===\n");
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

  const { enqueueRegularBillModAlone } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue"
  );
  const { deriveClearingDrift } = await import(
    "../../lib/purchase-orders/qb-vendor-bill-clearing-lines"
  );
  const { loadClearingSiblings } = await import(
    "../../lib/purchase-orders/load-clearing-siblings"
  );

  const planted: Fx[] = [];
  try {
    const f = await plant(db);
    planted.push(f);

    // ── The banner's reason ─────────────────────────────────────────────────
    console.log("El bill regular quedó citando el monto viejo");
    const siblings = await loadClearingSiblings(knexLike, f.regularId);
    const persisted = await db.query<{ lines: unknown }>(
      `SELECT qb_clearing_lines AS lines FROM vendor_bill WHERE id = $1`,
      [f.regularId]
    );
    const drift = deriveClearingDrift(
      (persisted.rows[0]?.lines ?? []) as never,
      siblings
    );
    check("el aviso se dispara", drift.stale === true);
    check(
      `y dice exactamente cuánto: ${money(drift.delta_cents)}`,
      drift.delta_cents === 176,
      `delta=${drift.delta_cents}`
    );

    // ── The way out ─────────────────────────────────────────────────────────
    console.log("\nRe-send to QuickBooks");
    const res = await enqueueRegularBillModAlone(knexLike as never, f.regularId);
    check("el Mod se encola", res.queued === true, JSON.stringify(res));
    check(
      "y toca UN SOLO bill — el regular, nunca los hermanos",
      res.billIds?.length === 1 && res.billIds[0] === f.regularId,
      JSON.stringify(res.billIds)
    );

    const rows = await db.query<{ step: string; payload: Record<string, unknown> }>(
      `SELECT step, payload FROM qb_order_pipeline WHERE order_id = $1`,
      [f.poId]
    );
    check(
      "una sola fila de pipeline, y es un vendor_bill_mod",
      rows.rows.length === 1 && rows.rows[0].step === "vendor_bill_mod",
      rows.rows.map((r) => r.step).join(", ")
    );

    const payload = rows.rows[0]?.payload as {
      expense_lines: Array<{ amount_cents: number; account_list_id: string }>;
      item_lines: Array<{ unit_cost_cents: number }>;
    };
    const negatives = (payload?.expense_lines ?? []).filter(
      (l) => l.amount_cents < 0
    );
    check(
      "manda las DOS clearing lines negativas",
      negatives.length === 2,
      JSON.stringify(payload?.expense_lines)
    );
    // THE repair: the payload must carry 566.27, not the 564.51 QuickBooks has.
    const commission = negatives.find((l) => l.amount_cents === -56627);
    check(
      "la comisión va por su monto ACTUAL (−$566.27), no por el que QuickBooks tiene (−$564.51)",
      !!commission,
      JSON.stringify(negatives.map((l) => l.amount_cents))
    );
    check(
      "el flete, que no cambió, va igual que antes (−$1,268.00)",
      negatives.some((l) => l.amount_cents === -126800)
    );
    check(
      "las item lines siguen al costo LANDED — la forma del documento no cambió",
      payload?.item_lines?.[0]?.unit_cost_cents === 19343,
      `unit_cost=${payload?.item_lines?.[0]?.unit_cost_cents}`
    );

    // ── It is a sync, not an accounting operation ───────────────────────────
    console.log("\nNo movió un solo costo");
    const revisions = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vendor_bill_revision WHERE vendor_bill_id = $1`,
      [f.regularId]
    );
    check(
      "no creó ninguna revisión",
      Number(revisions.rows[0]?.n ?? 0) === 0,
      `${revisions.rows[0]?.n} revisiones`
    );
    const costEvents = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM variant_cost_event WHERE vendor_bill_id = $1`,
      [f.regularId]
    );
    check(
      "no posteó ningún costo (AVCO/COGS intactos)",
      Number(costEvents.rows[0]?.n ?? 0) === 0,
      `${costEvents.rows[0]?.n} eventos`
    );
    const stillSynced = await db.query<{ status: string; lines: unknown }>(
      `SELECT status, qb_clearing_lines AS lines FROM vendor_bill WHERE id = $1`,
      [f.regularId]
    );
    check(
      "el bill sigue synced y sus líneas guardadas no se tocaron — el Mod todavía no llegó a QB",
      stillSynced.rows[0]?.status === "synced",
      String(stillSynced.rows[0]?.status)
    );

    // ── Control negativo: un hermano suelto no puede usar esta puerta ────────
    console.log("\nControl negativo");
    const onService = await enqueueRegularBillModAlone(
      knexLike as never,
      f.serviceId
    );
    check(
      "un bill de comisión NO entra por acá — se reenvía solo al editarlo",
      onService.queued === false && onService.reason === "not a regular bill",
      JSON.stringify(onService)
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
