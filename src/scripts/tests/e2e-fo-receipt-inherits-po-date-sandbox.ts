/**
 * e2e-fo-receipt-inherits-po-date-sandbox.ts
 *
 * A Factory Order mirrored from a PO (the SKYDANCE button) documents goods a
 * factory supplied for a purchase order placed weeks ago. Dating its receipt
 * "today" files the INFLOW after the transfers that already carried those units
 * out of China, and the China History ledger — which orders receipts by
 * `received_at` and transfers by `shipped_at` — then draws the chain dipping
 * below its own opening balance and recovering at the bottom: a shortfall the
 * warehouse never had.
 *
 * `POST /admin/factory-orders/:id/receive` therefore defaults `received_at` to
 * the FO's `ordered_at` WHEN the FO is mirrored (`linked_purchase_order_id` set);
 * a standalone FO still gets today, and an explicit `body.received_at` always
 * wins.
 *
 * SANDBOX ONLY: talks to http://localhost:9099 and postgres :5499. Refuses to
 * run anywhere else.
 *
 * Run:  ./node_modules/.bin/tsx src/scripts/tests/e2e-fo-receipt-inherits-po-date-sandbox.ts
 */

import { Client } from "pg";

// The ledger ORDER is a POS concern, so it is asserted with the very function
// the screen renders — a local re-implementation would only prove itself.
import {
  buildBalanceLedger,
  type ChinaHistoryResponse,
  type LedgerEntry,
} from "../../../../store-pos/lib/china-history-ledger";

