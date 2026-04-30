/**
 * verify-transfer-e2e.ts — E2E validation for the Transfer-to-USA workflow
 * (TEST_HOME.md, 9 cases) against an isolated Medusa instance.
 *
 * Mandatory env:
 *   TEST_API_URL          e.g. http://localhost:9099
 *   TEST_DATABASE_URL     e.g. postgresql://postgres:sandbox@localhost:5499/medusa
 *
 * Auth — provide ONE of:
 *   TEST_ADMIN_PASSWORD   (combined with TEST_ADMIN_EMAIL) — emailpass login
 *   TEST_JWT_SECRET       — script signs a Bearer JWT directly for the admin
 *                            user identified by TEST_ADMIN_EMAIL. Convenient for
 *                            sandbox use where prod password hashes might not be
 *                            usable.
 *
 * Optional env:
 *   TEST_ADMIN_EMAIL      default: a.vargas@ecopowertech.com
 *   TEST_SKU              default: EPS-SPR-5DDC
 *   TEST_QTY              default: 5  (qty per IT line — must be small enough
 *                                       to leave headroom in China stock)
 *   TEST_MEILI_URL        default: http://localhost:7799
 *   TEST_MEILI_KEY        default: sandbox_master_key
 *   TEST_SKIP_MEILI       set to "1" to skip Meili sync assertions
 *
 * Run:
 *   cd backend && npx ts-node src/scripts/verify/verify-transfer-e2e.ts
 */

import { Client as PgClient } from "pg";
import jwt from "jsonwebtoken";

// ── Constants from TEST_HOME.md ───────────────────────────────────────────────

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const USA_LOC = "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

// ── Config ────────────────────────────────────────────────────────────────────

const cfg = {
  apiUrl: process.env.TEST_API_URL ?? "http://localhost:9099",
  dbUrl:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:sandbox@localhost:5499/medusa",
  email: process.env.TEST_ADMIN_EMAIL ?? "a.vargas@ecopowertech.com",
  password: process.env.TEST_ADMIN_PASSWORD ?? "",
  jwtSecret: process.env.TEST_JWT_SECRET ?? "",
  sku: process.env.TEST_SKU ?? "EPS-SPR-5DDC",
  qty: Number(process.env.TEST_QTY ?? "5"),
  unitCostCents: 1000,
  meiliUrl: process.env.TEST_MEILI_URL ?? "http://localhost:7799",
  meiliKey: process.env.TEST_MEILI_KEY ?? "sandbox_master_key",
  skipMeili: process.env.TEST_SKIP_MEILI === "1",
};

// ── Globals ───────────────────────────────────────────────────────────────────

const pg = new PgClient({ connectionString: cfg.dbUrl });
let bearer = "";
let variantId = "";
let inventoryItemId = "";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

interface ApiError {
  status: number;
  body: unknown;
}

async function api<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw {
      status: res.status,
      body: parsed,
      message: `${method} ${path} → ${res.status}`,
    } satisfies ApiError & { message: string };
  }
  return parsed as T;
}

