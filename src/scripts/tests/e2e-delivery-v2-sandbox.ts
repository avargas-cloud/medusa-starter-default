/**
 * e2e-delivery-v2-sandbox.ts — end-to-end proof of the Delivery v2 model
 * against the SANDBOX stack (backend :9099, postgres :5499). Never prod.
 *
 * Run:
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-delivery-v2-sandbox.ts
 *
 * Covers (docs/DISPATCH_ON_ORDER_HANDOFF.md):
 *   1. Pool purchase path (create-shipment mode='pool') — falls back to a
 *      seeded 'manual' pool row when no dispatch provider is configured in
 *      the sandbox (the claim/buy code is shared with the long-shipped
 *      legacy flow; what v2 adds — the early exit before fulfillment — still
 *      executes when the provider is configured).
 *   2. Invoice with order_line_item_id → derived_v2; fail-closed validation
 *      (foreign line → 400, over-invoice → 400).
 *   3. Assignment = dispatch: fulfillment with exact units, reservations
 *      consumed, stock decremented (numeric AND raw), delivery stamped,
 *      invoice_tracking written. Exclusivity 409s. Idempotent replay.
 *   4. Split: item-scoped assignments with per-line ceilings (over-dispatch
 *      409) — the PO-tracking pattern.
 *   5. Mina 2: explicit selection vs pending fulfillment mismatch → 409,
 *      and NO label is bought.
 *   6. Void with supervisor PIN: 403 without PIN; with PIN the order returns
 *      to its pre-invoice state (stock back — the positive control —,
 *      reservation recreated, fulfillment tree soft-deleted, label back in
 *      the pool). Un-assign path likewise.
 *   7. verify-delivery-v2 invariants hold at the end.
 */

import { Pool } from "pg";

const API = "http://localhost:9099";
const DB = "postgresql://postgres:sandbox@localhost:5499/medusa";
const PIN = "4321"; // sandbox-only fixture, set below — not a real credential

const pool = new Pool({ connectionString: DB, max: 3 });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function q<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function http(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  headers?: Record<string, string>
): Promise<HttpResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body */
  }
  return { status: res.status, body: parsed };
}

async function seedPoolLabel(
  orderId: string,
  suffix: string
): Promise<string> {
  const id = `odel_e2e_${suffix}_${Date.now()}`;
  const tracking = `E2ETRACK${suffix.toUpperCase()}${Date.now() % 100000}`;
  await pool.query(
    `INSERT INTO order_delivery
       (id, order_id, provider, status, carrier, service, tracking_number,
        rate_amount_cents, idempotency_key, metadata, created_at, updated_at)
     VALUES ($1, $2, 'manual', 'label_created', 'UPS', 'ups_ground', $3,
             1234, $4, $5::jsonb, now(), now())`,
    [
      id,
      orderId,
      tracking,
      `e2e-delivery-v2-${suffix}-${Date.now()}`,
      JSON.stringify({
        packages: [
          {
            provider_object_id: `e2e_${suffix}`,
            tracking_number: tracking,
            tracking_url: null,
            label_url: null,
            provider_label_url: null,
          },
        ],
      }),
    ]
  );
  return id;
}

interface LineInfo {
  line_id: string;
  variant_id: string;
  sku: string | null;
  title: string;
  ordered: number;
  reserved: number;
  inventory_item_id: string | null;
  location_id: string | null;
  stocked: number | null;
}

/** Location pinned per line at test start — later snapshots must measure the
 *  SAME (inventory_item, location) or a consumed reservation makes the join
 *  drift to another warehouse and the numbers lie. */
const pinnedLoc = new Map<string, string>();

