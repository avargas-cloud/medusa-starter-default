/**
 * E2E — reducir un PO con un vendor bill DRAFT enlazado, y propagar las
 * cantidades al bill. SANDBOX ONLY.
 *
 * Cubre los dos deltas del 2026-08-04:
 *   v2 — un bill DRAFT ya no bloquea la reducción del PO (antes: 409
 *        `vendor_bill_revision_pending`). Un bill CONFIRMED sí sigue
 *        bloqueando por debajo de lo facturado.
 *   v3 — POST /propagate-line-quantities baja las cantidades al bill draft, y
 *        ELIMINA la línea que queda en 0 (decisión del owner; el modal la
 *        nombra antes de confirmar).
 *
 * La aserción que importa NO es el código de estado sino el EFECTO: que la
 * línea del bill realmente quedó en la cantidad nueva, que la que fue a 0
 * realmente desapareció, y que un bill confirmed salió INTACTO.
 *
 *   ./back-sb
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-po-reduce-draft-bill-sandbox.ts
 */
import { randomUUID } from "crypto";

import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(`BASE apunta a ${BASE}. Este script muta POs y bills — sólo sandbox.`);
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(`la DB no es la del sandbox (se esperaba localhost:5499).`);
}

const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

async function call(
  path: string,
  opts: { token: string; method?: string; body?: Record<string, unknown> }
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* queda `raw` */
  }
  return { status: res.status, body, raw };
}

interface Fx {
  poId: string;
  lineA: string;
  lineB: string;
  billId: string;
  billLineA: string;
  billLineB: string;
  locationId: string;
  itemA: string;
  itemB: string;
}

/** PO con DOS líneas facturadas en un bill, para probar baja y eliminación. */
async function plant(
  db: Client,
  seq: number,
  billStatus: "draft" | "confirmed"
): Promise<Fx> {
  const f: Fx = {
    poId: randomUUID(),
    lineA: randomUUID(),
    lineB: randomUUID(),
    billId: randomUUID(),
    billLineA: randomUUID(),
    billLineB: randomUUID(),
    locationId: `sloc_po_e2e_${seq}_${randomUUID().slice(0, 6)}`,
    itemA: `iitem_po_e2e_a${seq}_${randomUUID().slice(0, 6)}`,
    itemB: `iitem_po_e2e_b${seq}_${randomUUID().slice(0, 6)}`,
  };
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())`,
    [f.locationId, `PO E2E Loc ${seq}`]
  );
  for (const item of [f.itemA, f.itemB]) {
    await db.query(
      `INSERT INTO inventory_item (id, sku, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [item, item]
    );
  }
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
                                 created_by_user_id, status, number, seq)
     VALUES ($1, 'vendor_e2e', $2, 'user_e2e', 'submitted', $3, $4)`,
    [f.poId, f.locationId, `PO-QE2E-${seq}`, 991000 + seq]
  );
  const lines: Array<[string, string, string, number]> = [
    [f.lineA, f.itemA, `SKU-QA-${seq}`, 50],
    [f.lineB, f.itemB, `SKU-QB-${seq}`, 10],
  ];
  for (const [lineId, item, sku, qty] of lines) {
    await db.query(
      `INSERT INTO purchase_order_line
         (id, purchase_order_id, product_variant_id, inventory_item_id,
          sku_snapshot, description_snapshot, qty_ordered, qty_received,
          unit_cost_cents, total_cents)
       VALUES ($1, $2, 'variant_e2e', $3, $4, 'E2E line', $5, 0, 500, $6)`,
      [lineId, f.poId, item, sku, qty, qty * 500]
    );
  }
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number)
     VALUES ($1, $2, $3, 'regular', $4)`,
    [f.billId, f.poId, billStatus, `VB-QE2E-${seq}`]
  );
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, sku, description, qty, unit_cost_cents,
        purchase_order_line_id)
     VALUES ($1, $2, $3, 'E2E line', 50, 500, $4),
            ($5, $2, $6, 'E2E line', 10, 500, $7)`,
    [
      f.billLineA,
      f.billId,
      `SKU-QA-${seq}`,
      f.lineA,
      f.billLineB,
      `SKU-QB-${seq}`,
      f.lineB,
    ]
  );
  return f;
}

async function cleanup(db: Client, all: Fx[]): Promise<void> {
  for (const f of all) {
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [f.billId]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [f.billId]);
    await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [f.poId]);
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [f.poId]);
    await db.query(`DELETE FROM inventory_item WHERE id = ANY($1)`, [[f.itemA, f.itemB]]);
    await db.query(`DELETE FROM stock_location WHERE id = $1`, [f.locationId]);
  }
}

async function billLine(
  db: Client,
  id: string
): Promise<{ qty: number; deleted: boolean } | null> {
  const { rows } = await db.query<{ qty: string; deleted_at: string | null }>(
    `SELECT qty::text, deleted_at FROM vendor_bill_line WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  return { qty: Number(rows[0].qty), deleted: rows[0].deleted_at !== null };
}

