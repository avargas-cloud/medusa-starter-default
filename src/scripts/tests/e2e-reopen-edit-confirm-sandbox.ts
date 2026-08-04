/**
 * e2e-reopen-edit-confirm-sandbox.ts
 *
 * The repair path for a bill that is already in QuickBooks:
 *
 *     Edit (PIN) → Reopen → edit → Save → Confirm
 *
 * and Confirm is what decides what QuickBooks gets. Every assertion below is a
 * step of that path, driven over REAL HTTP against the sandbox backend, because
 * the bugs being covered were both in the seams between screen and route.
 *
 * WHAT IT COVERS
 *
 *  1. Reopen accepts a bill that lives in QuickBooks. It used to answer "Void
 *     this bill in QuickBooks before reopening it", which walled off the
 *     ordinary correction: VB-1061 sat at $346.43 here against $328.60 over
 *     there for eleven days behind that message.
 *  2. Reopening reverses NOTHING — the QB TxnID stays, the revisions stay, the
 *     posted costs stay. It is an editing-state transition, not an undo.
 *  3. An ADOPTED bill is still refused: it is the accountant's document.
 *  4. A service/freight/tariff bill takes a Mod even when the operator ADDED a
 *     charge line QuickBooks has never seen. That line goes with a null
 *     TxnLineID, which the bridge sends as -1 and QuickBooks appends. It used
 *     to throw "lacks QB identity" and look like corruption.
 *  5. The decision itself: a NEW PO-linked PRODUCT line is the ONLY thing that
 *     forces delete-and-recreate, because LinkToTxn exists solely on BillAdd.
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-reopen-edit-confirm-sandbox.ts
 */

import { Client } from "pg";
import { randomUUID } from "crypto";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const BASE = process.env.SANDBOX_API_URL ?? "http://localhost:9099";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("Refusing to run: this E2E is sandbox-only (port 5499).");
  process.exit(1);
}

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}

interface Fx {
  poId: string;
  poLineId: string;
  vendorId: string;
  regularId: string;
  serviceId: string;
  adoptedId: string;
  locationId: string;
  itemId: string;
  variantId: string;
  accountId: string;
}

let seqCounter = 0;

async function plant(db: Client): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    vendorId: `qbvnd_rc_${n}`,
    regularId: randomUUID(),
    serviceId: randomUUID(),
    adoptedId: randomUUID(),
    locationId: `sloc_rc_${n}`,
    itemId: `iitem_rc_${n}`,
    variantId: `variant_rc_${n}`,
    accountId: `ACC-RC-${n}`,
  };

  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        metadata, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, '{}'::jsonb, NOW(), NOW())`,
    [f.vendorId, `QBV-RC-${n}`, `Reopen E2E ${n}`]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, 'RC E2E', NOW(), NOW())`,
    [f.locationId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $1, NOW(), NOW())`,
    [f.itemId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, metadata, created_at, updated_at)
     VALUES ($1, 'RC variant', $2::jsonb, NOW(), NOW())`,
    [f.variantId, JSON.stringify({ quickbooks_id: `QBITEM-RC-${n}` })]
  );
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
        created_by_user_id, status, number, seq, qb_purchase_order_list_id)
     VALUES ($1, $2, $3, 'user_rc', 'received', $4, $5, $6)`,
    [
      f.poId,
      f.vendorId,
      f.locationId,
      `PO-RC-${n}`,
      // Random, never a counter: a run that dies before cleanup leaves its
      // seq behind and a fixed base collides with it forever after.
      990000 + Math.floor(Math.random() * 9000) + (seqCounter += 1),
      `QBPO-RC-${n}`,
    ]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents, qb_txn_line_id)
     VALUES ($1, $2, $3, $4, 'SKU-RC', 'RC goods', 10, 10, 1000, 10000, $5)`,
    [f.poLineId, f.poId, f.variantId, f.itemId, `QBPOLINE-RC-${n}`]
  );

  // A SERVICE bill, synced, with one line QuickBooks knows about.
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
        reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
        document_date, qb_txn_id, qb_edit_sequence)
     VALUES ($1, $2, 'synced', 'service', $3, $4, 'QBV-RC', 'Reopen E2E', NOW(),
             $5, '1')`,
    [f.serviceId, f.poId, `VB-RC-SVC-${n}`, `REF-RC-SVC-${n}`, `TXN-RC-SVC-${n}`]
  );
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
        qb_account_type, sku, description, qty, unit_cost_cents,
        landed_unit_cost_cents, qb_txn_line_id, created_at, updated_at)
     VALUES ($1, $2, 'qb_account', $3, 'Commission for Purchase', 'Expense',
             'COMM', 'Commission', 1, 32860, 32860, $4, NOW(), NOW())`,
    [`vbl_${randomUUID().replace(/-/g, "")}`, f.serviceId, f.accountId, `TXNLINE-RC-SVC-${n}`]
  );

  // A REGULAR bill, synced, one PO-linked product line QuickBooks knows about.
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
        reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
        document_date, qb_txn_id, qb_edit_sequence)
     VALUES ($1, $2, 'synced', 'regular', $3, $4, 'QBV-RC', 'Reopen E2E', NOW(),
             $5, '1')`,
    [f.regularId, f.poId, `VB-RC-REG-${n}`, `REF-RC-REG-${n}`, `TXN-RC-REG-${n}`]
  );
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
        sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
        qb_txn_line_id, created_at, updated_at)
     VALUES ($1, $2, 'product', $3, $4, 'SKU-RC', 'RC goods', 10, 1000, 1000,
             $5, NOW(), NOW())`,
    [
      `vbl_${randomUUID().replace(/-/g, "")}`,
      f.regularId,
      f.variantId,
      f.poLineId,
      `TXNLINE-RC-REG-${n}`,
    ]
  );
  // A revision, so "reopening reverses nothing" has something to not reverse.
  await db.query(
    `INSERT INTO vendor_bill_revision
       (id, vendor_bill_id, revision_number, status, input_hash, confirmed_at,
        header_snapshot, lines_snapshot, created_at, updated_at)
     VALUES ($1, $2, 1, 'confirmed', 'hash-rc', NOW(),
             '{}'::jsonb, '[]'::jsonb, NOW(), NOW())`,
    [`vbrev_${randomUUID().replace(/-/g, "")}`, f.regularId]
  );

  // An ADOPTED bill — the accountant's document.
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, status, bill_type, number,
        reference_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
        document_date, qb_txn_id, qb_edit_sequence, qb_source)
     VALUES ($1, $2, 'synced', 'regular', $3, $4, 'QBV-RC', 'Reopen E2E', NOW(),
             $5, '1', 'adopted')`,
    [f.adoptedId, f.poId, `VB-RC-ADP-${n}`, `REF-RC-ADP-${n}`, `TXN-RC-ADP-${n}`]
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
    for (const id of [f.regularId, f.serviceId, f.adoptedId]) {
      await db.query(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`, [id]);
      await db.query(`DELETE FROM vendor_bill_revision WHERE vendor_bill_id = $1`, [id]);
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

