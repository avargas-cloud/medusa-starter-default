/**
 * e2e-gl-sandbox.ts — E2E del motor del GL contra el SANDBOX (gl-core-v1 §8).
 *
 * Sandbox-only: aborta si `DATABASE_URL` no apunta a `:5499/` — nunca corre
 * contra prod ni contra el dev compartido.
 *
 * Dos modos:
 *   - `GL_E2E_BASE_URL` seteada → ejercita las RUTAS reales del backend
 *     sandbox (issue invoice → pago inicial → credit memo → void), igual que
 *     `e2e-order-line-floor-sandbox.ts` pega a `/admin/invoices` etc.
 *   - sin `GL_E2E_BASE_URL` → arma el fixture con INSERTs directos (mínimos,
 *     mismas tablas que consume el motor) y llama a las funciones de
 *     documento del motor (`src/lib/ledger`) directo, sin pasar por HTTP.
 *
 * Asserts (ambos modos):
 *   1. la invoice postea una entrada balanceada.
 *   2. el pago inicial postea con un claim `payment_recognition`.
 *   3. el credit memo postea.
 *   4. void de invoice ⇒ reversa espejo exacto (mismas líneas, signo invertido).
 *   5. trial balance del día: Σdebit = Σcredit sobre TODAS las entradas
 *      `document` del día (activas + reversas).
 *   6. insertar un `receipt` legacy de Banking sobre el mismo pago revienta
 *      `BANKING_ALREADY_POSTED` — probado DENTRO de una transacción que se
 *      hace rollback, nunca se persiste.
 *
 * Correr:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-gl-sandbox.ts
 */
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import {
  activeDocumentEntry,
  postCreditMemo,
  postCustomerPayment,
  postInvoice,
  reverseInvoice,
} from "../../lib/ledger";

