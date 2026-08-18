/**
 * e2e-local-bill-freight-sandbox.ts
 *
 * Freight capitalization (`vendor_bill.freight_allocation_basis`,
 * `lib/purchase-orders/freight-policy.ts`) driven over REAL HTTP against the
 * sandbox backend (localhost:9099) — create → Save (PATCH) → Confirm, exactly
 * the operator's path. No internal function is called for the money path;
 * only fixture planting and post-condition reads go through the DB directly.
 *
 * WHAT IT COVERS
 *
 *  A. Capitalized, LOCAL bill (no siblings), basis 'units': freight spreads
 *     evenly per unit, the product lines' landed total reconciles to the
 *     penny, the freight_charge line zeroes out, and the QB ADD payload
 *     excludes it from expense_lines while the item cost absorbs it.
 *  B. THE GUARD — same shape, `freight_allocation_basis` left NULL (legacy):
 *     the freight_charge line MUST still reach QuickBooks as its own
 *     ExpenseLine, and item cost must NOT include it. This is the exact
 *     byte-for-byte behavior 2 already-`synced` bills depend on ($8.54 and
 *     $108.98 real QB lines) — regressing this silently erases them from QB
 *     on their next Mod.
 *  C. Positive control — a China-agent-shaped bill (linked siblings, default
 *     CBM basis) confirmed in the SAME run: proves the freight-charge feature
 *     doesn't disturb the pre-existing clearing-lines mechanic.
 *  D. Fail-closed — capitalized basis 'cbm' where NO product line has a CBM
 *     at confirm time (simulating the race the PATCH-time coverage guard
 *     cannot close): confirm refuses rather than dropping real money.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-local-bill-freight-sandbox.ts
 *
 * Requires the sandbox backend running with QB_VENDOR_BILL_MODE=bill in ITS
 * OWN process env (not this script's) — `QB_VENDOR_BILL_MODE=bill ./back-sb`
 * — or every confirm 422s with "BillAdd could not be queued: flag off".
 */

import { Client } from "pg";
import { randomUUID } from "crypto";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const BASE = process.env.SANDBOX_API_URL ?? "http://localhost:9099";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("\n❌ ABORTADO: este E2E es SANDBOX-ONLY (puerto 5499)\n");
  process.exit(2);
}

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface LineSpec {
  qty: number;
  unitCostCents: number;
  cbm?: number | null;
}

interface PoFixture {
  poId: string;
  vendorId: string;
  locationId: string;
  receiptId: string;
  lineIds: string[];
  variantIds: string[];
  itemIds: string[];
}

let seq = 0;