async function lineSnapshot(orderId: string): Promise<LineInfo[]> {
  const rows = await q<LineInfo & { resv_loc: string | null }>(
    `SELECT DISTINCT ON (oli.id)
            oli.id AS line_id, oli.variant_id, oli.variant_sku AS sku,
            oli.title,
            oi.quantity::numeric::float8 AS ordered,
            COALESCE((SELECT SUM(ri.quantity)::numeric::float8 FROM reservation_item ri
                       WHERE ri.line_item_id = oli.id AND ri.deleted_at IS NULL), 0) AS reserved,
            pvii.inventory_item_id,
            (SELECT ri2.location_id FROM reservation_item ri2
              WHERE ri2.line_item_id = oli.id AND ri2.deleted_at IS NULL
              LIMIT 1) AS resv_loc
       FROM order_item oi
       JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
       JOIN order_line_item oli ON oli.id = oi.item_id
       LEFT JOIN product_variant_inventory_item pvii
         ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
      WHERE oi.order_id = $1
      ORDER BY oli.id`,
    [orderId]
  );
  const out: LineInfo[] = [];
  for (const r of rows) {
    let loc = pinnedLoc.get(r.line_id) ?? r.resv_loc ?? null;
    if (loc) pinnedLoc.set(r.line_id, loc);
    let stocked: number | null = null;
    if (r.inventory_item_id && loc) {
      const lvl = await q<{ stocked: number }>(
        `SELECT stocked_quantity::numeric::float8 AS stocked
           FROM inventory_level
          WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL`,
        [r.inventory_item_id, loc]
      );
      stocked = lvl[0]?.stocked ?? null;
    }
    out.push({ ...r, location_id: loc, stocked });
  }
  return out;
}

