/**
 * e2e-expense-bill-sandbox.ts
 *
 * The EXPENSE bill: a vendor bill with NO purchase order for operating
 * expenses (supplies, installs, office costs). Its whole shape is what the
 * other types refuse — it opens EMPTY (vendor + ref only, lines are added
 * inside the document) and it never has a PO, so its QB operations chain by
 * its own bill id instead of a purchase order's.
 *
 * WHAT IT COVERS, over real HTTP against the sandbox backend plus direct
 * calls into the enqueue libs (the server may run with QB_VENDOR_BILL_MODE
 * unset, so the pipeline shape is asserted in-process like
 * e2e-china-bill-add-sandbox does):
 *
 *  1. POST /admin/vendor-bills with bill_type 'expense' and NO lines →
 *     422 vendor_bill_line_required: the editor stages the document in the
 *     browser and only its Save reaches this route, so an empty expense bill
 *     never exists in the database (owner decision 2026-08-20).
 *  2. The other standalone types keep the same guard: 'service' without a
 *     line is 422 vendor_bill_line_required.
 *  3. Account rules at create: `initial_account_lines` with a
 *     CostOfGoodsSold account → 422 account_not_allowed.
 *  4. Create with TWO Expense lines → 201 draft with both lines and no PO.
 *  5. Confirm succeeds.
 *  6. ADD enqueue: queued with purchase_order_id NULL, po_txn_id null,
 *     item_lines empty, one expense line — and the dependency chain keyed by
 *     the BILL's own id.
 *  7. A service bill without a PO is ACCEPTED by the ADD enqueue. It used to
 *     assert the opposite — the carve-out was expense-only — and `bdfbecaf`
 *     (2026-08-31) replaced that with "only a REGULAR bill requires a PO"
 *     without updating this check, so it sat red asserting a rule the code no
 *     longer had. A sales commission and an outsourced service are exactly
 *     this shape.
 *  8. MOD enqueue (edit after sync): queued, and its operation depends on the
 *     ADD in the same bill-scoped chain (Add → Mod stays serial).
 *
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-expense-bill-sandbox.ts
 */

import { randomUUID } from "crypto";
import { Client } from "pg";

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
  console.log(
    `  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`
  );
}

interface Fx {
  vendorId: string;
  vendorQbListId: string;
  expenseAccountId: string;
  cogsAccountId: string;
}

async function plant(db: Client): Promise<Fx> {
  const n = randomUUID().slice(0, 8);
  const f: Fx = {
    vendorId: `qbvnd_exp_${n}`,
    vendorQbListId: `QBV-EXP-${n}`,
    expenseAccountId: `ACC-EXP-${n}`,
    cogsAccountId: `ACC-COGS-${n}`,
  };
  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, company_name,
        is_active, metadata, created_at, updated_at, last_synced_at)
     VALUES ($1, $2, $3, $3, $3, true, '{}'::jsonb, NOW(), NOW(), NOW())`,
    [f.vendorId, f.vendorQbListId, `Expense E2E ${n}`]
  );
  await db.query(
    `INSERT INTO qb_account (id, qb_list_id, full_name, name, account_type,
        is_active, last_synced_at, created_at, updated_at)
     VALUES ($1, $1, 'Office Supplies E2E', 'Office Supplies E2E', 'Expense',
             true, NOW(), NOW(), NOW()),
            ($2, $2, 'COGS Control E2E', 'COGS Control E2E', 'CostOfGoodsSold',
             true, NOW(), NOW(), NOW())`,
    [f.expenseAccountId, f.cogsAccountId]
  );
  return f;
}

async function cleanup(db: Client, f: Fx, billIds: string[]): Promise<void> {
  for (const id of billIds) {
    await db.query(
      `DELETE FROM qb_order_pipeline WHERE reference_id = $1 OR order_id = $1`,
      [id]
    );
    await db.query(
      `DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = $1`,
      [id]
    );
    await db.query(
      `DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`,
      [id]
    );
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [
      id,
    ]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [id]);
  }
  await db.query(`DELETE FROM qb_account WHERE id = ANY($1)`, [
    [f.expenseAccountId, f.cogsAccountId],
  ]);
  await db.query(`DELETE FROM qb_vendor WHERE id = $1`, [f.vendorId]);
}

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Sandbox API at ${BASE} did not come up`);
}