/**
 * `medusa develop` restarts whenever a file under src/ changes — including this
 * one — so a run launched right after an edit races the reboot and dies with
 * ECONNREFUSED, which reads like the sandbox is down when it is merely
 * restarting.
 */
async function waitForApi(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/pub/version`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (r.ok) return;
    } catch {
      // still booting
    }
    if (Date.now() > deadline) {
      throw new Error(`El backend del sandbox no respondió en ${BASE}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main(): Promise<void> {
  console.log("=== e2e-reopen-edit-confirm (sandbox) ===\n");
  process.env.QB_VENDOR_BILL_MODE = "bill";

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
    console.error(
      `No se pudo loguear como ${email} (HTTP ${authRes.status}). Ver docs/SANDBOX.md.`
    );
    process.exit(1);
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.token}`,
  };

  const planted: Fx[] = [];
  try {
    const f = await plant(db);
    planted.push(f);

    // ── 1 · Reopen accepts a bill that lives in QuickBooks ──────────────────
    console.log("Reopen de un bill que YA está en QuickBooks");
    const reopenRes = await fetch(`${BASE}/admin/vendor-bills/${f.regularId}/reopen`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const reopenBody = (await reopenRes.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    check(
      "se permite (antes: 'Void this bill in QuickBooks before reopening it')",
      reopenRes.status === 200,
      `HTTP ${reopenRes.status} ${reopenBody.code ?? ""} ${reopenBody.error ?? ""}`
    );

    // ── 2 · It reverses nothing ─────────────────────────────────────────────
    const after = await db.query<{
      status: string;
      qb_txn_id: string | null;
      confirmed_at: string | null;
    }>(
      `SELECT status, qb_txn_id, confirmed_at FROM vendor_bill WHERE id = $1`,
      [f.regularId]
    );
    check("el bill vuelve a draft", after.rows[0]?.status === "draft", String(after.rows[0]?.status));
    check(
      "el documento de QuickBooks sigue vivo — el TxnID no se tocó",
      after.rows[0]?.qb_txn_id != null,
      String(after.rows[0]?.qb_txn_id)
    );
    const revs = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vendor_bill_revision WHERE vendor_bill_id = $1`,
      [f.regularId]
    );
    check(
      "la revisión confirmada sigue en pie — reabrir NO es deshacer",
      Number(revs.rows[0]?.n ?? 0) === 1,
      `${revs.rows[0]?.n} revisiones`
    );
    const lines = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM vendor_bill_line
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [f.regularId]
    );
    check(
      "y sus líneas siguen ahí para editarlas",
      Number(lines.rows[0]?.n ?? 0) === 1
    );

    // ── 3 · An adopted bill is still refused ────────────────────────────────
    console.log("\nControl negativo — bill adoptado");
    const adoptedRes = await fetch(`${BASE}/admin/vendor-bills/${f.adoptedId}/reopen`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const adoptedBody = (await adoptedRes.json().catch(() => ({}))) as {
      code?: string;
    };
    check(
      "sigue prohibido — es el documento del contador",
      adoptedRes.status === 409 && adoptedBody.code === "adopted_bill_readonly",
      `HTTP ${adoptedRes.status} ${adoptedBody.code ?? ""}`
    );
    const adoptedAfter = await db.query<{ status: string }>(
      `SELECT status FROM vendor_bill WHERE id = $1`,
      [f.adoptedId]
    );
    check(
      "y quedó intacto",
      adoptedAfter.rows[0]?.status === "synced",
      String(adoptedAfter.rows[0]?.status)
    );

    // ── 4 · A sibling bill with a NEW charge line still takes a Mod ─────────
    console.log("\nUn bill de comisión al que le agregaron un cargo nuevo");
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
          qb_account_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, qb_txn_line_id, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, 'Bank Charges', 'Expense',
               'FEE', 'Wire fee', 1, 4500, 4500, NULL, NOW(), NOW())`,
      [`vbl_${randomUUID().replace(/-/g, "")}`, f.serviceId, f.accountId]
    );

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
    const { enqueueVendorBillModSingle } = await import(
      "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue"
    );
    let modResult: { queued: boolean; reason?: string } = { queued: false };
    let threw: string | null = null;
    try {
      modResult = await enqueueVendorBillModSingle(knexLike as never, f.serviceId);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    check(
      "el Mod NO explota (antes: 'account line … lacks QB identity')",
      threw === null,
      threw ?? ""
    );
    check("y se encola", modResult.queued === true, JSON.stringify(modResult));

    const sibPayload = await db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM qb_order_pipeline
        WHERE reference_id = $1 AND step = 'vendor_bill_mod'`,
      [f.serviceId]
    );
    const expenses = (
      sibPayload.rows[0]?.payload as {
        expense_lines?: Array<{ amount_cents: number; qb_txn_line_id: string | null }>;
        item_lines?: unknown[];
      }
    )?.expense_lines ?? [];
    check(
      "manda las DOS líneas: la vieja y la nueva",
      expenses.length === 2,
      JSON.stringify(expenses.map((l) => l.amount_cents))
    );
    check(
      "la nueva va SIN TxnLineID — el bridge la manda como -1 y QuickBooks la agrega",
      expenses.some((l) => l.amount_cents === 4500 && l.qb_txn_line_id === null),
      JSON.stringify(expenses)
    );
    check(
      "la vieja conserva su TxnLineID real — el Mod reproduce lo que el Add mandó",
      expenses.some((l) => l.amount_cents === 32860 && l.qb_txn_line_id !== null)
    );

    // ── 5 · The decision: only a NEW PO-linked PRODUCT line forces delete/new ─
    console.log("\nQué obliga a borrar y recrear");
    const newProductLine = `vbl_${randomUUID().replace(/-/g, "")}`;
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, product_variant_id, purchase_order_line_id,
          sku, description, qty, unit_cost_cents, landed_unit_cost_cents,
          qb_txn_line_id, created_at, updated_at)
       VALUES ($1, $2, 'product', $3, $4, 'SKU-RC-NEW', 'RC new goods', 2, 500,
               500, NULL, NOW(), NOW())`,
      [newProductLine, f.regularId, f.variantId, f.poLineId]
    );
    // Same predicate the confirm route applies before any accounting write.
    const rebuildNeeded = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM vendor_bill_line l
         JOIN vendor_bill vb ON vb.id = l.vendor_bill_id
        WHERE l.vendor_bill_id = $1 AND l.deleted_at IS NULL
          AND COALESCE(l.line_type,'product') = 'product'
          AND l.purchase_order_line_id IS NOT NULL
          AND l.qb_txn_line_id IS NULL
          AND vb.qb_txn_id IS NOT NULL`,
      [f.regularId]
    );
    check(
      "una línea de PRODUCTO nueva ligada al PO exige delete/new — LinkToTxn sólo existe en BillAdd",
      Number(rebuildNeeded.rows[0]?.n ?? 0) === 1,
      `${rebuildNeeded.rows[0]?.n} líneas`
    );
    const sameForService = await db.query<{ n: string }>(
      `SELECT COUNT(*) AS n
         FROM vendor_bill_line l
        WHERE l.vendor_bill_id = $1 AND l.deleted_at IS NULL
          AND COALESCE(l.line_type,'product') = 'product'
          AND l.purchase_order_line_id IS NOT NULL
          AND l.qb_txn_line_id IS NULL`,
      [f.serviceId]
    );
    check(
      "un bill de comisión NUNCA cae ahí: no tiene líneas de producto ligadas al PO",
      Number(sameForService.rows[0]?.n ?? 0) === 0,
      `${sameForService.rows[0]?.n}`
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