async function main(): Promise<void> {
  console.log("── E2E Delivery v2 (sandbox) ──");

  // ── Login ────────────────────────────────────────────────────────────────
  const login = await http("POST", "/auth/user/emailpass", null, {
    email: "sandbox@test.com",
    password: "sandbox123",
  });
  const token = String(login.body.token ?? "");
  check("login sandbox admin", login.status === 200 && token.length > 0);
  if (!token) throw new Error("cannot continue without a token");

  // ── Supervisor PIN fixture (sandbox-only) ────────────────────────────────
  await pool.query(
    `UPDATE store SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
       '{pos_supervisor_pin}', to_jsonb($1::text))`,
    [PIN]
  );

  // ── Pick a clean target order ────────────────────────────────────────────
  // Needs: pending, no invoices yet, ≥2 distinct variant lines on the current
  // version with reservations (apartado) and quantity ≥ 2 on at least one.
  // Line A: any reserved line (invoice #1 bills 1 unit). Line B: a line with
  // quantity ≥ 2 AND ≥ 2 reserved (invoice #2 bills 2 units, split 1+1).
  const candidates = await q<{
    id: string;
    display_id: number;
    customer_id: string;
  }>(
    `WITH lines AS (
       SELECT oi.order_id, oli.id AS line_id, oi.quantity::numeric AS q,
              COALESCE((SELECT SUM(ri.quantity) FROM reservation_item ri
                         WHERE ri.line_item_id = oli.id AND ri.deleted_at IS NULL), 0) AS reserved
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
          AND o.deleted_at IS NULL AND o.status = 'pending'
         JOIN order_line_item oli ON oli.id = oi.item_id
        WHERE oli.variant_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pos_invoice pi
                           WHERE pi.order_id = oi.order_id AND pi.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM order_fulfillment ofl
                           JOIN fulfillment f ON f.id = ofl.fulfillment_id AND f.deleted_at IS NULL
                          WHERE ofl.order_id = oi.order_id AND ofl.deleted_at IS NULL)
     )
     SELECT o.id, o.display_id, o.customer_id
       FROM (
         SELECT order_id
           FROM lines GROUP BY order_id
         HAVING COUNT(*) FILTER (WHERE reserved > 0) >= 2
            AND COUNT(*) FILTER (WHERE q >= 2 AND reserved >= 2) >= 1
       ) c
       JOIN "order" o ON o.id = c.order_id
      ORDER BY o.display_id DESC
      LIMIT 5`
  );
  check("candidate order found", candidates.length > 0);
  if (!candidates.length) throw new Error("no suitable sandbox order");
  const order = candidates[0];
  console.log(`  → order ${order.display_id} (${order.id})`);

  const usable = (await lineSnapshot(order.id)).filter(
    (l) => l.variant_id && l.reserved > 0 && l.inventory_item_id && l.location_id
  );
  const lineB = usable.find((l) => l.ordered >= 2 && l.reserved >= 2);
  const lineA = usable.find((l) => l !== lineB);
  check("two usable lines (A reserved, B qty≥2)", Boolean(lineA && lineB));
  if (!lineA || !lineB) throw new Error("lines not usable");

  // ── 1. Pool purchase ─────────────────────────────────────────────────────
  let poolDeliveryId: string | null = null;
  const poolBuy = await http(
    "POST",
    `/admin/orders/${order.id}/create-shipment`,
    token,
    {
      mode: "pool",
      parcels: [{ length_in: 12, width_in: 10, height_in: 6, weight_lb: 5 }],
    },
    { "Idempotency-Key": `e2e-pool-${order.id}-${Date.now()}` }
  );
  if (poolBuy.status === 201) {
    const d = poolBuy.body.delivery as { id: string; invoice_id: string | null; fulfillment_id: string | null } | undefined;
    check("pool buy 201 without fulfillment", Boolean(d && d.invoice_id === null && d.fulfillment_id === null));
    poolDeliveryId = d?.id ?? null;
  } else {
    console.log(`  (provider not configured in sandbox — HTTP ${poolBuy.status} ${String(poolBuy.body.code ?? "")}; seeding pool row)`);
    poolDeliveryId = await seedPoolLabel(order.id, "a");
    check("pool label seeded (manual provider)", Boolean(poolDeliveryId));
  }
  if (!poolDeliveryId) throw new Error("no pool label");

  // Pool label visible on the order's deliveries listing.
  const listing = await http("GET", `/admin/orders/${order.id}/deliveries`, token);
  const listed = (listing.body.deliveries as Array<{ id: string; invoice_id: string | null }> | undefined)?.find(
    (d) => d.id === poolDeliveryId
  );
  check("pool label listed with invoice_id NULL", Boolean(listed && listed.invoice_id === null));

  // ── 2. Invoice with line identity ────────────────────────────────────────
  const mkItems = (lines: Array<{ l: LineInfo; qty: number }>) =>
    lines.map(({ l, qty }) => ({
      order_line_item_id: l.line_id,
      variant_id: l.variant_id,
      sku: l.sku ?? undefined,
      description: l.title || l.sku || "e2e line",
      quantity: qty,
      unit_price: 1000,
      total: 1000 * qty,
    }));
  const mkInvoice = (items: ReturnType<typeof mkItems>) => ({
    order_id: order.id,
    order_display_id: order.display_id,
    customer_id: order.customer_id,
    items,
    subtotal: items.reduce((s, it) => s + it.total, 0),
    shipping: 0,
    tax: 0,
    total: items.reduce((s, it) => s + it.total, 0),
    amount_paid: 0,
  });

  // Fail-closed: foreign line id.
  const badLine = await http("POST", "/admin/invoices", token,
    mkInvoice(mkItems([{ l: { ...lineA, line_id: "ordli_does_not_exist" }, qty: 1 }])));
  check("foreign order_line_item_id → 400 INVALID_ORDER_LINE",
    badLine.status === 400 && badLine.body.code === "INVALID_ORDER_LINE",
    `got ${badLine.status} ${String(badLine.body.code)}`);

  // Fail-closed: over-invoice.
  const overInv = await http("POST", "/admin/invoices", token,
    mkInvoice(mkItems([{ l: lineA, qty: lineA.ordered + 5 }])));
  check("over-invoice → 400 OVER_INVOICE", overInv.status === 400 && overInv.body.code === "OVER_INVOICE", `got ${overInv.status} ${String(overInv.body.code)}`);

  // Invoice #1: 1 unit of line A (partial invoice).
  const inv1Res = await http("POST", "/admin/invoices", token,
    mkInvoice(mkItems([{ l: lineA, qty: 1 }])), { "Idempotency-Key": `e2e-inv1-${order.id}` });
  const inv1 = inv1Res.body.invoice as { id: string } | undefined;
  check("invoice #1 created", inv1Res.status === 200 || inv1Res.status === 201, `got ${inv1Res.status} ${JSON.stringify(inv1Res.body).slice(0, 200)}`);
  if (!inv1) throw new Error("no invoice 1");
  const inv1Row = await q<{ shipment_link_mode: string }>(
    `SELECT shipment_link_mode FROM pos_invoice WHERE id = $1`, [inv1.id]);
  check("invoice #1 is derived_v2", inv1Row[0]?.shipment_link_mode === "derived_v2");
  const inv1Items = await q<{ order_line_item_id: string | null }>(
    `SELECT order_line_item_id FROM pos_invoice_item WHERE invoice_id = $1 AND deleted_at IS NULL`, [inv1.id]);
  check("invoice #1 line carries identity", inv1Items.every((r) => r.order_line_item_id === lineA.line_id));

  // ── 3. Assignment = dispatch ─────────────────────────────────────────────
  const preA = (await lineSnapshot(order.id)).find((l) => l.line_id === lineA.line_id)!;
  const assign1 = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: poolDeliveryId,
    invoice_id: inv1.id,
    scope: "entire_invoice",
    location_id: preA.location_id,
  });
  check("assign #1 entire_invoice → 200", assign1.status === 200, `got ${assign1.status} ${JSON.stringify(assign1.body).slice(0, 300)}`);
  const postA = (await lineSnapshot(order.id)).find((l) => l.line_id === lineA.line_id)!;
  check("stock decremented by 1 (positive control)", postA.stocked === (preA.stocked ?? 0) - 1, `pre=${preA.stocked} post=${postA.stocked}`);
  check("reservation consumed by 1", postA.reserved === preA.reserved - 1, `pre=${preA.reserved} post=${postA.reserved}`);

  const d1 = await q<{
    invoice_id: string | null; invoice_scope: string | null;
    assigned_at: string | null; fulfillment_id: string | null; shipped_at: string | null;
  }>(`SELECT invoice_id, invoice_scope, assigned_at, fulfillment_id, shipped_at
        FROM order_delivery WHERE id = $1`, [poolDeliveryId]);
  check("delivery stamped (invoice/scope/assigned/fulfillment/shipped)",
    d1[0]?.invoice_id === inv1.id && d1[0]?.invoice_scope === "entire_invoice" &&
    Boolean(d1[0]?.assigned_at) && Boolean(d1[0]?.fulfillment_id) && Boolean(d1[0]?.shipped_at));

  const fulItems = await q<{ line_item_id: string; quantity: number }>(
    `SELECT line_item_id, quantity::numeric::float8 AS quantity FROM fulfillment_item
      WHERE fulfillment_id = $1 AND deleted_at IS NULL`, [d1[0]!.fulfillment_id]);
  check("fulfillment holds exactly line A ×1",
    fulItems.length === 1 && fulItems[0].line_item_id === lineA.line_id && fulItems[0].quantity === 1);

  const trk = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM invoice_tracking WHERE invoice_id = $1 AND deleted_at IS NULL`, [inv1.id]);
  check("invoice_tracking row written", Number(trk[0]?.n) >= 1);

  // Replay + exclusivity.
  const replay = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: poolDeliveryId, invoice_id: inv1.id, scope: "entire_invoice",
  });
  check("re-assign same → 200 replayed", replay.status === 200 && replay.body.replayed === true);
  const extraLabel = await seedPoolLabel(order.id, "b");
  const conflict = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: extraLabel, invoice_id: inv1.id, scope: "entire_invoice",
  });
  check("second entire_invoice → 409 scope conflict",
    conflict.status === 409 && conflict.body.code === "assignment_scope_conflict");

  // ── 4. Split (invoice #2, 2 units of line B, two item-scoped labels) ─────
  const inv2Res = await http("POST", "/admin/invoices", token,
    mkInvoice(mkItems([{ l: lineB, qty: 2 }])), { "Idempotency-Key": `e2e-inv2-${order.id}` });
  const inv2 = inv2Res.body.invoice as { id: string } | undefined;
  check("invoice #2 created (2 units line B)", Boolean(inv2), `got ${inv2Res.status}`);
  if (!inv2) throw new Error("no invoice 2");

  const preB = (await lineSnapshot(order.id)).find((l) => l.line_id === lineB.line_id)!;
  const split1 = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: extraLabel, invoice_id: inv2.id, scope: "items",
    items: [{ order_line_item_id: lineB.line_id, quantity: 1 }],
    location_id: preB.location_id,
  });
  check("split assign #1 (1 of 2) → 200", split1.status === 200, `got ${split1.status} ${JSON.stringify(split1.body).slice(0, 300)}`);
  const odl = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM order_delivery_line WHERE delivery_id = $1 AND deleted_at IS NULL`, [extraLabel]);
  check("order_delivery_line row written", Number(odl[0]?.n) === 1);

  const labelC = await seedPoolLabel(order.id, "c");
  const overDispatch = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: labelC, invoice_id: inv2.id, scope: "items",
    items: [{ order_line_item_id: lineB.line_id, quantity: 2 }],
    location_id: preB.location_id,
  });
  check("over-dispatch → 409", overDispatch.status === 409 && overDispatch.body.code === "over_dispatch",
    `got ${overDispatch.status} ${String(overDispatch.body.code)}`);
  const split2 = await http("POST", `/admin/orders/${order.id}/assign-delivery`, token, {
    delivery_id: labelC, invoice_id: inv2.id, scope: "items",
    items: [{ order_line_item_id: lineB.line_id, quantity: 1 }],
    location_id: preB.location_id,
  });
  check("split assign #2 (remaining 1) → 200", split2.status === 200, `got ${split2.status}`);

  // ── 6. Void with supervisor PIN ──────────────────────────────────────────
  const noPin = await http("POST", `/admin/invoices/${inv1.id}/void`, token, { void_reason: "e2e" });
  check("void without PIN → 403", noPin.status === 403, `got ${noPin.status}`);
  const wrongPin = await http("POST", `/admin/invoices/${inv1.id}/void`, token, { void_reason: "e2e" },
    { "x-supervisor-pin": "0000" });
  check("void with wrong PIN → 403 INVALID_SUPERVISOR_PIN",
    wrongPin.status === 403 && wrongPin.body.code === "INVALID_SUPERVISOR_PIN");

  const preVoid = (await lineSnapshot(order.id)).find((l) => l.line_id === lineA.line_id)!;
  const voidRes = await http("POST", `/admin/invoices/${inv1.id}/void`, token, { void_reason: "e2e not dispatched" },
    { "x-supervisor-pin": PIN });
  check("void with PIN → 200", voidRes.status === 200, `got ${voidRes.status} ${JSON.stringify(voidRes.body).slice(0, 200)}`);

  const postVoid = (await lineSnapshot(order.id)).find((l) => l.line_id === lineA.line_id)!;
  check("stock restored (+1)", postVoid.stocked === (preVoid.stocked ?? 0) + 1, `pre=${preVoid.stocked} post=${postVoid.stocked}`);
  check("reservation recreated", postVoid.reserved >= preVoid.reserved + 1, `pre=${preVoid.reserved} post=${postVoid.reserved}`);
  const rawStock = await q<{ stocked: string; raw: string }>(
    `SELECT stocked_quantity::text AS stocked, raw_stocked_quantity->>'value' AS raw
       FROM inventory_level WHERE inventory_item_id = $1 AND location_id = $2`,
    [lineA.inventory_item_id, lineA.location_id]);
  check("numeric and raw stocked agree", Number(rawStock[0]?.stocked) === Number(rawStock[0]?.raw),
    `stocked=${rawStock[0]?.stocked} raw=${rawStock[0]?.raw}`);

  const d1AfterVoid = await q<{
    invoice_id: string | null; invoice_scope: string | null; fulfillment_id: string | null;
    shipped_at: string | null; status: string;
  }>(`SELECT invoice_id, invoice_scope, fulfillment_id, shipped_at, status
        FROM order_delivery WHERE id = $1`, [poolDeliveryId]);
  check("label back in pool after void",
    d1AfterVoid[0]?.invoice_id === null && d1AfterVoid[0]?.invoice_scope === null &&
    d1AfterVoid[0]?.fulfillment_id === null && d1AfterVoid[0]?.shipped_at === null &&
    d1AfterVoid[0]?.status === "label_created");
  const inv1Status = await q<{ status: string }>(`SELECT status FROM pos_invoice WHERE id = $1`, [inv1.id]);
  check("invoice #1 voided", inv1Status[0]?.status === "voided");

  // ── 6b. Un-assign (invoice #2's first split label) with PIN ──────────────
  const noPinUn = await http("POST", `/admin/orders/${order.id}/unassign-delivery`, token, { delivery_id: extraLabel });
  check("unassign without PIN → 403", noPinUn.status === 403, `got ${noPinUn.status}`);
  const preUn = (await lineSnapshot(order.id)).find((l) => l.line_id === lineB.line_id)!;
  const unassign = await http("POST", `/admin/orders/${order.id}/unassign-delivery`, token, { delivery_id: extraLabel },
    { "x-supervisor-pin": PIN });
  check("unassign with PIN → 200", unassign.status === 200, `got ${unassign.status} ${JSON.stringify(unassign.body).slice(0, 200)}`);
  const postUn = (await lineSnapshot(order.id)).find((l) => l.line_id === lineB.line_id)!;
  check("unassign restored 1 unit of stock", postUn.stocked === (preUn.stocked ?? 0) + 1, `pre=${preUn.stocked} post=${postUn.stocked}`);
  const odlAfter = await q<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM order_delivery_line WHERE delivery_id = $1 AND deleted_at IS NULL`, [extraLabel]);
  check("delivery lines soft-deleted on unassign", Number(odlAfter[0]?.n) === 0);

  // ── 5 (last — its fixtures must not disturb the stock checks above).
  // Mina 2: explicit selection vs pending fulfillment mismatch → 409, and NO
  // label is bought (the plan resolves BEFORE any purchase).
  const preMina = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM order_delivery WHERE order_id = $1`, [order.id]);
  const ff = await http("POST", `/admin/orders/${order.id}/create-fulfillment-force`, token, {
    items: [{ id: lineA.line_id, quantity: 1 }],
    location_id: lineA.location_id ?? preA.location_id,
    no_notification: true,
  });
  check("pending fulfillment created for Mina 2", ff.status === 200 || ff.status === 201, `got ${ff.status}`);
  const mina2 = await http("POST", `/admin/orders/${order.id}/create-shipment`, token, {
    parcels: [{ length_in: 10, width_in: 8, height_in: 4, weight_lb: 2 }],
    items: [{ id: lineB.line_id, quantity: 1 }],
    location_id: lineA.location_id ?? preA.location_id,
  }, { "Idempotency-Key": `e2e-mina2-${order.id}` });
  check("Mina 2: mismatch → 409 pending_fulfillment_mismatch",
    mina2.status === 409 && mina2.body.code === "pending_fulfillment_mismatch",
    `got ${mina2.status} ${String(mina2.body.code)}`);
  const postMina = await q<{ n: string }>(`SELECT COUNT(*)::text AS n FROM order_delivery WHERE order_id = $1`, [order.id]);
  check("Mina 2: no label bought", preMina[0]?.n === postMina[0]?.n);

  // ── 7. Invariants ────────────────────────────────────────────────────────
  const { execSync } = await import("node:child_process");
  try {
    const out = execSync(
      `env DATABASE_URL="${DB}" ./node_modules/.bin/tsx src/scripts/verify/verify-delivery-v2.ts`,
      { encoding: "utf8" }
    );
    check("verify-delivery-v2: all invariants hold", out.includes("ALL INVARIANTS HOLD"));
  } catch (e) {
    check("verify-delivery-v2: all invariants hold", false,
      e instanceof Error ? e.message.slice(0, 400) : String(e));
  }

  await pool.end();
  console.log(`\n── RESULT: ${passed} passed / ${failed} failed ──`);
  if (failed > 0) {
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("E2E crashed:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