async function plantPoWithReceipt(
  db: Client,
  label: string,
  lines: LineSpec[]
): Promise<PoFixture> {
  const n = `${label}${randomUUID().slice(0, 6)}`;
  const vendorId = `qbvnd_frt_${n}`;
  const locationId = `sloc_frt_${n}`;
  const poId = randomUUID();
  const receiptId = randomUUID();

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, '{}'::jsonb, NOW(), NOW())`,
    [vendorId, `QBV-FRT-${n}`, `Freight E2E ${n}`]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at) VALUES ($1, 'FRT E2E', NOW(), NOW())`,
    [locationId]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id, created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_frt', 'received', $4, $5, $6)`,
    [poId, vendorId, locationId, `PO-FRT-${n}`, 996000 + (seq += 1), `QBPO-FRT-${n}`]
  );
  await db.query(
    `INSERT INTO purchase_order_receipt (id, purchase_order_id, number, seq, status, received_at, received_by_user_id, stock_location_id)
     VALUES ($1, $2, $3, $4, 'applied', NOW(), 'user_frt', $5)`,
    [receiptId, poId, `RCP-FRT-${n}`, 996000 + (seq += 1), locationId]
  );

  const lineIds: string[] = [];
  const variantIds: string[] = [];
  const itemIds: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const spec = lines[i]!;
    const lineId = randomUUID();
    const variantId = `variant_frt_${n}_${i}`;
    const itemId = `iitem_frt_${n}_${i}`;
    const metadata: Record<string, unknown> = { quickbooks_id: `QBITEM-FRT-${n}-${i}` };
    if (spec.cbm !== undefined && spec.cbm !== null) metadata.cbm = spec.cbm;

    await db.query(
      `INSERT INTO inventory_item (id, sku, created_at, updated_at) VALUES ($1, $1, NOW(), NOW())`,
      [itemId]
    );
    await db.query(
      `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
      [variantId, `FRT variant ${i}`, JSON.stringify(metadata)]
    );
    await db.query(
      `INSERT INTO purchase_order_line
         (id, purchase_order_id, product_variant_id, inventory_item_id, sku_snapshot,
          description_snapshot, qty_ordered, qty_received, unit_cost_cents, total_cents, qb_txn_line_id)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $7, $8, $9)`,
      [
        lineId,
        poId,
        variantId,
        itemId,
        `SKU-FRT-${n}-${i}`,
        spec.qty,
        spec.unitCostCents,
        spec.qty * spec.unitCostCents,
        `QBPOLINE-FRT-${n}-${i}`,
      ]
    );
    await db.query(
      `INSERT INTO purchase_order_receipt_line
         (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
          product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
          qty_received_now, qty_on_hand_at_receive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, 0)`,
      [randomUUID(), receiptId, lineId, poId, variantId, itemId, `SKU-FRT-${n}-${i}`, spec.qty]
    );
    lineIds.push(lineId);
    variantIds.push(variantId);
    itemIds.push(itemId);
  }

  return { poId, vendorId, locationId, receiptId, lineIds, variantIds, itemIds };
}

async function cleanupPo(db: Client, f: PoFixture, billIds: string[]): Promise<void> {
  await db.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [f.poId]);
  await db.query(`DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`, [f.poId]);
  for (const billId of billIds) {
    await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`, [billId]);
    await db.query(`DELETE FROM vendor_bill_cost_log WHERE vendor_bill_id = $1`, [billId]);
    await db.query(`DELETE FROM variant_cost_event WHERE source_id = $1`, [billId]);
    await db.query(`DELETE FROM vendor_bill_revision WHERE vendor_bill_id = $1`, [billId]);
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [billId]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [billId]);
  }
  await db.query(`DELETE FROM purchase_order_receipt_line WHERE purchase_order_receipt_id = $1`, [f.receiptId]);
  await db.query(`DELETE FROM purchase_order_receipt WHERE id = $1`, [f.receiptId]);
  await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
  await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
  for (const variantId of f.variantIds) {
    await db.query(`DELETE FROM product_variant WHERE id = $1`, [variantId]);
  }
  for (const itemId of f.itemIds) {
    await db.query(`DELETE FROM inventory_item WHERE id = $1`, [itemId]);
  }
  await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
  await db.query(`DELETE FROM qb_vendor WHERE id = $1`, [f.vendorId]);
}