async function main(): Promise<void> {
  console.log("=== e2e-po-reduce-draft-bill (sandbox) ===\n");
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com",
      password: process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123",
    }),
  });
  const auth = (await authRes.json()) as { token?: string };
  if (!auth.token) {
    await db.end();
    abort(`login falló (${authRes.status}). ¿Está ./back-sb arriba?`);
  }
  const token = auth.token;

  const planted: Fx[] = [];
  try {
    // ── v3: propagación sobre un bill DRAFT ─────────────────────────────────
    console.log("Delta v3 — propagar cantidades al bill DRAFT");
    const d = await plant(db, 1, "draft");
    planted.push(d);

    const prop = await call(
      `/admin/purchase-orders/${d.poId}/propagate-line-quantities`,
      {
        token,
        body: {
          lines: [
            { purchase_order_line_id: d.lineA, qty: 20 },
            { purchase_order_line_id: d.lineB, qty: 0 },
          ],
        },
      }
    );
    check(
      "el endpoint responde 200",
      prop.status === 200,
      `status=${prop.status} body=${prop.raw.slice(0, 300)}`
    );
    check(
      "reporta 1 línea actualizada y 1 eliminada",
      prop.body.updated_lines === 1 && prop.body.removed_lines === 1,
      `updated=${String(prop.body.updated_lines)} removed=${String(prop.body.removed_lines)}`
    );

    const a = await billLine(db, d.billLineA);
    check(
      "la línea A del bill bajó de 50 a 20",
      a?.qty === 20 && a.deleted === false,
      `qty=${a?.qty} deleted=${a?.deleted}`
    );
    const b = await billLine(db, d.billLineB);
    check(
      "la línea B, que fue a 0, quedó ELIMINADA (soft delete)",
      b?.deleted === true,
      `deleted=${b?.deleted} qty=${b?.qty}`
    );
    check(
      "el soft delete conserva la fila para auditoría",
      b !== null,
      "la fila desapareció por completo; se esperaba deleted_at"
    );

    // Idempotencia: repetir no vuelve a contar nada.
    const again = await call(
      `/admin/purchase-orders/${d.poId}/propagate-line-quantities`,
      { token, body: { lines: [{ purchase_order_line_id: d.lineA, qty: 20 }] } }
    );
    check(
      "repetir la propagación no cambia nada",
      again.body.updated_lines === 0 && again.body.removed_lines === 0,
      `updated=${String(again.body.updated_lines)}`
    );

    // ── v3: un bill CONFIRMED sale intacto y se reporta ──────────────────────
    console.log("\nControl — bill CONFIRMED: intacto y reportado en skipped");
    const c = await plant(db, 2, "confirmed");
    planted.push(c);
    const onConfirmed = await call(
      `/admin/purchase-orders/${c.poId}/propagate-line-quantities`,
      { token, body: { lines: [{ purchase_order_line_id: c.lineA, qty: 20 }] } }
    );
    check(
      "no toca ninguna línea de un bill posteado",
      onConfirmed.body.updated_lines === 0 &&
        onConfirmed.body.removed_lines === 0,
      `updated=${String(onConfirmed.body.updated_lines)}`
    );
    const skipped = (onConfirmed.body.skipped ?? []) as Array<
      Record<string, unknown>
    >;
    check(
      "y lo reporta en `skipped` por nombre, nunca en silencio",
      skipped.length === 1 && skipped[0]?.reason === "bill_not_draft",
      `skipped=${JSON.stringify(skipped)}`
    );
    const untouched = await billLine(db, c.billLineA);
    check(
      "la línea del bill confirmed sigue en 50",
      untouched?.qty === 50 && untouched.deleted === false,
      `qty=${untouched?.qty}`
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