const API = "http://localhost:9099";
const DB_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";
const SKY_LIST_ID = "800019B5-1633985881";
const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<FetchResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Local calendar day, the same key the ledger files a row under. */
const dayKey = (d: string | Date): string => {
  const t = d instanceof Date ? d : new Date(d);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(
    t.getDate()
  ).padStart(2, "0")}`;
};

interface Fixture {
  variant_id: string;
  inventory_item_id: string;
  sku: string;
  title: string;
}

/**
 * China stock for one inventory item. Reads the numeric column AND its BigNumber
 * mirror together and reports both — a fix that moves only one of them leaves a
 * ghost that every Medusa reader still sees.
 */
async function chinaStock(
  db: Client,
  itemId: string
): Promise<{ stocked: number; raw: number; present: boolean; divergent: boolean }> {
  const r = await db.query(
    `SELECT stocked_quantity::text AS s, raw_stocked_quantity AS raw
       FROM inventory_level
      WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL`,
    [itemId, CHINA_LOC]
  );
  const row = r.rows[0] as { s: string; raw: { value?: string } | null } | undefined;
  if (!row) return { stocked: 0, raw: 0, present: false, divergent: false };
  const stocked = Number(row.s);
  const raw = Number(row.raw?.value ?? NaN);
  return {
    stocked,
    raw,
    present: true,
    divergent: !Number.isFinite(raw) || raw !== stocked,
  };
}

function fmtChain(led: LedgerEntry[]): string {
  return led
    .map(
      (e) =>
        `${dayKey(e.date)} ${e.kind}${e.ref ? `(${e.ref})` : ""} ${
          e.qty >= 0 ? "+" : ""
        }${e.qty} → ${e.running}`
    )
    .join("\n      ");
}

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const guard = await db.query(`SELECT inet_server_port() AS port`);
  const port = String((guard.rows[0] as { port: number })?.port);
  if (port !== "5432" && port !== "5499") {
    throw new Error("refusing: not the sandbox database");
  }

  // ── login ───────────────────────────────────────────────────────────────
  const login = await api(null, "POST", "/auth/user/emailpass", {
    email: "sandbox@test.com",
    password: "sandbox123",
  });
  const token = login.body.token as string | undefined;
  if (!token) throw new Error(`sandbox login failed (${login.status})`);

  // The mirror POST is supervisor-PIN gated. The PIN is read from the DB at
  // runtime — the value must never be hardcoded here (secrets rule).
  const pinRow = (
    await db.query(
      `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
        WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    )
  ).rows[0] as { pin: string } | undefined;
  if (!pinRow?.pin) throw new Error("sandbox store has no supervisor PIN configured");
  const PIN_HEADER = { "x-supervisor-pin": pinRow.pin };

  // ── fixtures ────────────────────────────────────────────────────────────
  // The PO vendor is the China purchasing AGENT; the manufacturer is SKYDANCE.
  const agent = (
    await db.query(
      `SELECT id, name, qb_list_id FROM qb_vendor
        WHERE (metadata->>'is_china_agent') = 'true'
          AND deleted_at IS NULL AND qb_list_id IS NOT NULL AND qb_list_id <> $1
        ORDER BY id LIMIT 1`,
      [SKY_LIST_ID]
    )
  ).rows[0] as { id: string; name: string; qb_list_id: string } | undefined;
  if (!agent) throw new Error("no China-agent vendor in the sandbox");

  const sky = (
    await db.query(
      `SELECT pv.id AS variant_id, pvi.inventory_item_id, pv.sku, p.title
         FROM product p
         JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
         JOIN product_variant_inventory_item pvi
           ON pvi.variant_id = pv.id AND pvi.deleted_at IS NULL
        WHERE p.metadata->>'vendor_list_id' = $1
          AND p.deleted_at IS NULL AND pv.sku IS NOT NULL
          -- A clean SKU: no China history at all, so the ledger under test is
          -- exactly the rows this run creates and nothing else can explain a dip.
          AND NOT EXISTS (SELECT 1 FROM factory_order_receipt_line frl
                           WHERE frl.product_variant_id = pv.id AND frl.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM inventory_transfer_line itl
                           WHERE itl.product_variant_id = pv.id AND itl.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM china_adjustment_line cal
                           WHERE cal.inventory_item_id = pvi.inventory_item_id)
        ORDER BY pv.id
        LIMIT 2`,
      [SKY_LIST_ID]
    )
  ).rows as Fixture[];
  if (sky.length < 2) {
    throw new Error(
      `need 2 SKYDANCE SKUs with no China history; found ${sky.length}`
    );
  }
  const [skyA, skyB] = sky as [Fixture, Fixture];

  const locRow = (
    await db.query(
      `SELECT id FROM stock_location WHERE deleted_at IS NULL ORDER BY id LIMIT 1`
    )
  ).rows[0] as { id: string };

  const userRow = (
    await db.query(`SELECT id FROM "user" WHERE email = 'sandbox@test.com' LIMIT 1`)
  ).rows[0] as { id: string } | undefined;
  if (!userRow) throw new Error("sandbox user not found");

  console.log(
    `Fixtures — agent vendor: ${agent.name} (${agent.qb_list_id})\n` +
      `           mirrored SKU: ${skyA.sku} (${skyA.variant_id})\n` +
      `           standalone SKU: ${skyB.sku} (${skyB.variant_id})`
  );

  // ── dates ───────────────────────────────────────────────────────────────
  const today = new Date();
  const poOrdered = new Date(today);
  poOrdered.setDate(poOrdered.getDate() - 45);
  poOrdered.setHours(14, 30, 0, 0); // AFTER the transfer's clock time on purpose
  const transferShipped = new Date(poOrdered);
  transferShipped.setHours(8, 0, 0, 0);
  const explicitReceived = new Date(today);
  explicitReceived.setDate(explicitReceived.getDate() - 10);
  explicitReceived.setHours(11, 0, 0, 0);

  console.log(
    `Dates    — PO ordered_at ${poOrdered.toISOString()} (day ${dayKey(poOrdered)})\n` +
      `           transfer shipped_at ${transferShipped.toISOString()} (same day, 06h30 EARLIER)\n` +
      `           explicit received_at ${explicitReceived.toISOString()} (day ${dayKey(
        explicitReceived
      )})\n` +
      `           today ${dayKey(today)}`
  );

  const stockBefore = await chinaStock(db, skyA.inventory_item_id);
  console.log(
    `China stock before — stocked=${stockBefore.stocked} raw=${stockBefore.raw} present=${stockBefore.present}`
  );
  check(
    "0.1 China stock numeric and raw agree before the run",
    !stockBefore.divergent,
    `stocked=${stockBefore.stocked} raw=${stockBefore.raw}`
  );

  // ══ 1. Main case ════════════════════════════════════════════════════════
  console.log("\nStep 1 — PO with an OLD ordered_at, mirrored to a Skydance FO");
  const poCreate = await api(token, "POST", "/admin/purchase-orders", {
    vendor_id: agent.id,
    stock_location_id: locRow.id,
    ordered_at: poOrdered.toISOString(),
    lines: [
      {
        product_variant_id: skyA.variant_id,
        inventory_item_id: skyA.inventory_item_id,
        sku_snapshot: skyA.sku,
        description_snapshot: skyA.title || skyA.sku,
        qty_ordered: 10,
        unit_cost_cents: 1000,
        line_order: 0,
      },
    ],
  });
  const po = poCreate.body.purchase_order as { id: string; number: string | null } | undefined;
  check(
    "1.0 PO created",
    poCreate.status === 201 && !!po?.id,
    JSON.stringify(poCreate.body).slice(0, 200)
  );
  if (!po?.id) throw new Error("cannot continue without a PO");

  const poRow = (
    await db.query(`SELECT ordered_at FROM purchase_order WHERE id = $1`, [po.id])
  ).rows[0] as { ordered_at: Date };
  check(
    "1.0b PO stored the old ordered_at",
    dayKey(poRow.ordered_at) === dayKey(poOrdered),
    `stored ${dayKey(poRow.ordered_at)} vs sent ${dayKey(poOrdered)}`
  );

  const mirror = await api(
    token,
    "POST",
    `/admin/purchase-orders/${po.id}/factory-order-mirror`,
    { manufacturer: "Skydance" },
    PIN_HEADER
  );
  const fo = mirror.body.factory_order as { id: string; number: string | null } | undefined;
  check(
    "1.0c mirror created the FO",
    mirror.status === 201 && mirror.body.action === "created" && !!fo?.id,
    JSON.stringify(mirror.body).slice(0, 250)
  );
  if (!fo?.id) throw new Error("cannot continue without the mirrored FO");

  const foRow = (
    await db.query(
      `SELECT ordered_at, linked_purchase_order_id FROM factory_order WHERE id = $1`,
      [fo.id]
    )
  ).rows[0] as { ordered_at: Date | null; linked_purchase_order_id: string | null };

  // 1a — non-regression control: the mirror already copied the PO's date.
  check(
    "1a FO.ordered_at == PO.ordered_at (non-regression control)",
    !!foRow.ordered_at && dayKey(foRow.ordered_at) === dayKey(poRow.ordered_at),
    `FO ${foRow.ordered_at ? dayKey(foRow.ordered_at) : "null"} vs PO ${dayKey(
      poRow.ordered_at
    )}`
  );
  check(
    "1a' FO carries linked_purchase_order_id",
    foRow.linked_purchase_order_id === po.id,
    String(foRow.linked_purchase_order_id)
  );

  const submit = await api(token, "POST", `/admin/factory-orders/${fo.id}/submit`, {});
  check(
    "1.1 FO submitted",
    submit.status === 200,
    JSON.stringify(submit.body).slice(0, 200)
  );

  const foLine = (
    await db.query(
      `SELECT id FROM factory_order_line
        WHERE factory_order_id = $1 AND product_variant_id = $2 AND deleted_at IS NULL`,
      [fo.id, skyA.variant_id]
    )
  ).rows[0] as { id: string };

  // 1b — THE CHANGE: receive with NO received_at in the body.
  const rcv1 = await api(token, "POST", `/admin/factory-orders/${fo.id}/receive`, {
    lines: [{ fo_line_id: foLine.id, qty_received_now: 6 }],
  });
  check(
    "1.1b receive #1 applied (6 units, no received_at sent)",
    rcv1.status === 200,
    JSON.stringify(rcv1.body).slice(0, 250)
  );
  const receipt1 = rcv1.body.receipt as { id: string; number: string | null } | undefined;
  const r1Row = (
    await db.query(
      `SELECT id, number, received_at, status FROM factory_order_receipt
        WHERE factory_order_id = $1 ORDER BY created_at ASC`,
      [fo.id]
    )
  ).rows[0] as { id: string; number: string; received_at: Date; status: string };

  console.log(
    `      receipt #1 ${r1Row.number}: received_at = ${r1Row.received_at.toISOString()} (day ${dayKey(
      r1Row.received_at
    )}); PO day = ${dayKey(poRow.ordered_at)}; today = ${dayKey(today)}`
  );
  check(
    "1b receipt.received_at falls on the SAME DAY as the PO's ordered_at",
    dayKey(r1Row.received_at) === dayKey(poRow.ordered_at),
    `receipt ${dayKey(r1Row.received_at)} vs PO ${dayKey(poRow.ordered_at)} (today is ${dayKey(
      today
    )})`
  );
  check(
    "1b' and it is NOT today (the default it replaced)",
    dayKey(r1Row.received_at) !== dayKey(today),
    `receipt ${dayKey(r1Row.received_at)}`
  );

  // ══ 2. The explicit override still wins ═════════════════════════════════
  console.log("\nStep 2 — receive #2 WITH an explicit received_at");
  const rcv2 = await api(token, "POST", `/admin/factory-orders/${fo.id}/receive`, {
    lines: [{ fo_line_id: foLine.id, qty_received_now: 2 }],
    received_at: explicitReceived.toISOString(),
  });
  check(
    "2.0 receive #2 applied (2 units)",
    rcv2.status === 200,
    JSON.stringify(rcv2.body).slice(0, 250)
  );
  const r2Row = (
    await db.query(
      `SELECT id, number, received_at FROM factory_order_receipt
        WHERE factory_order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [fo.id]
    )
  ).rows[0] as { id: string; number: string; received_at: Date };
  console.log(
    `      receipt #2 ${r2Row.number}: received_at = ${r2Row.received_at.toISOString()} (day ${dayKey(
      r2Row.received_at
    )})`
  );
  check(
    "2 explicit received_at is honoured to the millisecond",
    r2Row.received_at.getTime() === explicitReceived.getTime(),
    `stored ${r2Row.received_at.toISOString()} vs sent ${explicitReceived.toISOString()}`
  );
  check(
    "2' and it is NOT the PO's date",
    dayKey(r2Row.received_at) !== dayKey(poRow.ordered_at),
    `${dayKey(r2Row.received_at)}`
  );

  // ══ 3. Positive control: a standalone FO still gets TODAY ════════════════
  // It is given the SAME old ordered_at as the PO, so the only thing that can
  // explain a difference is `linked_purchase_order_id`. Without this, the change
  // could be backdating every receipt and the suite would not notice.
  console.log("\nStep 3 — standalone FO (no linked PO) with the SAME old ordered_at");
  const soloCreate = await api(token, "POST", "/admin/factory-orders", {
    vendor_id: agent.id,
    ordered_at: poOrdered.toISOString(),
    lines: [
      {
        product_variant_id: skyB.variant_id,
        inventory_item_id: skyB.inventory_item_id,
        sku_snapshot: skyB.sku,
        description_snapshot: skyB.title || skyB.sku,
        qty_ordered: 5,
        unit_cost_cents: 800,
        line_order: 0,
      },
    ],
  });
  const solo = soloCreate.body.factory_order as { id: string } | undefined;
  check(
    "3.0 standalone FO created",
    soloCreate.status === 201 && !!solo?.id,
    JSON.stringify(soloCreate.body).slice(0, 250)
  );
  if (!solo?.id) throw new Error("cannot continue without the standalone FO");

  const soloRow = (
    await db.query(
      `SELECT ordered_at, linked_purchase_order_id FROM factory_order WHERE id = $1`,
      [solo.id]
    )
  ).rows[0] as { ordered_at: Date | null; linked_purchase_order_id: string | null };
  check(
    "3.0b standalone FO has NO linked_purchase_order_id",
    soloRow.linked_purchase_order_id === null,
    String(soloRow.linked_purchase_order_id)
  );
  check(
    "3.0c standalone FO does carry the old ordered_at (isolates the linked-PO condition)",
    !!soloRow.ordered_at && dayKey(soloRow.ordered_at) === dayKey(poOrdered),
    soloRow.ordered_at ? dayKey(soloRow.ordered_at) : "null"
  );

  const soloSubmit = await api(token, "POST", `/admin/factory-orders/${solo.id}/submit`, {});
  check("3.1 standalone FO submitted", soloSubmit.status === 200, JSON.stringify(soloSubmit.body).slice(0, 200));
  const soloLine = (
    await db.query(
      `SELECT id FROM factory_order_line
        WHERE factory_order_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [solo.id]
    )
  ).rows[0] as { id: string };
  const soloRcv = await api(token, "POST", `/admin/factory-orders/${solo.id}/receive`, {
    lines: [{ fo_line_id: soloLine.id, qty_received_now: 1 }],
  });
  check(
    "3.2 standalone receive applied (1 unit, no received_at sent)",
    soloRcv.status === 200,
    JSON.stringify(soloRcv.body).slice(0, 250)
  );
  const soloReceipt = (
    await db.query(
      `SELECT number, received_at FROM factory_order_receipt
        WHERE factory_order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [solo.id]
    )
  ).rows[0] as { number: string; received_at: Date };
  console.log(
    `      standalone receipt ${soloReceipt.number}: received_at = ${soloReceipt.received_at.toISOString()} (day ${dayKey(
      soloReceipt.received_at
    )})`
  );
  check(
    "3 standalone FO receipt is dated TODAY, not the FO's ordered_at",
    dayKey(soloReceipt.received_at) === dayKey(today),
    `receipt ${dayKey(soloReceipt.received_at)} vs today ${dayKey(today)}`
  );

  // ══ 4. The effect the owner asked for: the ledger no longer dips ═════════
  // A transfer that carried 4 of those units OUT of China on the SAME day, six
  // and a half hours EARLIER on the clock. Inserted directly: this test reads
  // the ledger, and going through the transfer API would move stock and confound
  // assert 5.
  console.log("\nStep 4 — China History ledger for the mirrored SKU");
  const transferId = `it_e2e_${Date.now()}`;
  const transferNumber = `IT-E2E-${String(Date.now()).slice(-6)}`;
  await db.query(
    `INSERT INTO inventory_transfer
       (id, number, seq, status, origin_country, destination_location_id, vendor_id,
        vendor_name_snapshot, total_lines, total_units, subtotal_cents,
        created_by_user_id, confirmed_at, shipped_at, created_at, updated_at)
     VALUES ($1,$2,NULL,'shipped','CN',$3,$4,$5,1,4,4000,$6,$7,$7,NOW(),NOW())`,
    [transferId, transferNumber, locRow.id, agent.id, agent.name, userRow.id, transferShipped]
  );
  await db.query(
    `INSERT INTO inventory_transfer_line
       (id, transfer_id, product_variant_id, sku, description, qty, unit_cost_cents,
        qty_received, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,4,1000,0,NOW(),NOW())`,
    [`itl_e2e_${Date.now()}`, transferId, skyA.variant_id, skyA.sku, skyA.title || skyA.sku]
  );

  const hist = await api(
    token,
    "GET",
    `/admin/pos/china-product-history?variant_id=${skyA.variant_id}&inventory_item_id=${skyA.inventory_item_id}&period=all`
  );
  check("4.0 china-product-history 200", hist.status === 200, JSON.stringify(hist.body).slice(0, 200));
  const data = hist.body as unknown as ChinaHistoryResponse;
  check(
    "4.0b the ledger sees exactly this run's rows (2 receipts, 1 transfer, 0 adjustments)",
    data.fo_receipts.length === 2 &&
      data.transfers_out.length === 1 &&
      data.adjustments.length === 0,
    `receipts=${data.fo_receipts.length} transfers=${data.transfers_out.length} adj=${data.adjustments.length}`
  );

  const ledger = buildBalanceLedger(data);
  console.log(
    `      beginning_balance=${data.beginning_balance}  physical_china=${data.current_state.physical_china}  in_transit=${data.current_state.in_transit}  stocked=${data.current_state.stocked}`
  );
  console.log(`      chain:\n      ${fmtChain(ledger)}`);

  const idxReceipt1 = ledger.findIndex((e) => e.key === `fo:${r1Row.id}`);
  const idxTransfer = ledger.findIndex((e) => e.key === `tr:${transferId}`);
  check(
    "4a the FO receipt is ordered BEFORE the same-day transfer",
    idxReceipt1 >= 0 && idxTransfer >= 0 && idxReceipt1 < idxTransfer,
    `receipt idx=${idxReceipt1} transfer idx=${idxTransfer}`
  );

  const runnings = ledger.map((e) => e.running ?? 0);
  const opening = runnings[0] as number;
  const closing = runnings[runnings.length - 1] as number;
  const minRunning = Math.min(...runnings);
  console.log(
    `      opening=${opening}  closing=${closing}  min=${minRunning}  (closing must equal physical_china=${data.current_state.physical_china})`
  );
  check(
    "4b the running balance never dips below its opening",
    minRunning === opening,
    `min=${minRunning} opening=${opening}`
  );
  check(
    "4b' the chain closes on physical_china",
    closing === data.current_state.physical_china,
    `closing=${closing} physical_china=${data.current_state.physical_china}`
  );

  // Counterfactual, reported only: what the same rows would draw if the receipt
  // were dated today (i.e. the default this change replaced).
  const clockOrder = [...ledger.slice(1)].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  let cf = data.beginning_balance;
  const cfChain = clockOrder.map((e) => {
    cf += e.qty;
    return `${e.kind}(${e.ref}) ${e.qty >= 0 ? "+" : ""}${e.qty} → ${cf}`;
  });
  console.log(
    `      strict-clock counterfactual (the shape the fix avoids):\n        ${data.beginning_balance} → ${cfChain.join(
      " → "
    )}`
  );

  // ══ 5. The stock moved TODAY, not in the past ═══════════════════════════
  console.log("\nStep 5 — backdating the RECORD did not retro-apply the stock");
  const stockAfter = await chinaStock(db, skyA.inventory_item_id);
  console.log(
    `      China stock after — stocked=${stockAfter.stocked} raw=${stockAfter.raw} (before: ${stockBefore.stocked})`
  );
  check(
    "5.0 China stock numeric and raw still agree",
    !stockAfter.divergent,
    `stocked=${stockAfter.stocked} raw=${stockAfter.raw}`
  );
  check(
    "5 China stocked_quantity rose by exactly the 8 units received",
    stockAfter.stocked - stockBefore.stocked === 8,
    `${stockBefore.stocked} → ${stockAfter.stocked} (delta ${
      stockAfter.stocked - stockBefore.stocked
    })`
  );
  check(
    "5' raw_stocked_quantity rose by the same 8",
    stockAfter.raw - stockBefore.raw === 8,
    `${stockBefore.raw} → ${stockAfter.raw}`
  );

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