async function loginEmailpass(): Promise<void> {
  const res = await fetch(`${cfg.apiUrl}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) {
    throw new Error(`Login response missing token: ${JSON.stringify(json)}`);
  }
  bearer = json.token;
}

async function loginJwt(): Promise<void> {
  const r = await pg.query<{
    user_id: string;
    auth_identity_id: string;
  }>(
    `SELECT u.id AS user_id, pi.auth_identity_id
       FROM "user" u
       JOIN provider_identity pi ON pi.entity_id = u.email
      WHERE u.email = $1 AND u.deleted_at IS NULL
      LIMIT 1`,
    [cfg.email]
  );
  if (r.rows.length === 0) {
    throw new Error(`Admin user not found: ${cfg.email}`);
  }
  const { user_id, auth_identity_id } = r.rows[0]!;
  bearer = jwt.sign(
    {
      actor_id: user_id,
      actor_type: "user",
      auth_identity_id,
      app_metadata: { user_id },
    },
    cfg.jwtSecret,
    { expiresIn: "1h" }
  );
}

async function login(): Promise<void> {
  if (cfg.jwtSecret) {
    await loginJwt();
    return;
  }
  if (cfg.password) {
    await loginEmailpass();
    return;
  }
  throw new Error(
    "Provide TEST_JWT_SECRET (preferred for sandbox) or TEST_ADMIN_PASSWORD"
  );
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function findVariantAndItem(): Promise<void> {
  const r = await pg.query<{ variant_id: string; inventory_item_id: string }>(
    `SELECT v.id AS variant_id, pvi.inventory_item_id
       FROM product_variant v
       JOIN product_variant_inventory_item pvi ON pvi.variant_id = v.id
      WHERE v.sku = $1 AND v.deleted_at IS NULL
      LIMIT 1`,
    [cfg.sku]
  );
  if (r.rows.length === 0) {
    throw new Error(`SKU ${cfg.sku} not found in DB ${cfg.dbUrl}`);
  }
  variantId = r.rows[0]!.variant_id;
  inventoryItemId = r.rows[0]!.inventory_item_id;
}

interface State {
  china: number;
  miami: number;
  onPo: number;
}

async function readState(): Promise<State> {
  const r = await pg.query<{
    inv_china: string | null;
    inv_miami: string | null;
    on_po_miami: string | null;
  }>(
    `SELECT
        il_cn.stocked_quantity AS inv_china,
        il_us.stocked_quantity AS inv_miami,
        COALESCE((
          SELECT SUM(pol.qty_ordered - pol.qty_received - pol.qty_cancelled)
            FROM purchase_order_line pol
            JOIN purchase_order po ON po.id = pol.purchase_order_id
           WHERE pol.sku_snapshot = $1
             AND po.status IN ('submitted','partially_received')
             AND pol.status IN ('open','partial')
             AND pol.deleted_at IS NULL AND po.deleted_at IS NULL
        ), 0) AS on_po_miami
       FROM inventory_item ii
       LEFT JOIN inventory_level il_cn
              ON il_cn.inventory_item_id = ii.id
             AND il_cn.location_id = $2
             AND il_cn.deleted_at IS NULL
       LEFT JOIN inventory_level il_us
              ON il_us.inventory_item_id = ii.id
             AND il_us.location_id = $3
             AND il_us.deleted_at IS NULL
      WHERE ii.id = $4`,
    [cfg.sku, CHINA_LOC, USA_LOC, inventoryItemId]
  );
  const row = r.rows[0];
  return {
    china: Number(row?.inv_china ?? 0),
    miami: Number(row?.inv_miami ?? 0),
    onPo: Number(row?.on_po_miami ?? 0),
  };
}

async function readItStatus(itId: string): Promise<string> {
  const r = await pg.query<{ status: string }>(
    `SELECT status FROM inventory_transfer WHERE id = $1`,
    [itId]
  );
  return r.rows[0]?.status ?? "<missing>";
}

async function readPoStatus(poId: string): Promise<string> {
  const r = await pg.query<{ status: string }>(
    `SELECT status FROM purchase_order WHERE id = $1`,
    [poId]
  );
  return r.rows[0]?.status ?? "<missing>";
}

// ── Meili helpers ─────────────────────────────────────────────────────────────

async function readMeiliInventoryStock(): Promise<number | null> {
  if (cfg.skipMeili) return null;
  const res = await fetch(
    `${cfg.meiliUrl}/indexes/inventory/documents/${inventoryItemId}`,
    { headers: { Authorization: `Bearer ${cfg.meiliKey}` } }
  );
  if (!res.ok) return null;
  const doc = (await res.json()) as { totalStock?: number };
  return typeof doc.totalStock === "number" ? doc.totalStock : null;
}

// ── Reporter ──────────────────────────────────────────────────────────────────

interface Check {
  label: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

interface CaseResult {
  name: string;
  pass: boolean;
  checks: Check[];
  error?: string;
}

const results: CaseResult[] = [];

function expectEq(
  checks: Check[],
  label: string,
  actual: unknown,
  expected: unknown
): void {
  checks.push({
    label,
    expected,
    actual,
    pass: JSON.stringify(actual) === JSON.stringify(expected),
  });
}

// ── Helpers for IT/PO lifecycle ───────────────────────────────────────────────

interface IT {
  id: string;
  number: string;
  status: string;
}

async function createDraftIt(qty = cfg.qty): Promise<IT> {
  const json = await api<{ transfer: IT }>(
    "POST",
    "/admin/inventory-transfers",
    {
      destination_location_id: USA_LOC,
      lines: [
        {
          product_variant_id: variantId,
          sku: cfg.sku,
          description: `E2E test ${new Date().toISOString()}`,
          qty,
          unit_cost_cents: cfg.unitCostCents,
        },
      ],
    }
  );
  return json.transfer;
}

async function confirmIt(
  itId: string
): Promise<{ purchaseOrderId: string }> {
  const json = await api<{ transfer: IT; purchase_order_id: string }>(
    "POST",
    `/admin/inventory-transfers/${itId}/confirm`
  );
  return { purchaseOrderId: json.purchase_order_id };
}

async function shipIt(itId: string): Promise<void> {
  await api("POST", `/admin/inventory-transfers/${itId}/ship`);
}

async function voidIt(itId: string, reason: string): Promise<void> {
  await api("POST", `/admin/inventory-transfers/${itId}/void`, {
    void_reason: reason,
  });
}

async function deleteIt(itId: string): Promise<void> {
  await api("DELETE", `/admin/inventory-transfers/${itId}`);
}

async function patchItLines(
  itId: string,
  lines: Array<{
    product_variant_id: string;
    sku: string;
    qty: number;
    unit_cost_cents?: number;
  }>
): Promise<void> {
  await api("PATCH", `/admin/inventory-transfers/${itId}`, { lines });
}

interface PoLineLite {
  id: string;
  qty_ordered: number;
}

async function getPoLines(poId: string): Promise<PoLineLite[]> {
  const r = await pg.query<{ id: string; qty_ordered: number }>(
    `SELECT id, qty_ordered FROM purchase_order_line
      WHERE purchase_order_id = $1 AND deleted_at IS NULL
      ORDER BY line_order ASC`,
    [poId]
  );
  return r.rows.map((row) => ({
    id: row.id,
    qty_ordered: Number(row.qty_ordered),
  }));
}

interface ReceiveResp {
  receipt: {
    receipt_id: string;
    receipt_number: string;
    po_status_after: string;
  };
}

async function receivePo(
  poId: string,
  lines: Array<{ po_line_id: string; qty_received_now: number }>
): Promise<ReceiveResp["receipt"]> {
  const json = await api<ReceiveResp>(
    "POST",
    `/admin/purchase-orders/${poId}/receive`,
    { lines, vendor_bill_number: `E2E-${Date.now()}` }
  );
  return json.receipt;
}

async function deleteReceipt(poId: string, receiptId: string): Promise<void> {
  await api("DELETE", `/admin/purchase-orders/${poId}/receipts/${receiptId}`, {
    delete_reason: "E2E rollback test",
  });
}

async function voidPo(poId: string, reason: string): Promise<void> {
  await api("POST", `/admin/purchase-orders/${poId}/void`, {
    void_reason: reason,
  });
}

// Wait briefly so workflows that fan out async (Meili sync) catch up.
async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Cases ─────────────────────────────────────────────────────────────────────

async function runCase(
  name: string,
  fn: (checks: Check[]) => Promise<void>
): Promise<void> {
  const checks: Check[] = [];
  const start = Date.now();
  process.stdout.write(`▶ ${name} ... `);
  try {
    await fn(checks);
    const allPass = checks.every((c) => c.pass);
    results.push({ name, pass: allPass, checks });
    const ms = Date.now() - start;
    process.stdout.write(allPass ? `✅ (${ms}ms)\n` : `❌ (${ms}ms)\n`);
    if (!allPass) {
      for (const c of checks.filter((x) => !x.pass)) {
        console.log(
          `    ❌ ${c.label}\n        expected: ${JSON.stringify(
            c.expected
          )}\n        actual:   ${JSON.stringify(c.actual)}`
        );
      }
    }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "object" && err && "message" in err
          ? String((err as { message: unknown }).message)
          : String(err);
    results.push({ name, pass: false, checks, error: message });
    process.stdout.write(`💥 ${message}\n`);
    if (typeof err === "object" && err && "body" in err) {
      console.log("    body:", JSON.stringify((err as ApiError).body));
    }
  }
}

// 1. Happy path — full receipt
async function caseHappyPath(checks: Check[]): Promise<void> {
  const base = await readState();
  const it = await createDraftIt();
  expectEq(checks, "IT created in draft", await readItStatus(it.id), "draft");

  const { purchaseOrderId: poId } = await confirmIt(it.id);
  expectEq(checks, "IT confirmed", await readItStatus(it.id), "confirmed");
  expectEq(checks, "PO submitted", await readPoStatus(poId), "submitted");

  let s = await readState();
  expectEq(checks, "On PO Miami +qty after confirm", s.onPo, base.onPo + cfg.qty);

  await shipIt(it.id);
  expectEq(checks, "IT shipped", await readItStatus(it.id), "shipped");

  const poLines = await getPoLines(poId);
  const r = await receivePo(poId, [
    { po_line_id: poLines[0]!.id, qty_received_now: cfg.qty },
  ]);
  expectEq(checks, "PO received in full", r.po_status_after, "received");

  s = await readState();
  expectEq(checks, "China -qty after receive", s.china, base.china - cfg.qty);
  expectEq(checks, "Miami +qty after receive", s.miami, base.miami + cfg.qty);
  expectEq(checks, "On PO Miami restored to baseline", s.onPo, base.onPo);
  expectEq(checks, "IT received", await readItStatus(it.id), "received");
  expectEq(checks, "PO received", await readPoStatus(poId), "received");

  if (!cfg.skipMeili) {
    await sleep(1500);
    const meili = await readMeiliInventoryStock();
    expectEq(
      checks,
      "Meili inventory.totalStock reflects new totals",
      meili,
      base.china - cfg.qty + (base.miami + cfg.qty)
    );
  }
}

// 2. Partial arrival
async function casePartial(checks: Check[]): Promise<void> {
  const qty = 10;
  const half = 5;
  const base = await readState();
  const it = await createDraftIt(qty);
  const { purchaseOrderId: poId } = await confirmIt(it.id);
  await shipIt(it.id);
  const lines = await getPoLines(poId);

  await receivePo(poId, [
    { po_line_id: lines[0]!.id, qty_received_now: half },
  ]);
  expectEq(
    checks,
    "PO partially_received after 5/10",
    await readPoStatus(poId),
    "partially_received"
  );
  expectEq(
    checks,
    "IT still shipped after partial",
    await readItStatus(it.id),
    "shipped"
  );

  let s = await readState();
  expectEq(checks, "China -5", s.china, base.china - half);
  expectEq(checks, "Miami +5", s.miami, base.miami + half);
  expectEq(checks, "On PO Miami = baseline + remaining 5", s.onPo, base.onPo + (qty - half));

  await receivePo(poId, [
    { po_line_id: lines[0]!.id, qty_received_now: qty - half },
  ]);
  expectEq(checks, "PO received after second receipt", await readPoStatus(poId), "received");
  expectEq(checks, "IT received", await readItStatus(it.id), "received");

  s = await readState();
  expectEq(checks, "China -10 total", s.china, base.china - qty);
  expectEq(checks, "Miami +10 total", s.miami, base.miami + qty);
  expectEq(checks, "On PO Miami back to baseline", s.onPo, base.onPo);
}

// 3. Edit IT lines in draft → PO sync
async function caseEditDraft(checks: Check[]): Promise<void> {
  const it = await createDraftIt(cfg.qty);
  await patchItLines(it.id, [
    {
      product_variant_id: variantId,
      sku: cfg.sku,
      qty: cfg.qty + 3,
      unit_cost_cents: cfg.unitCostCents,
    },
  ]);

  const r = await pg.query<{ qty: string }>(
    `SELECT qty FROM inventory_transfer_line WHERE transfer_id = $1 AND deleted_at IS NULL`,
    [it.id]
  );
  expectEq(checks, "IT line qty updated to 8", Number(r.rows[0]?.qty), cfg.qty + 3);

  const { purchaseOrderId: poId } = await confirmIt(it.id);
  const poLines = await getPoLines(poId);
  expectEq(checks, "PO line qty matches IT after confirm", poLines[0]?.qty_ordered, cfg.qty + 3);

  // cleanup: void to release On PO
  await voidIt(it.id, "E2E cleanup case 3");
}

// 4. Delete receipt → revert
async function caseDeleteReceipt(checks: Check[]): Promise<void> {
  const base = await readState();
  const it = await createDraftIt();
  const { purchaseOrderId: poId } = await confirmIt(it.id);
  await shipIt(it.id);
  const poLines = await getPoLines(poId);

  const r = await receivePo(poId, [
    { po_line_id: poLines[0]!.id, qty_received_now: cfg.qty },
  ]);
  let s = await readState();
  expectEq(checks, "Pre-delete: China -qty", s.china, base.china - cfg.qty);
  expectEq(checks, "Pre-delete: Miami +qty", s.miami, base.miami + cfg.qty);

  await deleteReceipt(poId, r.receipt_id);

  s = await readState();
  expectEq(checks, "Post-delete: China restored", s.china, base.china);
  expectEq(checks, "Post-delete: Miami restored", s.miami, base.miami);
  expectEq(checks, "Post-delete: On PO restored to +qty", s.onPo, base.onPo + cfg.qty);
  expectEq(
    checks,
    "IT reverted to shipped after receipt delete",
    await readItStatus(it.id),
    "shipped"
  );

  // cleanup
  await voidIt(it.id, "E2E cleanup case 4");
}

// 5. Void IT from confirmed
async function caseVoidConfirmed(checks: Check[]): Promise<void> {
  const base = await readState();
  const it = await createDraftIt();
  const { purchaseOrderId: poId } = await confirmIt(it.id);

  let s = await readState();
  expectEq(checks, "On PO +qty after confirm", s.onPo, base.onPo + cfg.qty);

  await voidIt(it.id, "E2E case 5 void from confirmed");

  expectEq(checks, "IT voided", await readItStatus(it.id), "voided");
  expectEq(checks, "PO voided", await readPoStatus(poId), "voided");
  s = await readState();
  expectEq(checks, "China unchanged after void", s.china, base.china);
  expectEq(checks, "Miami unchanged after void", s.miami, base.miami);
  expectEq(checks, "On PO restored to baseline", s.onPo, base.onPo);
}

// 6. Void IT from shipped
async function caseVoidShipped(checks: Check[]): Promise<void> {
  const base = await readState();
  const it = await createDraftIt();
  const { purchaseOrderId: poId } = await confirmIt(it.id);
  await shipIt(it.id);

  await voidIt(it.id, "E2E case 6 void from shipped");
  expectEq(checks, "IT voided", await readItStatus(it.id), "voided");
  expectEq(checks, "PO voided", await readPoStatus(poId), "voided");
  const s = await readState();
  expectEq(checks, "China unchanged", s.china, base.china);
  expectEq(checks, "Miami unchanged", s.miami, base.miami);
  expectEq(checks, "On PO baseline", s.onPo, base.onPo);
}

// 7. Void PO directly → IT auto-voided
async function caseVoidPoDirect(checks: Check[]): Promise<void> {
  const base = await readState();
  const it = await createDraftIt();
  const { purchaseOrderId: poId } = await confirmIt(it.id);

  await voidPo(poId, "E2E case 7 void PO direct");

  expectEq(checks, "PO voided", await readPoStatus(poId), "voided");
  expectEq(
    checks,
    "IT auto-voided via onPoVoided",
    await readItStatus(it.id),
    "voided"
  );
  const s = await readState();
  expectEq(checks, "On PO restored to baseline", s.onPo, base.onPo);
  expectEq(checks, "China unchanged", s.china, base.china);
  expectEq(checks, "Miami unchanged", s.miami, base.miami);
}

// 8. Partial receive + void PO
async function casePartialThenVoid(checks: Check[]): Promise<void> {
  const qty = 10;
  const half = 4;
  const base = await readState();
  const it = await createDraftIt(qty);
  const { purchaseOrderId: poId } = await confirmIt(it.id);
  await shipIt(it.id);
  const lines = await getPoLines(poId);

  await receivePo(poId, [
    { po_line_id: lines[0]!.id, qty_received_now: half },
  ]);

  await voidPo(poId, "E2E case 8 void PO after partial");

  expectEq(checks, "PO voided", await readPoStatus(poId), "voided");
  expectEq(checks, "IT auto-voided", await readItStatus(it.id), "voided");

  const s = await readState();
  expectEq(checks, "China -4 (only what was received)", s.china, base.china - half);
  expectEq(checks, "Miami +4 (received units stay)", s.miami, base.miami + half);
  expectEq(checks, "On PO restored to baseline (remaining 6 cancelled)", s.onPo, base.onPo);
}

// 9. Delete IT in draft (no PO)
async function caseDeleteDraft(checks: Check[]): Promise<void> {
  const it = await createDraftIt();
  expectEq(checks, "IT in draft", await readItStatus(it.id), "draft");

  await deleteIt(it.id);

  const r = await pg.query<{ id: string }>(
    `SELECT id FROM inventory_transfer WHERE id = $1`,
    [it.id]
  );
  expectEq(checks, "IT row gone after delete", r.rows.length, 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(72));
  console.log("TEST_HOME — Transfer-to-USA E2E");
  console.log(`API:  ${cfg.apiUrl}`);
  console.log(`DB:   ${cfg.dbUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`SKU:  ${cfg.sku}  qty per IT: ${cfg.qty}`);
  console.log(`Meili: ${cfg.skipMeili ? "skipped" : cfg.meiliUrl}`);
  console.log("=".repeat(72));

  await pg.connect();
  await findVariantAndItem();
  console.log(
    `Resolved variant_id=${variantId} inventory_item_id=${inventoryItemId}`
  );

  const initial = await readState();
  console.log(
    `Initial state — China: ${initial.china}  Miami: ${initial.miami}  On PO Miami: ${initial.onPo}`
  );

  if (initial.china < cfg.qty * 5) {
    throw new Error(
      `China stock too low (${initial.china}) — needs ≥ ${cfg.qty * 5} for safe testing`
    );
  }

  await login();
  console.log(`Logged in as ${cfg.email}`);
  console.log("─".repeat(72));

  await runCase("1. Happy path — full receipt", caseHappyPath);
  await runCase("2. Partial arrival", casePartial);
  await runCase("3. Edit IT lines in draft", caseEditDraft);
  await runCase("4. Delete receipt → revert", caseDeleteReceipt);
  await runCase("5. Void IT from confirmed", caseVoidConfirmed);
  await runCase("6. Void IT from shipped", caseVoidShipped);
  await runCase("7. Void PO directly → IT auto-voided", caseVoidPoDirect);
  await runCase("8. Partial receive + Void PO", casePartialThenVoid);
  await runCase("9. Delete IT (draft, no PO)", caseDeleteDraft);

  console.log("─".repeat(72));
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed`);

  const finalState = await readState();
  console.log(
    `Final state  — China: ${finalState.china}  Miami: ${finalState.miami}  On PO Miami: ${finalState.onPo}`
  );

  await pg.end();

  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  try {
    await pg.end();
  } catch {
    /* ignore */
  }
  process.exit(2);
});