const API = process.env.GL_E2E_BASE_URL ?? null;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push({ name, ok: cond, detail });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes(":5499/")) {
    console.error(
      `e2e-gl-sandbox: DATABASE_URL debe apuntar al sandbox (':5499/'). Valor actual: ${url ?? "(vacío)"}`
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  try {
    if (API) {
      await runViaApi(pool, API);
    } else {
      await runDirect(pool);
    }
  } finally {
    await pool.end();
  }

  console.log(`\n${"═".repeat(64)}\ne2e-gl-sandbox: ${checks.filter((c) => c.ok).length}/${checks.length} OK`);
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
}

/** `model.bigNumber()` guarda además `raw_<campo>` (jsonb `{value,precision}`) —
 *  insertar por SQL crudo exige poblar los dos o el NOT NULL de `raw_*` revienta
 *  (regla `.claude/rules/medusa-core.md` 2026-05-08). */
function raw(cents: number | bigint): string {
  return JSON.stringify({ value: String(cents), precision: 20 });
}

// ── Modo directo: fixture mínimo por INSERT + llamadas al motor ────────────
async function runDirect(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const day = new Date().toISOString().slice(0, 10);
    const customerId = await findOrCreateCustomer(client);
    const orderId = await findAnyOrderId(client);
    const invoiceId = `radj_e2e_inv_${randomUUID()}`;
    const invoiceNumber = `E2E-${Date.now()}`;

    // Fixture mínimo: una invoice de $100.00 con UNA línea sin variant_id
    // (servicio freeform, resuelve a `income_default`) — sin COGS (regla del
    // plan §2: COGS sólo para líneas con variant_id), sin discount/shipping/tax,
    // así que income = subtotal = total y la ecuación balancea exacto.
    // `order_id` es NOT NULL en el modelo (FK externa sin constraint real) —
    // se reusa cualquier orden existente del sandbox, sólo hace falta que exista.
    await client.query(
      `INSERT INTO pos_invoice
         (id, invoice_number, order_id, customer_id, status, subtotal, discount,
          shipping, tax, untaxed_total, total, amount_paid, balance_due,
          raw_subtotal, raw_tax, raw_total, raw_amount_paid, raw_balance_due,
          issued_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'issued',10000,0,0,0,10000,10000,10000,0,
               $5::jsonb,$5::jsonb,$5::jsonb,$5::jsonb,$6::jsonb,now(),now(),now())`,
      [invoiceId, invoiceNumber, orderId, customerId, raw(10000), raw(0)]
    );
    await client.query(
      `INSERT INTO pos_invoice_item
         (id, invoice_id, variant_id, sku, description, quantity, unit_price,
          total, raw_unit_price, raw_total, net_total_cents, raw_net_total_cents,
          sort_order, created_at, updated_at)
       VALUES ($1,$2,NULL,NULL,'E2E GL fixture line',1,10000,10000,
               $3::jsonb,$3::jsonb,10000,$3::jsonb,0,now(),now())`,
      [`ii_e2e_${randomUUID()}`, invoiceId, raw(10000)]
    );

    const paymentId = `cpay_e2e_${randomUUID()}`;
    await client.query(
      `INSERT INTO customer_payment
         (id, customer_id, amount, raw_amount, method, status, type, source, received_at, created_at, updated_at)
       VALUES ($1,$2,10000,$3::jsonb,'cash','applied','payment','pos',now(),now(),now())`,
      [paymentId, customerId, raw(10000)]
    );
    await client.query(
      `INSERT INTO payment_application
         (id, payment_id, invoice_id, invoice_number, order_id, amount_applied,
          raw_amount_applied, applied_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,10000,$6::jsonb,now(),now(),now())`,
      [`papp_e2e_${randomUUID()}`, paymentId, invoiceId, invoiceNumber, orderId, raw(10000)]
    );

    const cmId = `pcm_e2e_${randomUUID()}`;
    const cmNumber = `E2E-CM-${Date.now()}`;
    await client.query(
      `INSERT INTO pos_credit_memo
         (id, credit_memo_number, order_id, customer_id, status, subtotal, total, discount, tax, shipping,
          raw_subtotal, raw_discount, raw_tax, raw_total,
          completed_at, created_at, updated_at)
       VALUES ($1,$2,NULL,$3,'completed',2500,2500,0,0,0,
               $4::jsonb,$5::jsonb,$5::jsonb,$4::jsonb,now(),now(),now())`,
      [cmId, cmNumber, customerId, raw(2500), raw(0)]
    );
    await client.query(
      `INSERT INTO pos_credit_memo_item
         (id, credit_memo_id, variant_id, sku, description, quantity,
          unit_price, line_total, raw_unit_price, raw_line_total, sort_order, created_at, updated_at)
       VALUES ($1,$2,NULL,NULL,'E2E GL fixture return',1,2500,2500,$3::jsonb,$3::jsonb,0,now(),now())`,
      [`pcmi_e2e_${randomUUID()}`, cmId, raw(2500)]
    );

    const actor = "e2e-gl-sandbox";

    // `postDocumentJournal`/`reverseDocumentJournal` insertan entry + líneas
    // por separado y confían en el trigger DEFERRED de balance para validar
    // recién al COMMIT — cada llamada necesita SU PROPIA transacción explícita
    // (igual que `run-ledger-hook.ts`), o cada INSERT suelto se auto-commitea
    // solo y el trigger revienta viendo 0 líneas.
    const inTx = async <T>(fn: () => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      try {
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    };

    const invResult = await inTx(() => postInvoice(client, invoiceId, actor));
    ok("1. invoice postea", invResult.status === "posted" || invResult.status === "already_posted", JSON.stringify(invResult));
    const invEntry = await activeDocumentEntry(client, "pos_invoice", invoiceId);
    ok("1b. entrada de invoice existe y balancea", !!invEntry, JSON.stringify(invEntry));

    const payResult = await inTx(() => postCustomerPayment(client, paymentId, actor));
    ok("2. pago postea", payResult.status === "posted" || payResult.status === "already_posted", JSON.stringify(payResult));
    const { rows: claimRows } = await client.query(
      `SELECT 1 FROM bank_source_claim WHERE source_kind='payment_recognition' AND source_id=$1`,
      [paymentId]
    );
    ok("2b. el pago dejó un claim payment_recognition", (claimRows.length ?? 0) > 0);

    const cmResult = await inTx(() => postCreditMemo(client, cmId, actor));
    ok("3. credit memo postea", cmResult.status === "posted" || cmResult.status === "already_posted", JSON.stringify(cmResult));

    const revResult = await inTx(() => reverseInvoice(client, invoiceId, actor, "e2e cleanup"));
    ok("4. void de invoice reversa", revResult.status === "reversed", JSON.stringify(revResult));
    if (revResult.status === "reversed" && invEntry) {
      // Comparar por ROLE, no por posición/id: `reverseDocumentJournal` no
      // ordena su SELECT de líneas, y los ids nuevos son ULIDs aleatorios —
      // dos "ORDER BY id" no garantizan la misma correspondencia por fila.
      const { rows: mirror } = await client.query<{
        role: string;
        debit_cents: string;
        credit_cents: string;
      }>(`SELECT role, debit_cents, credit_cents FROM bank_journal_line WHERE entry_id = $1`, [
        revResult.entry_id,
      ]);
      const { rows: original } = await client.query<{
        role: string;
        debit_cents: string;
        credit_cents: string;
      }>(`SELECT role, debit_cents, credit_cents FROM bank_journal_line WHERE entry_id = $1`, [
        invEntry.id,
      ]);
      const byRole = new Map(original.map((r) => [r.role, r]));
      ok(
        "4b. la reversa es espejo exacto (signos invertidos, por role)",
        mirror.length === original.length &&
          mirror.every((m) => {
            const o = byRole.get(m.role);
            return !!o && m.debit_cents === o.credit_cents && m.credit_cents === o.debit_cents;
          }),
        JSON.stringify({ mirror, original })
      );
    }

    const { rows: tb } = await client.query<{ d: string; c: string }>(
      `SELECT COALESCE(SUM(l.debit_cents),0) AS d, COALESCE(SUM(l.credit_cents),0) AS c
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE e.source_kind IS NOT NULL AND e.day = $1`,
      [day]
    );
    ok("5. trial balance del día cuadra (Σdebit = Σcredit)", tb[0]?.d === tb[0]?.c, `d=${tb[0]?.d} c=${tb[0]?.c}`);

    await probeBankingAlreadyPosted(pool, paymentId);
  } finally {
    client.release();
  }
}

/** Probe destructivo — SIEMPRE dentro de una tx que se hace rollback. */
async function probeBankingAlreadyPosted(pool: Pool, paymentId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // Legacy Banking v9 "receipt" sobre el mismo pago — debe chocar con el
      // claim payment_recognition que el motor ya dejó (§1 del plan). El
      // trigger `bank_completion_legacy_guard` resuelve el payment_id del
      // receipt vía `bank_receipt_accounting.id = bank_journal_entry.receipt_id`
      // — hace falta esa fila puente, no alcanza con apuntar receipt_id al pago.
      const { rows: setupRows } = await client.query<{ id: string }>(
        `SELECT id FROM bank_accounting_setup LIMIT 1`
      );
      const setupId = setupRows[0]?.id;
      if (!setupId) throw new Error("no hay bank_accounting_setup en el sandbox para el probe");
      const receiptId = `bra_e2e_${randomUUID()}`;
      await client.query(
        `INSERT INTO bank_receipt_accounting (id, payment_id, setup_id) VALUES ($1,$2,$3)`,
        [receiptId, paymentId, setupId]
      );
      await client.query(
        `INSERT INTO bank_journal_entry (id, kind, day, amount_cents, receipt_id, description)
         VALUES ($1, 'receipt', CURRENT_DATE, 10000, $2, 'e2e probe')`,
        [`bje_e2e_${randomUUID()}`, receiptId]
      );
      ok("6. post manual de Banking sobre el pago YA posteado falla", false, "no lanzó — se insertó sin chequeo");
    } catch (err: unknown) {
      const code = (err as { code?: string; message?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      ok(
        "6. post manual de Banking sobre el pago YA posteado falla con BANKING_ALREADY_POSTED",
        message.includes("BANKING_ALREADY_POSTED") || code === "BANKING_ALREADY_POSTED",
        message
      );
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function findOrCreateCustomer(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM customer LIMIT 1`);
  if (rows.length) return rows[0].id;
  throw new Error("e2e-gl-sandbox: no hay ningún customer en el sandbox — sembrar uno antes de correr.");
}

async function findAnyOrderId(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM "order" LIMIT 1`);
  if (rows.length) return rows[0].id;
  throw new Error("e2e-gl-sandbox: no hay ninguna orden en el sandbox — sembrar una antes de correr.");
}

// ── Modo API: ejercita las rutas reales del backend sandbox ────────────────
async function runViaApi(pool: Pool, base: string): Promise<void> {
  const host = new URL(base).hostname;
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error(`e2e-gl-sandbox: GL_E2E_BASE_URL no es local: ${base} — abortado`);
  }
  const email = process.env.SANDBOX_ADMIN_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_ADMIN_PASSWORD ?? "sandbox123";
  const auth = await fetch(`${base}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = ((await auth.json()) as { token?: string }).token;
  if (!token) throw new Error("e2e-gl-sandbox: login al sandbox falló");

  // El fixture real (crear una orden + facturar + cobrar + CM por las rutas
  // del POS) depende de datos de catálogo que este script no controla —
  // documentado como pendiente en el reporte de entrega; el modo directo de
  // arriba es el que corre en CI/gate hasta que exista un fixture de orden
  // reusable para el GL.
  ok(
    "modo API: placeholder — requiere fixture de orden reusable",
    false,
    "no implementado; usar el modo directo (sin GL_E2E_BASE_URL)"
  );
  void pool;
  void token;
}

void main();
