/**
 * e2e-po-fo-mirror-sandbox.ts — end-to-end for the PO → FO mirror (Skydance).
 *
 * SANDBOX ONLY: talks to http://localhost:9099 and postgres :5499. Refuses to
 * run against anything else. Exercises the full loop over HTTP:
 *   create mixed PO → mirror create → PO edits → mirror sync (qty, add, remove)
 *   → FO submit + receive → mirror blocked (409) → manufacturer typo (422)
 * plus the negative assertion that creating/syncing the mirror never moves
 * inventory (only the FO receive does — preexisting behavior).
 *
 * Run:  ./node_modules/.bin/tsx src/scripts/tests/e2e-po-fo-mirror-sandbox.ts
 */

import { Client } from "pg";
import { vendorListIdSql } from "../../lib/vendor-metadata/keys";

const API = "http://localhost:9099";
const DB_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";
const SKY_LIST_ID = "800019B5-1633985881";

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

interface Fixture {
  variant_id: string;
  inventory_item_id: string;
  sku: string;
  title: string;
}

function line(f: Fixture, qty: number, cents: number, order: number) {
  return {
    product_variant_id: f.variant_id,
    inventory_item_id: f.inventory_item_id,
    sku_snapshot: f.sku,
    description_snapshot: f.title || f.sku,
    qty_ordered: qty,
    unit_cost_cents: cents,
    line_order: order,
  };
}

async function invSnapshot(db: Client, itemIds: string[]): Promise<string> {
  const r = await db.query(
    `SELECT inventory_item_id, location_id, stocked_quantity::text, reserved_quantity::text
       FROM inventory_level
      WHERE inventory_item_id = ANY($1)
      ORDER BY inventory_item_id, location_id`,
    [itemIds]
  );
  return JSON.stringify(r.rows);
}

async function foLinesSnapshot(db: Client, foId: string): Promise<string> {
  const r = await db.query(
    `SELECT id, purchase_order_line_id, qty_ordered, unit_cost_cents, sku_snapshot
       FROM factory_order_line
      WHERE factory_order_id = $1 AND deleted_at IS NULL
      ORDER BY id`,
    [foId]
  );
  return JSON.stringify(r.rows);
}