async function waitForApi(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/pub/version`, { signal: AbortSignal.timeout(4_000) });
      if (r.ok) return;
    } catch {
      // still booting
    }
    if (Date.now() > deadline) throw new Error(`El backend del sandbox no respondió en ${BASE}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main(): Promise<void> {
  console.log("=== e2e-local-bill-freight (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();
  await waitForApi();

  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    await db.end();
    console.error(`No se pudo loguear como ${email} (HTTP ${authRes.status}).`);
    process.exit(1);
  }
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };

  // One freight QB account, reused across every scenario — PATCH only checks
  // it resolves to a valid CostOfGoodsSold "freight and shipping costs" account.
  const freightAccountId = `ACC-FRT-${randomUUID().slice(0, 8)}`;
  await db.query(
    `INSERT INTO qb_account (id, qb_list_id, full_name, name, account_type, is_active, created_at, updated_at)
     VALUES ($1, $1, 'Freight and Shipping Costs:E2E', 'Freight and Shipping Costs:E2E', 'CostOfGoodsSold', true, NOW(), NOW())`,
    [freightAccountId]
  );

  const cleanupTasks: Array<() => Promise<void>> = [];
  cleanupTasks.push(() => db.query(`DELETE FROM qb_account WHERE id = $1`, [freightAccountId]).then(() => undefined));

  try {
    // ── A · Capitalized, LOCAL bill, basis 'units' ────────────────────────────
    console.log("A. Capitalizado — basis 'units'");
    const specsA: LineSpec[] = [
      { qty: 7, unitCostCents: 501 },
      { qty: 13, unitCostCents: 899 },
      { qty: 4, unitCostCents: 12345 },
    ];
    const fA = await plantPoWithReceipt(db, "a", specsA);
    cleanupTasks.push(() => cleanupPo(db, fA, [billA]));
    const goodsA = specsA.reduce((s, l) => s + l.qty * l.unitCostCents, 0); // 64574
    const freightPoolA = 2400; // divides evenly: 24 total units → 100c/unit exactly
    const refA = `REF-FRT-A-${randomUUID().slice(0, 8)}`;

    const createResA = await fetch(`${BASE}/admin/vendor-bills/from-receipts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receipt_ids: [fA.receiptId], reference_id: refA }),
    });
    const createBodyA = (await createResA.json().catch(() => ({}))) as { vendor_bill_id?: string; error?: string };
    check("crea el draft (from-receipts)", createResA.status === 201, `HTTP ${createResA.status} ${createBodyA.error ?? ""}`);
    const billA = createBodyA.vendor_bill_id!;

    const patchResA = await fetch(`${BASE}/admin/vendor-bills/${billA}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        freight_lines: [{ amount_cents: freightPoolA, freight_account_list_id: freightAccountId, description: "Ocean freight" }],
        freight_allocation_basis: "units",
      }),
    });
    const patchBodyA = (await patchResA.json().catch(() => ({}))) as { error?: string };
    check("Save: agrega la freight charge + basis 'units'", patchResA.status === 200, `HTTP ${patchResA.status} ${patchBodyA.error ?? ""}`);

    const confirmResA = await fetch(`${BASE}/admin/purchase-orders/${fA.poId}/receipts/${fA.receiptId}/vendor-bill/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const confirmBodyA = (await confirmResA.json().catch(() => ({}))) as { error?: string };
    check("Confirm succeeds", confirmResA.status === 200, `HTTP ${confirmResA.status} ${confirmBodyA.error ?? ""}`);

    const productLinesA = await db.query<{ id: string; qty: number; freight_per_unit_cents: number; landed_unit_cost_cents: number }>(
      `SELECT id, qty, freight_per_unit_cents, landed_unit_cost_cents FROM vendor_bill_line
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL AND line_type = 'product' ORDER BY unit_cost_cents`,
      [billA]
    );
    const perUnitShares = productLinesA.rows.map((r) => r.freight_per_unit_cents);
    check(
      "a) el flete se reparte por UNIDAD — la cuota es la misma en TODAS las líneas (pool exacto: sin residuo)",
      perUnitShares.every((c) => c === 100),
      JSON.stringify(perUnitShares)
    );

    const freightLineA = await db.query<{ id: string; landed_unit_cost_cents: number; unit_cost_cents: number }>(
      `SELECT id, landed_unit_cost_cents, unit_cost_cents FROM vendor_bill_line
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL AND line_kind = 'freight_charge'`,
      [billA]
    );
    check(
      "c) la línea freight_charge queda landed=0, unit_cost intacto",
      freightLineA.rows[0]?.landed_unit_cost_cents === 0 && freightLineA.rows[0]?.unit_cost_cents === freightPoolA,
      JSON.stringify(freightLineA.rows[0])
    );

    const loggedA = await db.query<{ total: string | null }>(
      `SELECT SUM(landed_unit_cost_cents * received_qty)::text AS total FROM vendor_bill_cost_log
        WHERE vendor_bill_id = $1 AND reversed_at IS NULL`,
      [billA]
    );
    const loggedTotalA = Math.round(Number(loggedA.rows[0]?.total ?? NaN));
    check(
      `b) Σ landed_total(producto) = mercadería + tax(0) + flete = ${money(goodsA + freightPoolA)}`,
      loggedTotalA === goodsA + freightPoolA,
      `logged ${money(loggedTotalA)} vs esperado ${money(goodsA + freightPoolA)}`
    );

    const allLinesA = await db.query<{ unit_cost_cents: number; qty: number }>(
      `SELECT unit_cost_cents, qty FROM vendor_bill_line WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [billA]
    );
    const billTotalA = allLinesA.rows.reduce((s, r) => s + r.unit_cost_cents * r.qty, 0);
    check(
      `d) el total del bill NO cambió — ${money(billTotalA)} = mercadería + flete de la factura del vendor`,
      billTotalA === goodsA + freightPoolA,
      `${billTotalA} vs ${goodsA + freightPoolA}`
    );

    const payloadRowA = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [fA.poId]
    );
    const payloadA = payloadRowA.rows[0]?.payload as {
      item_lines: Array<{ unit_cost_cents: number; quantity: number; amount_cents: number }>;
      expense_lines: Array<{ amount_cents: number; account_list_id: string | null }>;
    };
    const hasFreightExpenseA = (payloadA?.expense_lines ?? []).some((l) => l.amount_cents === freightPoolA);
    check("e) el payload QB NO manda la freight line en expense_lines", !hasFreightExpenseA, JSON.stringify(payloadA?.expense_lines));
    const itemCostSumA = (payloadA?.item_lines ?? []).reduce((s, l) => s + Math.round(l.unit_cost_cents * l.quantity), 0);
    check(
      `e) Σ(item cost) SÍ incluye el flete: ${money(itemCostSumA)} = mercadería + flete`,
      itemCostSumA === goodsA + freightPoolA,
      `${itemCostSumA} vs ${goodsA + freightPoolA}`
    );

    // ── amount_cents (2026-08-18: paridad Amount/Cost para el bridge nuevo) ──
    const sumAmountCentsA = (payloadA?.item_lines ?? []).reduce((s, l) => s + Number(l.amount_cents), 0);
    check(
      `f) Σ amount_cents (item lines) = mercadería + tax(0) + flete = ${money(goodsA + freightPoolA)}, al centavo`,
      sumAmountCentsA === goodsA + freightPoolA,
      `${sumAmountCentsA} vs ${goodsA + freightPoolA} — ${JSON.stringify(payloadA?.item_lines)}`
    );
    const allCarryUnitCostA = (payloadA?.item_lines ?? []).every(
      (l) => typeof l.unit_cost_cents === "number" && l.unit_cost_cents > 0
    );
    check(
      "g) GUARD compatibilidad bridge viejo: cada item line SIGUE llevando unit_cost_cents",
      allCarryUnitCostA,
      JSON.stringify(payloadA?.item_lines?.map((l) => l.unit_cost_cents))
    );
    // Línea qty=4 de specsA: unit_cost_cents CRUDO (12345) × 4 = 49380, pero el
    // flete asignado a esa línea (100c/unidad × 4 = 400) hace que el total
    // EXACTO sea 49780. amount_cents debe llevar el exacto, nunca per_unit × qty
    // tomado de la fuente equivocada (unit_cost_cents crudo de la línea).
    const bigLineA = (payloadA?.item_lines ?? []).find((l) => l.quantity === 4);
    const rawTimesQtyA = 12345 * 4;
    check(
      `h) amount_cents NO es per_unit_crudo × qty — raw×qty=${money(rawTimesQtyA)} vs amount_cents=${money(bigLineA?.amount_cents ?? NaN)} (exacto = raw + flete de esa línea)`,
      typeof bigLineA?.amount_cents === "number" &&
        bigLineA.amount_cents === rawTimesQtyA + 400 &&
        bigLineA.amount_cents !== rawTimesQtyA,
      JSON.stringify(bigLineA)
    );

    // ── B · THE GUARD — same shape, basis left NULL (legacy) ─────────────────
    console.log("\nB. Control negativo LEGACY — basis NULL (el guard de los 2 bills synced)");
    const fB = await plantPoWithReceipt(db, "b", specsA);
    cleanupTasks.push(() => cleanupPo(db, fB, [billB]));
    const goodsB = goodsA; // same shape
    const refB = `REF-FRT-B-${randomUUID().slice(0, 8)}`;

    const createResB = await fetch(`${BASE}/admin/vendor-bills/from-receipts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receipt_ids: [fB.receiptId], reference_id: refB }),
    });
    const createBodyB = (await createResB.json().catch(() => ({}))) as { vendor_bill_id?: string; error?: string };
    check("crea el draft", createResB.status === 201, `HTTP ${createResB.status} ${createBodyB.error ?? ""}`);
    const billB = createBodyB.vendor_bill_id!;

    const patchResB = await fetch(`${BASE}/admin/vendor-bills/${billB}`, {
      method: "PATCH",
      headers,
      // Deliberately NO freight_allocation_basis — stays NULL, legacy.
      body: JSON.stringify({
        freight_lines: [{ amount_cents: freightPoolA, freight_account_list_id: freightAccountId, description: "Ocean freight" }],
      }),
    });
    check("Save: agrega la freight charge, basis intacto (NULL)", patchResB.status === 200, `HTTP ${patchResB.status}`);

    const basisCheckB = await db.query<{ freight_allocation_basis: string | null }>(
      `SELECT freight_allocation_basis FROM vendor_bill WHERE id = $1`,
      [billB]
    );
    check("el bill sigue en política legacy (NULL) tras el Save", basisCheckB.rows[0]?.freight_allocation_basis === null);

    const confirmResB = await fetch(`${BASE}/admin/purchase-orders/${fB.poId}/receipts/${fB.receiptId}/vendor-bill/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const confirmBodyB = (await confirmResB.json().catch(() => ({}))) as { error?: string };
    check("Confirm succeeds", confirmResB.status === 200, `HTTP ${confirmResB.status} ${confirmBodyB.error ?? ""}`);

    const freightLineB = await db.query<{ landed_unit_cost_cents: number; unit_cost_cents: number }>(
      `SELECT landed_unit_cost_cents, unit_cost_cents FROM vendor_bill_line
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL AND line_kind = 'freight_charge'`,
      [billB]
    );
    check(
      "legacy: la freight_charge line NO se zeroed (sigue siendo un gasto puro)",
      freightLineB.rows[0]?.landed_unit_cost_cents === freightPoolA,
      JSON.stringify(freightLineB.rows[0])
    );

    const payloadRowB = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [fB.poId]
    );
    const payloadB = payloadRowB.rows[0]?.payload as {
      item_lines: Array<{ unit_cost_cents: number; quantity: number }>;
      expense_lines: Array<{ amount_cents: number; account_list_id: string | null }>;
    };
    const hasFreightExpenseB = (payloadB?.expense_lines ?? []).some(
      (l) => l.amount_cents === freightPoolA && l.account_list_id === freightAccountId
    );
    check(
      "el guard: bajo legacy el payload SÍ manda la freight line en expense_lines (los 2 bills synced dependen de esto)",
      hasFreightExpenseB,
      JSON.stringify(payloadB?.expense_lines)
    );
    const itemCostSumB = (payloadB?.item_lines ?? []).reduce((s, l) => s + Math.round(l.unit_cost_cents * l.quantity), 0);
    check(
      `el costo de los ítems NO incluye el flete: ${money(itemCostSumB)} = sólo mercadería`,
      itemCostSumB === goodsB,
      `${itemCostSumB} vs ${goodsB}`
    );

    // ── C · Positive control — China-agent shape (siblings), same run ────────
    console.log("\nC. Control positivo — bill con hermanos (base CBM, clearing lines)");
    const specsC: LineSpec[] = [{ qty: 10, unitCostCents: 1000, cbm: 0.01 }];
    const fC = await plantPoWithReceipt(db, "c", specsC);
    const serviceIdC = randomUUID();
    const freightIdC = randomUUID();
    cleanupTasks.push(() => cleanupPo(db, fC, [billC, serviceIdC, freightIdC]));

    for (const [id, type, name, cents] of [
      [serviceIdC, "service", "Commission for Purchase:E2E", 32860],
      [freightIdC, "freight", "Freight and Shipping Costs:E2E-Sib", 85400],
    ] as Array<[string, string, string, number]>) {
      await db.query(
        `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number, reference_id,
            vendor_qb_list_id_snapshot, vendor_name_snapshot, document_date)
         VALUES ($1, $2, 'confirmed', $3, $4, $5, 'QBV-FRT-C', 'Freight E2E C', NOW())`,
        [id, fC.poId, type, `VB-FRT-C-${type}`, `REF-FRT-C-${type}`]
      );
      await db.query(
        `INSERT INTO vendor_bill_line (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
            qb_account_type, sku, description, qty, unit_cost_cents, landed_unit_cost_cents, created_at, updated_at)
         VALUES ($1, $2, 'qb_account', $3, $4, 'Expense', $4, $4, 1, $5, $5, NOW(), NOW())`,
        [`vbl_${randomUUID().replace(/-/g, "")}`, id, `ACC-FRT-C-${type}`, name, cents]
      );
    }

    const refC = `REF-FRT-C-${randomUUID().slice(0, 8)}`;
    const createResC = await fetch(`${BASE}/admin/vendor-bills/from-receipts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receipt_ids: [fC.receiptId], reference_id: refC }),
    });
    const createBodyC = (await createResC.json().catch(() => ({}))) as { vendor_bill_id?: string; error?: string };
    check("crea el draft", createResC.status === 201, `HTTP ${createResC.status} ${createBodyC.error ?? ""}`);
    const billC = createBodyC.vendor_bill_id!;

    const patchResC = await fetch(`${BASE}/admin/vendor-bills/${billC}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        service_vendor_bill_id: serviceIdC,
        freight_vendor_bill_id: freightIdC,
        freight_included: true,
        freight_amount_cents: 85400,
      }),
    });
    check("Save: linkea los hermanos", patchResC.status === 200, `HTTP ${patchResC.status}`);

    const confirmResC = await fetch(`${BASE}/admin/purchase-orders/${fC.poId}/receipts/${fC.receiptId}/vendor-bill/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const confirmBodyC = (await confirmResC.json().catch(() => ({}))) as { error?: string };
    check("Confirm succeeds", confirmResC.status === 200, `HTTP ${confirmResC.status} ${confirmBodyC.error ?? ""}`);

    const clearingC = await db.query<{ n: number | null }>(
      `SELECT jsonb_array_length(qb_clearing_lines) AS n FROM vendor_bill WHERE id = $1`,
      [billC]
    );
    check("las 2 clearing lines quedaron persistidas", Number(clearingC.rows[0]?.n) === 2, JSON.stringify(clearingC.rows[0]));

    const payloadRowC = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline WHERE order_id = $1 AND step = 'vendor_bill_add'`,
      [fC.poId]
    );
    const payloadC = payloadRowC.rows[0]?.payload as {
      item_lines: Array<{ unit_cost_cents: number; quantity: number; amount_cents: number }>;
      expense_lines: Array<{ amount_cents: number }>;
    };
    const itemTotalC = (payloadC?.item_lines ?? []).reduce((s, l) => s + Math.round(l.unit_cost_cents * l.quantity), 0);
    const negativesC = (payloadC?.expense_lines ?? []).filter((l) => l.amount_cents < 0);
    const clearingSumC = negativesC.reduce((s, l) => s + Math.abs(l.amount_cents), 0);
    check(
      `sus números NO se movieron: item ${money(itemTotalC)} − clearing ${money(clearingSumC)} = mercadería cruda ${money(itemTotalC - clearingSumC)}`,
      itemTotalC === 128260 && clearingSumC === 118260 && itemTotalC - clearingSumC === 10000,
      `item=${itemTotalC} clearing=${clearingSumC}`
    );

    // ── amount_cents en el control positivo China: sigue dando su total exacto,
    // y las clearing lines negativas siguen cancelando contra la mercadería cruda.
    const productLineC = (payloadC?.item_lines ?? [])[0];
    const sumAmountCentsC = (payloadC?.item_lines ?? []).reduce((s, l) => s + Number(l.amount_cents), 0);
    check(
      `i) control positivo China: amount_cents de la línea = landed total exacto (${money(128260)})`,
      productLineC?.amount_cents === 128260,
      JSON.stringify(productLineC)
    );
    check(
      "j) control positivo China: unit_cost_cents sigue presente (guard bridge viejo)",
      typeof productLineC?.unit_cost_cents === "number" && productLineC.unit_cost_cents > 0,
      JSON.stringify(productLineC)
    );
    check(
      `k) control positivo China: Σ amount_cents (item) − Σ clearing = mercadería cruda ${money(10000)}`,
      sumAmountCentsC - clearingSumC === 10000,
      `${sumAmountCentsC} - ${clearingSumC} = ${sumAmountCentsC - clearingSumC}`
    );

    // ── D · Fail-closed — basis 'cbm', no line has CBM at confirm time ───────
    console.log("\nD. Fail-closed — la plata no se pierde en silencio");
    const specsD: LineSpec[] = [{ qty: 5, unitCostCents: 2000, cbm: 0.02 }];
    const fD = await plantPoWithReceipt(db, "d", specsD);
    cleanupTasks.push(() => cleanupPo(db, fD, [billD]));
    const refD = `REF-FRT-D-${randomUUID().slice(0, 8)}`;

    const createResD = await fetch(`${BASE}/admin/vendor-bills/from-receipts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receipt_ids: [fD.receiptId], reference_id: refD }),
    });
    const createBodyD = (await createResD.json().catch(() => ({}))) as { vendor_bill_id?: string; error?: string };
    check("crea el draft", createResD.status === 201, `HTTP ${createResD.status} ${createBodyD.error ?? ""}`);
    const billD = createBodyD.vendor_bill_id!;

    const patchResD = await fetch(`${BASE}/admin/vendor-bills/${billD}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        freight_lines: [{ amount_cents: 1000, freight_account_list_id: freightAccountId, description: "Ocean freight" }],
        freight_allocation_basis: "cbm",
      }),
    });
    check("Save acepta basis 'cbm' — la línea SÍ tiene CBM en ese momento", patchResD.status === 200, `HTTP ${patchResD.status}`);

    // The race the PATCH-time coverage guard cannot close: CBM disappears
    // between Save and Confirm (edited from Freight Specs, receipt corrected,
    // etc.) — simulated with a direct write, since the PATCH guard already
    // refuses to let a Save do this.
    await db.query(`UPDATE product_variant SET metadata = metadata - 'cbm' WHERE id = $1`, [fD.variantIds[0]]);

    const confirmResD = await fetch(`${BASE}/admin/purchase-orders/${fD.poId}/receipts/${fD.receiptId}/vendor-bill/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const confirmBodyD = (await confirmResD.json().catch(() => ({}))) as { error?: string; code?: string };
    check(
      "el confirm RECHAZA en vez de perder los $10.00 de flete",
      confirmResD.status === 422 && confirmBodyD.code === "freight_unplaceable",
      `HTTP ${confirmResD.status} ${confirmBodyD.code ?? ""} ${confirmBodyD.error ?? ""}`
    );

    const billDAfter = await db.query<{ status: string }>(`SELECT status FROM vendor_bill WHERE id = $1`, [billD]);
    check("el bill queda intacto en draft — nada se confirmó a medias", billDAfter.rows[0]?.status === "draft", String(billDAfter.rows[0]?.status));

    // ── E · El guard de 5 decimales — SIGUE rechazando (bridge sin desplegar) ─
    //
    // ESTE ASSERT SE INVIERTE EL DÍA QUE EL BRIDGE ESTÉ DESPLEGADO Y EL GUARD
    // SE RELAJE. Hoy `unit_cost_cents` todavía viaja SIN condición (compat con
    // un bridge viejo que solo sabe leer <Cost>), así que una cantidad grande
    // cuyo <Cost> a 5 decimales no round-trippea SIGUE debiendo ser rechazada
    // — aceptarla hoy postearía un total que no cierra contra un bridge viejo.
    console.log("\nE. El guard de 5 decimales — SIGUE vigente (bridge no deployado)");
    const specsE: LineSpec[] = [{ qty: 1167, unitCostCents: 137 }];
    const fE = await plantPoWithReceipt(db, "e", specsE);
    cleanupTasks.push(() => cleanupPo(db, fE, [billE]));
    const refE = `REF-FRT-E-${randomUUID().slice(0, 8)}`;
    // 1167 × $1.37 = $15,987.99 + $0.03 of sales tax = $15,988.02 exactly, but
    // 15988.02 ÷ 1167 ÷ 100, rounded to QBXML's 5-decimal <Cost>, does NOT
    // round-trip back to the exact cent total (drift = 1c) — verified with the
    // same formula the backend runs (`Number((exact/qty/100).toFixed(5))`).

    const createResE = await fetch(`${BASE}/admin/vendor-bills/from-receipts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ receipt_ids: [fE.receiptId], reference_id: refE }),
    });
    const createBodyE = (await createResE.json().catch(() => ({}))) as { vendor_bill_id?: string; error?: string };
    check("crea el draft", createResE.status === 201, `HTTP ${createResE.status} ${createBodyE.error ?? ""}`);
    const billE = createBodyE.vendor_bill_id!;

    const patchResE = await fetch(`${BASE}/admin/vendor-bills/${billE}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ tax_amount_cents: 3 }),
    });
    const patchBodyE = (await patchResE.json().catch(() => ({}))) as { error?: string };
    check("Save: agrega $0.03 de sales tax", patchResE.status === 200, `HTTP ${patchResE.status} ${patchBodyE.error ?? ""}`);

    const confirmResE = await fetch(`${BASE}/admin/purchase-orders/${fE.poId}/receipts/${fE.receiptId}/vendor-bill/confirm`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const confirmBodyE = (await confirmResE.json().catch(() => ({}))) as { error?: string };
    check(
      "el confirm SIGUE rechazando 422 — qty 1167 no round-trippea en 5 decimales de <Cost> ($0.03 de tax)",
      confirmResE.status === 422 && /5-decimal/.test(confirmBodyE.error ?? ""),
      `HTTP ${confirmResE.status} ${confirmBodyE.error ?? ""}`
    );

    const billEAfter = await db.query<{ status: string }>(`SELECT status FROM vendor_bill WHERE id = $1`, [billE]);
    check("el bill queda intacto en draft — el guard no dejó nada a medias", billEAfter.rows[0]?.status === "draft", String(billEAfter.rows[0]?.status));
  } finally {
    for (const task of cleanupTasks.reverse()) {
      await task().catch((err) => console.error("cleanup error:", err));
    }
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