async function main(): Promise<void> {
  console.log("=== e2e-expense-bill (sandbox) ===\n");
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
    transaction: async <T,>(
      handler: (trx: unknown) => Promise<T>
    ): Promise<T> => {
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

  const f = await plant(db);
  const billIds: string[] = [];
  const n = randomUUID().slice(0, 6);

  try {
    // 1 — un expense bill VACÍO no puede existir: el create sin líneas es 422
    const emptyCreate = await fetch(`${BASE}/admin/vendor-bills`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vendor_id: f.vendorId,
        bill_type: "expense",
        commission_mode: "percent",
        reference_id: `EXP-EMPTY-${n}`,
      }),
    });
    const emptyCreateBody = (await emptyCreate.json().catch(() => ({}))) as {
      code?: string;
      vendor_bill?: { id: string };
    };
    if (emptyCreateBody.vendor_bill?.id) billIds.push(emptyCreateBody.vendor_bill.id);
    check(
      "expense sin líneas → 422 vendor_bill_line_required (jamás nace vacío)",
      emptyCreate.status === 422 &&
        emptyCreateBody.code === "vendor_bill_line_required",
      `HTTP ${emptyCreate.status} code=${emptyCreateBody.code}`
    );

    // 1b — cuenta COGS dentro de initial_account_lines → rechazado entero
    const cogsCreate = await fetch(`${BASE}/admin/vendor-bills`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vendor_id: f.vendorId,
        bill_type: "expense",
        commission_mode: "percent",
        reference_id: `EXP-COGS-${n}`,
        initial_account_lines: [
          { qb_account_list_id: f.cogsAccountId, amount_cents: 5000 },
        ],
      }),
    });
    const cogsCreateBody = (await cogsCreate.json().catch(() => ({}))) as {
      code?: string;
      vendor_bill?: { id: string };
    };
    if (cogsCreateBody.vendor_bill?.id) billIds.push(cogsCreateBody.vendor_bill.id);
    check(
      "create con cuenta COGS → 422 account_not_allowed",
      cogsCreate.status === 422 && cogsCreateBody.code === "account_not_allowed",
      `HTTP ${cogsCreate.status} code=${cogsCreateBody.code}`
    );

    // 2 — el Save real del editor: bill + 2 líneas Expense en UN create
    const createRes = await fetch(`${BASE}/admin/vendor-bills`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vendor_id: f.vendorId,
        bill_type: "expense",
        commission_mode: "percent",
        reference_id: `EXP-E2E-${n}`,
        initial_account_lines: [
          {
            qb_account_list_id: f.expenseAccountId,
            amount_cents: 12345,
            description: "Office supplies run",
          },
          { qb_account_list_id: f.expenseAccountId, amount_cents: 6700 },
        ],
      }),
    });
    const created = (await createRes.json().catch(() => ({}))) as {
      vendor_bill?: {
        id: string;
        status: string;
        bill_type: string;
        purchase_order_id: string | null;
        lines: unknown[];
        total_landed_cents?: number;
      };
    };
    const bill = created.vendor_bill;
    if (bill?.id) billIds.push(bill.id);
    check(
      "create con 2 líneas Expense → 201 draft con ambas y sin PO",
      createRes.status === 201 &&
        bill?.status === "draft" &&
        (bill?.lines ?? []).length === 2 &&
        !bill?.purchase_order_id &&
        bill?.total_landed_cents === 19045,
      `HTTP ${createRes.status} lines=${(bill?.lines ?? []).length} total=${bill?.total_landed_cents}`
    );

    // 2 — control negativo: service SIN línea sigue rechazado
    const svcRes = await fetch(`${BASE}/admin/vendor-bills`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        vendor_id: f.vendorId,
        bill_type: "service",
        commission_mode: "percent",
        reference_id: `SVC-E2E-${n}`,
      }),
    });
    const svcBody = (await svcRes.json().catch(() => ({}))) as {
      code?: string;
      vendor_bill?: { id: string };
    };
    if (svcBody.vendor_bill?.id) billIds.push(svcBody.vendor_bill.id);
    check(
      "service sin línea inicial sigue 422 vendor_bill_line_required",
      svcRes.status === 422 && svcBody.code === "vendor_bill_line_required",
      `HTTP ${svcRes.status} code=${svcBody.code}`
    );

    if (!bill?.id) throw new Error("no expense bill to continue with");

    // 3 — el add-line del documento sigue filtrando: cuenta COGS rechazada
    const cogsLine = await fetch(
      `${BASE}/admin/vendor-bills/${bill.id}/account-lines`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          qb_account_list_id: f.cogsAccountId,
          amount_cents: 5000,
          description: "should not land",
        }),
      }
    );
    const cogsBody = (await cogsLine.json().catch(() => ({}))) as {
      code?: string;
    };
    check(
      "account-lines con CostOfGoodsSold → 422 account_not_allowed",
      cogsLine.status === 422 && cogsBody.code === "account_not_allowed",
      `HTTP ${cogsLine.status} code=${cogsBody.code}`
    );

    // 4 — confirm
    const confirmRes = await fetch(
      `${BASE}/admin/vendor-bills/${bill.id}/confirm`,
      { method: "POST", headers, body: JSON.stringify({}) }
    );
    check("confirm con líneas → success", confirmRes.ok, `HTTP ${confirmRes.status}`);
    const statusRow = await db.query(
      `SELECT status FROM vendor_bill WHERE id = $1`,
      [bill.id]
    );
    check(
      "el bill queda confirmed",
      ["confirmed", "synced"].includes(String(statusRow.rows[0]?.status)),
      `status=${statusRow.rows[0]?.status}`
    );

    // 6 — ADD enqueue in-process (la instancia del server puede tener el flag apagado)
    await db.query(
      `DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = $1`,
      [bill.id]
    );
    const { enqueueQbVendorBillAdd } = await import(
      "../../lib/purchase-orders/qb-vendor-bill-enqueue"
    );
    const addRes = await enqueueQbVendorBillAdd(knexLike as never, bill.id);
    check(
      "ADD enqueue: queued sin PO",
      (addRes as { queued: boolean }).queued === true,
      `reason=${(addRes as { reason?: string }).reason}`
    );
    const pipeRow = await db.query(
      `SELECT purchase_order_id, intent, payload FROM qb_vendor_bill_pipeline
        WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
      [bill.id]
    );
    const payload = (pipeRow.rows[0]?.payload ?? {}) as {
      po_id?: unknown;
      po_txn_id?: unknown;
      memo?: string;
      item_lines?: unknown[];
      expense_lines?: unknown[];
    };
    check(
      "pipeline row: purchase_order_id NULL, intent add",
      pipeRow.rows.length === 1 &&
        pipeRow.rows[0].purchase_order_id === null &&
        pipeRow.rows[0].intent === "add"
    );
    check(
      "payload: po_id/po_txn_id null · 0 item lines · 2 expense lines · memo sin PO",
      payload.po_id === null &&
        payload.po_txn_id === null &&
        (payload.item_lines ?? []).length === 0 &&
        (payload.expense_lines ?? []).length === 2 &&
        typeof payload.memo === "string" &&
        !payload.memo.includes(" / "),
      JSON.stringify({
        po_id: payload.po_id,
        po_txn_id: payload.po_txn_id,
        items: (payload.item_lines ?? []).length,
        expenses: (payload.expense_lines ?? []).length,
        memo: payload.memo,
      })
    );
    const chainRow = await db.query(
      `SELECT purchase_order_id FROM qb_purchase_dependency_chain
        WHERE purchase_order_id = $1`,
      [bill.id]
    );
    const addOp = await db.query(
      `SELECT id, order_id, step, status, depends_on FROM qb_order_pipeline
        WHERE reference_id = $1 AND step = 'vendor_bill_add'`,
      [bill.id]
    );
    check(
      "cadena de dependencias keyeada por el BILL id (no un PO)",
      chainRow.rows.length === 1 &&
        addOp.rows.length === 1 &&
        addOp.rows[0].order_id === bill.id &&
        addOp.rows[0].depends_on === null &&
        addOp.rows[0].status === "pending",
      JSON.stringify(addOp.rows[0] ?? {})
    );

    // 7 — un service SIN PO lo ACEPTA el ADD (comisión de venta / subcontrato)
    //
    // Esta aserción decía lo contrario y estaba ROJA desde el 2026-08-31:
    // `bdfbecaf` generalizó la regla a "sólo un regular exige PO" y no la
    // actualizó. Un check que afirma la regla vieja no es neutro — le enseña
    // al próximo lector justo lo que causó el bug de VB-1146.
    //
    // Y lleva UNA LÍNEA a propósito: sin líneas el Add rechaza por
    // "bill has no lines to send", que es otra valla. Un fixture que muere en
    // la valla anterior no mide la que el check dice medir — así este check
    // seguía "rojo por el motivo correcto" sin probar nada.
    const svcNoPoId = randomUUID();
    billIds.push(svcNoPoId);
    await db.query(
      `INSERT INTO vendor_bill (id, status, bill_type, number, reference_id,
          vendor_id, vendor_qb_list_id_snapshot, vendor_name_snapshot,
          document_date, created_at, updated_at)
       VALUES ($1, 'confirmed', 'service', $2, $3, $4, $5, 'Expense E2E',
               NOW(), NOW(), NOW())`,
      [svcNoPoId, `VB-E2E-SVC-${n}`, `REF-SVC-NOPO-${n}`, f.vendorId, f.vendorQbListId]
    );
    await db.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, qb_account_full_name,
          qb_account_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, 'Office Supplies E2E', 'Expense',
               'Office Supplies E2E', 'sales commission', 1, 24500, 24500,
               NOW(), NOW())`,
      [`vbl_${randomUUID().replace(/-/g, "")}`, svcNoPoId, f.expenseAccountId]
    );
    const svcAdd = await enqueueQbVendorBillAdd(knexLike as never, svcNoPoId);
    check(
      "un service SIN PO lo acepta el ADD — sólo un regular exige PO",
      (svcAdd as { queued: boolean }).queued === true,
      `reason=${(svcAdd as { reason?: string }).reason}`
    );

    // 8 — MOD tras sync: encola y queda DETRÁS del ADD en la misma cadena
    await db.query(
      `UPDATE vendor_bill SET qb_txn_id = $2, qb_edit_sequence = '1'
        WHERE id = $1`,
      [bill.id, `TXN-EXP-${n}`]
    );
    await db.query(
      `UPDATE qb_vendor_bill_pipeline SET status = 'synced' WHERE vendor_bill_id = $1`,
      [bill.id]
    );
    const { enqueueVendorBillModSingle } = await import(
      "../../lib/purchase-orders/qb-vendor-bill-mod-enqueue"
    );
    const modRes = await enqueueVendorBillModSingle(knexLike as never, bill.id);
    check(
      "MOD single: queued sin PO",
      (modRes as { queued: boolean }).queued === true,
      `reason=${(modRes as { reason?: string }).reason}`
    );
    const modOp = await db.query(
      `SELECT order_id, depends_on, status FROM qb_order_pipeline
        WHERE reference_id = $1 AND step = 'vendor_bill_mod'`,
      [bill.id]
    );
    check(
      "el MOD depende del ADD en la cadena del propio bill (Add → Mod serial)",
      modOp.rows.length === 1 &&
        modOp.rows[0].order_id === bill.id &&
        // addOp guarded: if the ADD never queued (the very defect this suite
        // hunts), this check must go RED, not throw away the ones already run.
        modOp.rows[0].depends_on === (addOp.rows[0]?.id ?? "MISSING-ADD") &&
        modOp.rows[0].status === "waiting",
      JSON.stringify(modOp.rows[0] ?? {})
    );
  } finally {
    await cleanup(db, f, billIds);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