async function main() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const guard = await db.query(`SELECT inet_server_port() AS port`);
  if (String(guard.rows[0]?.port) !== "5432" && String(guard.rows[0]?.port) !== "5499") {
    throw new Error("refusing: not the sandbox database");
  }

  // ── login ──────────────────────────────────────────────────────────────
  const login = await api(null, "POST", "/auth/user/emailpass", {
    email: "sandbox@test.com",
    password: "sandbox123",
  });
  const token = login.body.token as string | undefined;
  if (!token) throw new Error(`sandbox login failed (${login.status})`);

  // The mirror POST is supervisor-PIN gated. The sandbox PIN is read from the
  // DB at runtime — the value must never be hardcoded here (secrets rule).
  const pinRow = (
    await db.query(
      `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
        WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    )
  ).rows[0] as { pin: string } | undefined;
  const PIN = pinRow?.pin;
  if (!PIN) throw new Error("sandbox store has no supervisor PIN configured");
  const PIN_HEADER = { "x-supervisor-pin": PIN };

  // ── fixtures ───────────────────────────────────────────────────────────
  const sky = (
    await db.query(
      `SELECT DISTINCT ON (p.id) pv.id AS variant_id, pvi.inventory_item_id, pv.sku, p.title
         FROM product p
         JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
         JOIN product_variant_inventory_item pvi ON pvi.variant_id = pv.id AND pvi.deleted_at IS NULL
        WHERE ${vendorListIdSql("p")} = $1 AND p.deleted_at IS NULL AND pv.sku IS NOT NULL
        ORDER BY p.id, pv.id
        LIMIT 3`,
      [SKY_LIST_ID]
    )
  ).rows as Fixture[];
  const other = (
    await db.query(
      `SELECT DISTINCT ON (p.id) pv.id AS variant_id, pvi.inventory_item_id, pv.sku, p.title
         FROM product p
         JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
         JOIN product_variant_inventory_item pvi ON pvi.variant_id = pv.id AND pvi.deleted_at IS NULL
        WHERE ${vendorListIdSql("p")} IS NOT NULL
          AND ${vendorListIdSql("p")} <> $1
          AND p.deleted_at IS NULL AND pv.sku IS NOT NULL
        ORDER BY p.id, pv.id
        LIMIT 1`,
      [SKY_LIST_ID]
    )
  ).rows as Fixture[];
  const vendorRow = (
    await db.query(
      `SELECT id FROM qb_vendor
        WHERE deleted_at IS NULL AND qb_list_id IS NOT NULL AND qb_list_id <> $1
        ORDER BY id LIMIT 1`,
      [SKY_LIST_ID]
    )
  ).rows[0] as { id: string } | undefined;

  const locRow = (
    await db.query(`SELECT id FROM stock_location WHERE deleted_at IS NULL ORDER BY id LIMIT 1`)
  ).rows[0] as { id: string } | undefined;

  if (sky.length < 3 || other.length < 1 || !vendorRow || !locRow) {
    throw new Error(
      `fixtures unavailable: sky=${sky.length} other=${other.length} vendor=${!!vendorRow}`
    );
  }
  const [sky1, sky2, sky3] = sky as [Fixture, Fixture, Fixture];
  const oth = other[0] as Fixture;
  const allItemIds = [sky1, sky2, sky3, oth].map((f) => f.inventory_item_id);

  console.log("Step 1 — create mixed PO");
  const poCreate = await api(token, "POST", "/admin/purchase-orders", {
    vendor_id: vendorRow.id,
    stock_location_id: (locRow as { id: string }).id,
    lines: [line(sky1, 5, 1000, 0), line(sky2, 3, 2000, 1), line(oth, 2, 1500, 2)],
  });
  const po = poCreate.body.purchase_order as { id: string; number: string | null } | undefined;
  check("1.1 PO created", poCreate.status === 201 && !!po?.id, JSON.stringify(poCreate.body).slice(0, 200));
  if (!po?.id) throw new Error("cannot continue without PO");
  const MIRROR = `/admin/purchase-orders/${po.id}/factory-order-mirror`;

  const invBefore = await invSnapshot(db, allItemIds);

  console.log("Step 2 — GET mirror state (no FO yet)");
  const g1 = await api(token, "GET", `${MIRROR}?manufacturer=Skydance`);
  check("2.1 GET 200", g1.status === 200);
  check("2.2 action=create", g1.body.action === "create", String(g1.body.action));
  check("2.3 unique_item_count=2", g1.body.unique_item_count === 2, String(g1.body.unique_item_count));
  check("2.4 line_count=2", g1.body.line_count === 2, String(g1.body.line_count));

  console.log("Step 3 — POST creates linked FO with only Skydance lines");
  const noPin = await api(token, "POST", MIRROR, { manufacturer: "Skydance" });
  check("3.0 POST without supervisor PIN → 403", noPin.status === 403, `${noPin.status}`);
  const foCountAfterNoPin = (
    await db.query(`SELECT count(*)::int AS n FROM factory_order WHERE linked_purchase_order_id = $1`, [po.id])
  ).rows[0] as { n: number };
  check("3.0b the 403 created nothing", foCountAfterNoPin.n === 0);

  const p1 = await api(token, "POST", MIRROR, { manufacturer: "Skydance" }, PIN_HEADER);
  const fo = p1.body.factory_order as { id: string; number: string | null } | undefined;
  check("3.1 POST 201 created", p1.status === 201 && p1.body.action === "created", JSON.stringify(p1.body).slice(0, 200));
  if (!fo?.id) throw new Error("cannot continue without FO");

  const foRow = (
    await db.query(
      `SELECT linked_purchase_order_id, status, metadata, vendor_id, total_units_ordered, subtotal_cents
         FROM factory_order WHERE id = $1`,
      [fo.id]
    )
  ).rows[0] as {
    linked_purchase_order_id: string;
    status: string;
    metadata: Record<string, unknown> | null;
    vendor_id: string;
    total_units_ordered: number | string;
    subtotal_cents: number | string;
  };
  check("3.2 FO.linked_purchase_order_id = PO", foRow.linked_purchase_order_id === po.id);
  check("3.3 FO draft", foRow.status === "draft", foRow.status);
  check(
    "3.4 manufacturer metadata",
    foRow.metadata?.manufacturer_vendor_qb_list_id === SKY_LIST_ID &&
      foRow.metadata?.manufacturer_vendor_short_name === "SKYDANCE",
    JSON.stringify(foRow.metadata)
  );
  check("3.5 FO vendor = PO vendor", foRow.vendor_id === vendorRow.id);
  check("3.6 FO units = 8 (5+3)", Number(foRow.total_units_ordered) === 8, String(foRow.total_units_ordered));
  check("3.7 FO subtotal = 5*1000+3*2000", Number(foRow.subtotal_cents) === 11000, String(foRow.subtotal_cents));

  const foLines1 = (
    await db.query(
      `SELECT purchase_order_line_id, product_variant_id, qty_ordered
         FROM factory_order_line WHERE factory_order_id = $1 AND deleted_at IS NULL`,
      [fo.id]
    )
  ).rows as Array<{ purchase_order_line_id: string | null; product_variant_id: string; qty_ordered: number }>;
  check("3.8 FO has exactly 2 lines", foLines1.length === 2, String(foLines1.length));
  check("3.9 every FO line carries purchase_order_line_id", foLines1.every((l) => !!l.purchase_order_line_id));
  check(
    "3.10 non-Skydance variant excluded",
    foLines1.every((l) => l.product_variant_id !== oth.variant_id)
  );

  console.log("Step 4 — qty edit on PO → drift → sync");
  const poGet = await api(token, "GET", `/admin/purchase-orders/${po.id}`);
  const poLines = (poGet.body.purchase_order as { lines: Array<Record<string, unknown>> }).lines;
  const patchLines = poLines.map((l) => ({
    id: l.id,
    product_variant_id: l.product_variant_id,
    inventory_item_id: l.inventory_item_id,
    sku_snapshot: l.sku_snapshot,
    description_snapshot: l.description_snapshot,
    qty_ordered: l.product_variant_id === sky1.variant_id ? 9 : (l.qty_ordered as number),
    unit_cost_cents: l.unit_cost_cents,
    line_order: l.line_order ?? 0,
  }));
  const patch1 = await api(token, "PATCH", `/admin/purchase-orders/${po.id}`, { lines: patchLines });
  check("4.1 PO qty patched", patch1.status === 200, JSON.stringify(patch1.body).slice(0, 200));

  const g2 = await api(token, "GET", `${MIRROR}?manufacturer=Skydance`);
  const g2diff = g2.body.diff as { qty_changed: unknown[] } | null;
  check("4.2 in_sync=false", g2.body.in_sync === false);
  check("4.3 action=sync", g2.body.action === "sync", String(g2.body.action));
  check("4.4 one qty_changed", (g2diff?.qty_changed?.length ?? 0) === 1);

  const p2 = await api(token, "POST", MIRROR, { manufacturer: "Skydance" }, PIN_HEADER);
  const p2changes = p2.body.changes as { updated: number; added: number; removed: number } | undefined;
  check("4.5 POST synced", p2.status === 200 && p2.body.action === "synced");
  check("4.6 changes 1/0/0", p2changes?.updated === 1 && p2changes?.added === 0 && p2changes?.removed === 0, JSON.stringify(p2changes));
  const foQty = (
    await db.query(
      `SELECT qty_ordered, total_cents FROM factory_order_line
        WHERE factory_order_id = $1 AND product_variant_id = $2 AND deleted_at IS NULL`,
      [fo.id, sky1.variant_id]
    )
  ).rows[0] as { qty_ordered: number | string; total_cents: number | string };
  check("4.7 FO line qty now 9", Number(foQty.qty_ordered) === 9, String(foQty.qty_ordered));
  const foTot = (
    await db.query(`SELECT subtotal_cents, total_units_ordered FROM factory_order WHERE id = $1`, [fo.id])
  ).rows[0] as { subtotal_cents: number | string; total_units_ordered: number | string };
  check("4.8 FO subtotal 9*1000+3*2000", Number(foTot.subtotal_cents) === 15000, String(foTot.subtotal_cents));
  check("4.9 FO units 12", Number(foTot.total_units_ordered) === 12, String(foTot.total_units_ordered));

  console.log("Step 5 — add sky3 + remove sky2 on PO → sync reflects both");
  const poGet2 = await api(token, "GET", `/admin/purchase-orders/${po.id}`);
  const poLines2 = (poGet2.body.purchase_order as { lines: Array<Record<string, unknown>> }).lines;
  const kept = poLines2
    .filter((l) => l.product_variant_id !== sky2.variant_id)
    .map((l) => ({
      id: l.id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku_snapshot: l.sku_snapshot,
      description_snapshot: l.description_snapshot,
      qty_ordered: l.qty_ordered,
      unit_cost_cents: l.unit_cost_cents,
      line_order: l.line_order ?? 0,
    }));
  const patch2 = await api(token, "PATCH", `/admin/purchase-orders/${po.id}`, {
    lines: [...kept, line(sky3, 4, 3000, 9)],
  });
  check("5.1 PO lines patched", patch2.status === 200, JSON.stringify(patch2.body).slice(0, 200));

  const p3 = await api(token, "POST", MIRROR, { manufacturer: "Skydance" }, PIN_HEADER);
  const p3changes = p3.body.changes as { updated: number; added: number; removed: number } | undefined;
  check("5.2 POST synced", p3.status === 200 && p3.body.action === "synced");
  check("5.3 added=1 removed=1", p3changes?.added === 1 && p3changes?.removed === 1, JSON.stringify(p3changes));
  const foVariants = (
    await db.query(
      `SELECT product_variant_id FROM factory_order_line
        WHERE factory_order_id = $1 AND deleted_at IS NULL ORDER BY line_order`,
      [fo.id]
    )
  ).rows.map((r) => (r as { product_variant_id: string }).product_variant_id);
  check(
    "5.4 FO now mirrors sky1+sky3",
    foVariants.length === 2 && foVariants.includes(sky1.variant_id) && foVariants.includes(sky3.variant_id),
    JSON.stringify(foVariants)
  );

  console.log("Step 7a — creating/syncing the mirror never moved inventory");
  const invAfterSync = await invSnapshot(db, allItemIds);
  check("7.1 inventory_level untouched by steps 3-5", invBefore === invAfterSync);

  console.log("Step 6 — submit + receive the FO, then mirror is receipt-blocked");
  const submit = await api(token, "POST", `/admin/factory-orders/${fo.id}/submit`, {});
  check("6.1 FO submitted", submit.status === 200, JSON.stringify(submit.body).slice(0, 200));
  const foLineForReceive = (
    await db.query(
      `SELECT id FROM factory_order_line
        WHERE factory_order_id = $1 AND product_variant_id = $2 AND deleted_at IS NULL`,
      [fo.id, sky1.variant_id]
    )
  ).rows[0] as { id: string };
  const receive = await api(token, "POST", `/admin/factory-orders/${fo.id}/receive`, {
    lines: [{ fo_line_id: foLineForReceive.id, qty_received_now: 1 }],
  });
  check("6.2 FO receive applied", receive.status === 200, JSON.stringify(receive.body).slice(0, 200));

  const poGet3 = await api(token, "GET", `/admin/purchase-orders/${po.id}`);
  const poLines3 = (poGet3.body.purchase_order as { lines: Array<Record<string, unknown>> }).lines;
  const patch3 = await api(token, "PATCH", `/admin/purchase-orders/${po.id}`, {
    lines: poLines3.map((l) => ({
      id: l.id,
      product_variant_id: l.product_variant_id,
      inventory_item_id: l.inventory_item_id,
      sku_snapshot: l.sku_snapshot,
      description_snapshot: l.description_snapshot,
      qty_ordered: l.product_variant_id === sky3.variant_id ? 6 : (l.qty_ordered as number),
      unit_cost_cents: l.unit_cost_cents,
      line_order: l.line_order ?? 0,
    })),
  });
  check("6.3 PO edited after receive", patch3.status === 200);

  const g3 = await api(token, "GET", `${MIRROR}?manufacturer=Skydance`);
  check("6.4 action=fix_receive", g3.body.action === "fix_receive", String(g3.body.action));

  const foLinesBefore409 = await foLinesSnapshot(db, fo.id);
  const p4 = await api(token, "POST", MIRROR, { manufacturer: "Skydance" }, PIN_HEADER);
  check("6.5 POST → 409 fo_receipt_blocks_sync", p4.status === 409 && p4.body.code === "fo_receipt_blocks_sync", `${p4.status} ${String(p4.body.code)}`);
  const foLinesAfter409 = await foLinesSnapshot(db, fo.id);
  check("6.6 FO lines untouched by the 409", foLinesBefore409 === foLinesAfter409);

  console.log("Step 7b — positive control: the receive DID move inventory");
  const invAfterReceive = await invSnapshot(db, allItemIds);
  check(
    "7.2 receive changed inventory_level (proves 7.1 wasn't vacuous)",
    invAfterReceive !== invAfterSync
  );

  console.log("Step 8 — unknown manufacturer");
  const g4 = await api(token, "GET", `${MIRROR}?manufacturer=zzz-nope`);
  check("8.1 422 manufacturer_not_found", g4.status === 422 && g4.body.code === "manufacturer_not_found", `${g4.status} ${String(g4.body.code)}`);

  console.log("Invariants — scoped to the new FO");
  const orphan = await db.query(
    `SELECT count(*)::int AS n
       FROM factory_order_line fol
       JOIN factory_order fo2 ON fo2.id = fol.factory_order_id
      WHERE fol.factory_order_id = $1 AND fol.purchase_order_line_id IS NOT NULL
        AND fol.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM purchase_order_line pol
           WHERE pol.id = fol.purchase_order_line_id AND pol.purchase_order_id = fo2.linked_purchase_order_id
        )`,
    [fo.id]
  );
  check("I.1 no orphan mirror lines", (orphan.rows[0] as { n: number }).n === 0);

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
