/**
 * e2e-gl-documents-qb-sandbox — el carril "documentos GL bancarios →
 * QuickBooks" de punta a punta contra Postgres REAL y el backend del sandbox
 * (plan gl-docs-to-qb-20260914).
 *
 * Qué ejercita (cada sección con su evidencia):
 *   1. gl_check (gasto, payee libre)   → CheckAddRq            → confirmed, TxnID en el doc
 *   2. gl_check (tarjeta, vendor real)  → CreditCardChargeAddRq → confirmed
 *   3. gl_transfer sin fee / con fee    → JournalEntryAddRq 2 / 3 líneas
 *   4. gl_journal_entry                 → JournalEntryAddRq
 *   5. bank_deposit (cobro + manual UF + fee) → documento GL → DepositAddRq con PaymentTxnID; reverse → TxnVoid Deposit
 *   6. void de un cheque confirmado     → TxnVoidRq Check → qb_txn_id limpio
 *   7. carrera void-in-flight: se anula ENTRE el submit y el confirm → el confirm encola el void
 *   8. void antes de despachar          → el ADD queda `skipped`, sin fila de void
 *   9. cuenta creada en el POS (pos_)   → ADD `failed` estructural, el GL igual postea
 *  10. deposit con partida de apertura  → facts `skip`
 *  11. CONTROLES: bridge caído → failed terminal · resultado desconocido → failed terminal
 *      (sin next_retry_at) · rechazo de QB (3140) → failed terminal
 *  12. importador: loadPosKnownTxnIds ve los TxnIDs vivos Y los anulados; classify → skip
 *  13. negativas: ninguna fila gl_document_* para documentos qb_import/opening
 *  14. other_name (qb-other-names-picker-20260916): línea de JE → EntityRef con el
 *      ListID de qb_other_name · cheque → PayeeEntityRef · nombre desde la tabla ·
 *      negativas (A/R estructural, sin id 400, id desconocido 400)
 *  15. revise en el lugar (check-revise-20260918): reversa en el día original + re-post
 *      + CheckModRq con EditSequence FRESCO (el guardado se corrompe a propósito) ·
 *      dos revises seguidos → un solo Mod (coalesce) · Bank↔Card 400 · mes cerrado
 *      409 · Add sin enviar → superseded + Add nuevo · Add en vuelo → Mod diferido ·
 *      rechazo de QB → failed sin tocar el link · draft 409 · sin motivo 400
 *
 * Los pasos de dispatch/confirm llaman a las funciones REALES del
 * consolidator (`resubmitByStep`, `pollSubmittedRows`) contra el stub bridge
 * (`_stub-qb-bridge.ts`, direct-query con atributos bajo `$` como el bridge
 * vivo). Las filas se reclaman por id (no `runPendingDispatchPass`, que
 * tomaría cualquier fila pendiente del clon).
 *
 * SAFETY: DATABASE_URL debe apuntar a :5499; el backend HTTP a un puerto
 * local. Fixtures con memo `e2e_gldq_`; la limpieza borra por id.
 *
 * Run (backend sandbox :9096 arriba sobre la misma DB):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/<db> \
 *       E2E_BACKEND_URL=http://localhost:9096 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-gl-documents-qb-sandbox.ts
 */
import type { Server } from "http";
import { Client } from "pg";

import { startStubBridge, type StubState } from "./_stub-qb-bridge";
import { WRITE, SALES_SQL } from "../../lib/quickbooks/pipeline-status";

const PREFIX = "e2e_gldq_";
const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9096";
const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 19998);
const CLOSED_PORT_URL = "http://127.0.0.1:19999";
const JOURNAL = `/tmp/${PREFIX}stub-bridge.jsonl`;

// Cuentas reales del espejo qb_account (clon de prod).
const CHASE = "80000006-1317847775"; // Bank
const WELLS = "800000D9-1407447141"; // Bank
const VISA_7704 = "8000010B-1512513344"; // CreditCard
const BANK_FEES = "80000015-1317847948"; // Expense: Bank Service Charges
const UF = "80000048-1331156691"; // Undeposited Funds
const PETTY = "80000045-1330711003"; // Bank, NOT mapped to any Plaid account (uq_bank_account_active_qb)

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const logger = {
  info: (m: string) => console.log(`   [log] ${m}`),
  warn: (m: string) => console.log(`   [warn] ${m}`),
  error: (m: string) => console.log(`   [err] ${m}`),
};
const stubContainer = { resolve: () => ({}) } as never;

type Row = {
  id: string;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  step: string;
  status: string;
  bridge_op_id: string | null;
  retry_count: number;
  qb_txn_id: string | null;
  next_retry_at: Date | null;
  error: string | null;
  payload: Record<string, unknown> | null;
};

let token = "";
async function api<T = any>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
let ikey = 0;
const idem = (): Record<string, string> => ({ "idempotency-key": `${PREFIX}${Date.now()}-${++ikey}` });

async function login(): Promise<void> {
  const res = await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: process.env.E2E_EMAIL ?? "sandbox@test.com", password: process.env.E2E_PASSWORD ?? "sandbox123" }),
  });
  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error(`login failed (${res.status})`);
  token = j.token;
}

async function rowsFor(client: Client, refId: string, step?: string): Promise<Row[]> {
  const r = await client.query<Row>(
    `SELECT id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count,
            qb_txn_id, next_retry_at, error, payload
       FROM qb_order_pipeline WHERE reference_id = $1 ${step ? "AND step = $2" : ""} ORDER BY created_at ASC`,
    step ? [refId, step] : [refId]
  );
  return r.rows;
}
async function claim(client: Client, id: string): Promise<Row> {
  const r = await client.query<Row>(
    `UPDATE qb_order_pipeline SET status='${WRITE.sales.processing}', updated_at=NOW(), error=NULL WHERE id=$1
     RETURNING id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count, qb_txn_id, next_retry_at, error, payload`,
    [id]
  );
  return r.rows[0]!;
}
async function wake(client: Client, id: string): Promise<void> {
  await client.query(`UPDATE qb_order_pipeline SET status='${WRITE.sales.dispatchable}', updated_at=NOW() WHERE id=$1 AND status IN (${SALES_SQL.blocked})`, [id]);
}
async function rowById(client: Client, id: string): Promise<Row> {
  const r = await client.query<Row>(
    `SELECT id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count,
            qb_txn_id, next_retry_at, error, payload FROM qb_order_pipeline WHERE id=$1`,
    [id]
  );
  return r.rows[0]!;
}
async function docLink(client: Client, table: string, id: string): Promise<{ status: string; qb_txn_id: string | null; qb_txn_type: string | null }> {
  const r = await client.query(`SELECT status, qb_txn_id, qb_txn_type FROM ${table} WHERE id=$1`, [id]);
  return r.rows[0];
}

/** Dispatch + confirm de UNA fila, con las funciones reales del consolidator. */
async function dispatchAndConfirm(client: Client, rowId: string, opts: { confirm?: boolean } = {}): Promise<Row> {
  const { resubmitByStep } = await import("../../lib/quickbooks/consolidator/resubmit-by-step");
  const { pollSubmittedRows } = await import("../../lib/quickbooks/consolidator/poll-submitted-rows");
  await wake(client, rowId);
  const claimed = await claim(client, rowId);
  await resubmitByStep(claimed, stubContainer, logger);
  let after = await rowById(client, rowId);
  if (opts.confirm !== false && after.status === WRITE.sales.submitted && after.bridge_op_id) {
    await pollSubmittedRows([{ ...after, bridge_op_id: after.bridge_op_id }], stubContainer, logger);
    after = await rowById(client, rowId);
  }
  return after;
}

function lastJournal(kind: string): Record<string, any> | null {
  const fs = require("fs") as typeof import("fs");
  const lines = fs.readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return [...lines].reverse().find((l) => l.event === "direct_query" && (!kind || l.rqName === kind || (kind === "TxnVoid" && l.isVoid))) ?? null;
}


/** El clon puede no tener ningún cobro sin depositar (la adopción de QuickBooks
 * los consume todos): se libera UNO revirtiendo el depósito adoptado que lo
 * contiene (`adopt-qb-deposits --revert`), que es exactamente el estado de
 * un cobro nuevo antes de su depósito. */
async function freeReceipt(client: Client, methods: string[], extraSql = ""): Promise<void> {
  const held = (await client.query<{ txn: string }>(
    `SELECT d.qb_txn_id AS txn FROM bank_deposit d JOIN bank_deposit_line dl ON dl.deposit_id=d.id AND dl.deleted_at IS NULL
       JOIN customer_payment cp ON cp.id=dl.payment_id
      WHERE d.created_by='adopt-qb-deposits' AND d.status='ready' AND cp.method = ANY($1::text[]) AND cp.status IN ('available','partially_applied','applied')
        AND COALESCE(cp.qb->>'txn_id', cp.metadata->>'qb_txn_id') IS NOT NULL AND COALESCE(cp.metadata->>'qb_source','') <> 'sales_receipt'
        AND EXISTS (SELECT 1 FROM bank_journal_entry e WHERE e.source_kind='customer_payment' AND e.source_id=cp.id AND e.kind='document' AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
        AND NOT EXISTS (SELECT 1 FROM bank_statement s WHERE s.account_list_id=d.account_list_id AND s.status='closed' AND d.deposit_date BETWEEN s.from_day AND s.to_day)
        ${extraSql}
      ORDER BY d.deposit_date DESC LIMIT 1`, [methods])).rows[0];
  if (!held) return;
  const r = (await import("node:child_process")).spawnSync("./node_modules/.bin/tsx", ["src/scripts/ledger/adopt-qb-deposits.ts", "--cache", process.env.E2E_QB_CACHE ?? ".qb-docs-cache", "--revert", "--txn", held.txn, "--apply"], { encoding: "utf8", env: { ...process.env, DISABLE_SCHEDULED_JOBS: "true" } });
  console.log(`   [fixture] freed a ${methods.join("/")} receipt by reverting adopted deposit ${held.txn} (exit ${r.status})`);
}

async function seedSandboxBank(client: Client): Promise<{ accountId: string }> {
  const connId = `bconn_${PREFIX}conn`;
  const accountId = `bacct_${PREFIX}acct`;
  await client.query(
    `INSERT INTO bank_connection (id, provider, environment, provider_item_id, status, institution_name, initial_sync_complete, historical_sync_complete)
     VALUES ($1,'plaid','sandbox',$2,'active','E2E Bank',true,true) ON CONFLICT (id) DO NOTHING`,
    [connId, `${PREFIX}item`]
  );
  await client.query(
    `INSERT INTO bank_account (id, connection_id, provider_account_id, name, type, subtype, currency, qb_list_id, is_active, is_selected, review_start_date)
     VALUES ($1,$2,$3,'E2E Checking','depository','checking','USD',$4,true,true,'2025-12-31') ON CONFLICT (id) DO NOTHING`,
    [accountId, connId, `${PREFIX}acct`, PETTY]
  );
  return { accountId };
}

async function cleanup(client: Client): Promise<void> {
  const docs = await client.query<{ id: string }>(
    `SELECT id FROM gl_check WHERE memo LIKE $1 UNION SELECT id FROM gl_transfer WHERE memo LIKE $1
     UNION SELECT id FROM gl_journal_entry WHERE memo LIKE $1 UNION SELECT id FROM bank_deposit WHERE reference LIKE $1`,
    [`${PREFIX}%`]
  );
  const ids = docs.rows.map((r) => r.id);
  if (ids.length) {
    await client.query(`DELETE FROM qb_order_pipeline WHERE reference_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = ANY($1::text[])`, [ids]);
    // Asientos del libro creados por los fixtures (documento + reversal + líneas).
    await client.query(
      `DELETE FROM bank_journal_line WHERE entry_id IN (SELECT id FROM bank_journal_entry WHERE source_id = ANY($1::text[]) OR deposit_id = ANY($1::text[])
         OR reverses_entry_id IN (SELECT id FROM bank_journal_entry WHERE source_id = ANY($1::text[]) OR deposit_id = ANY($1::text[])))`,
      [ids]
    ).catch(() => undefined); // BANKING_JOURNAL_IMMUTABLE: los asientos del libro no se borran — quedan en el sandbox
    await client.query(`DELETE FROM bank_receipt_consumption WHERE entry_id IN (SELECT id FROM bank_journal_entry WHERE deposit_id = ANY($1::text[]))`, [ids]).catch(() => undefined);
    await client.query(
      `DELETE FROM bank_journal_entry WHERE reverses_entry_id IN (SELECT id FROM bank_journal_entry WHERE source_id = ANY($1::text[]) OR deposit_id = ANY($1::text[]))`,
      [ids]
    ).catch(() => undefined);
    await client.query(`DELETE FROM bank_journal_entry WHERE source_id = ANY($1::text[]) OR deposit_id = ANY($1::text[])`, [ids]).catch(() => undefined);
    await client.query(`DELETE FROM gl_check_line WHERE check_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM gl_check WHERE id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM gl_transfer WHERE id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM gl_journal_entry_line WHERE journal_entry_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM gl_journal_entry WHERE id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM bank_deposit_line WHERE deposit_id = ANY($1::text[])`, [ids]);
    await client.query(`DELETE FROM bank_deposit WHERE id = ANY($1::text[])`, [ids]);
  }
  // Sólo los eventos de LOS depósitos de este E2E: `entity_id LIKE 'bdep_%'` borraba
  // los de todos (incluidos los de la adopción de QuickBooks del clon).
  await client.query(`DELETE FROM bank_review_event WHERE idempotency_key LIKE $1 OR (entity_type='deposit' AND entity_id = ANY($2::text[]))`, [`${PREFIX}%`, ids]).catch(() => undefined);
  await client.query(`DELETE FROM qb_account WHERE qb_list_id = $1`, [`pos_${PREFIX}exp`]);
  await client.query(`DELETE FROM qb_other_name WHERE id = $1`, [`qbon_${PREFIX}on`]).catch(() => undefined);
  await client.query(`DELETE FROM bank_account WHERE id = $1`, [`bacct_${PREFIX}acct`]);
  await client.query(`DELETE FROM bank_connection WHERE id = $1`, [`bconn_${PREFIX}conn`]);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!connectionString.includes(":5499/")) throw new Error("Refusing to run: DATABASE_URL is not sandbox Postgres (:5499)");
  process.env.QB_API_KEY = process.env.QB_API_KEY ?? "e2e-stub";
  delete process.env.QB_SYNC_ENABLED;

  const client = new Client({ connectionString });
  await client.connect();
  let server: Server | undefined;
  let state: StubState | undefined;
  try {
    await login();
    await cleanup(client);
    ({ server, state } = await startStubBridge(STUB_PORT, JOURNAL));
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${STUB_PORT}`;
    const { loadPosKnownTxnIds } = await import("../../lib/ledger/qb-import/pos-links");
    const { classify } = await import("../../lib/ledger/qb-import/classify");
    const { loadGlDocumentAddFacts } = await import("../../lib/quickbooks/gl-documents/facts");
    const txnIdsSeen: string[] = [];

    // ── 1 · gl_check gasto, payee libre ────────────────────────────────────
    console.log("\n── 1. gl_check (expense, payee 'other') → CheckAddRq");
    const c1 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-10", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber",
      memo: `${PREFIX}uber · viaje`, lines: [{ account_list_id: BANK_FEES, amount_cents: 615, memo: "ride" }], post: true,
    });
    assert(c1.status === 201 && c1.json.check?.status === "posted", "check created + posted", `HTTP ${c1.status}`);
    assert(c1.json.post?.qb?.queued === true && c1.json.post?.qb?.status === WRITE.sales.dispatchable, "post response carries qb: { queued, status: pending }", JSON.stringify(c1.json.post?.qb));
    const check1 = c1.json.check.id as string;
    let rows = await rowsFor(client, check1, "gl_document_add");
    assert(rows.length === 1 && rows[0]!.status === WRITE.sales.dispatchable && rows[0]!.reference_type === "gl_check", "exactly one gl_document_add row, pending, reference_type gl_check");
    const xml1 = String(rows[0]!.payload?.qbxml ?? "");
    assert(xml1.includes("<CheckAddRq><CheckAdd>") && xml1.includes("<Memo>Payee: Uber - e2e_gldq_uber - viaje</Memo>") && xml1.includes("<Amount>6.15</Amount>"), "payload QBXML: CheckAdd, payee in memo, ASCII folded, amount", xml1.slice(0, 200));
    const r1 = await dispatchAndConfirm(client, rows[0]!.id);
    assert(r1.status === WRITE.sales.synced && !!r1.qb_txn_id, "dispatch → submitted → poll → confirmed with TxnID", `${r1.status} ${r1.qb_txn_id}`);
    const j1 = lastJournal("Check");
    assert(!!j1 && /^[\x20-\x7E]*$/.test(String(j1.qbxml)), "the bridge received CheckAddRq in 7-bit ASCII");
    let link1 = await docLink(client, "gl_check", check1);
    assert(link1.qb_txn_id === r1.qb_txn_id && link1.qb_txn_type === "Check", "gl_check carries qb_txn_id + qb_txn_type=Check", JSON.stringify(link1));
    txnIdsSeen.push(r1.qb_txn_id!);

    // ── 2 · gl_check tarjeta, vendor con ListID ────────────────────────────
    console.log("\n── 2. gl_check (card_charge, vendor payee) → CreditCardChargeAddRq");
    const vendor = (await client.query<{ id: string; qb_list_id: string; full_name: string }>(
      `SELECT id, qb_list_id, full_name FROM qb_vendor WHERE deleted_at IS NULL AND qb_list_id NOT LIKE 'pending_%' AND qb_list_id IS NOT NULL ORDER BY id LIMIT 1`
    )).rows[0]!;
    const c2 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-06", bank_account_list_id: VISA_7704, number: "AUTH-9", payee_type: "vendor", payee_id: vendor.id, payee_name: vendor.full_name,
      memo: `${PREFIX}badudi`, lines: [{ account_list_id: BANK_FEES, amount_cents: 945 }], post: true,
    });
    const check2 = c2.json.check?.id as string;
    assert(c2.status === 201 && c2.json.check?.kind === "card_charge", "card charge created (kind derived from CreditCard account)", `HTTP ${c2.status} ${c2.json.check?.kind}`);
    rows = await rowsFor(client, check2, "gl_document_add");
    const xml2 = String(rows[0]?.payload?.qbxml ?? "");
    assert(xml2.includes("<CreditCardChargeAddRq>") && xml2.includes(`<PayeeEntityRef><ListID>${vendor.qb_list_id}</ListID></PayeeEntityRef>`) && xml2.indexOf("<TxnDate>") < xml2.indexOf("<RefNumber>"), "CreditCardChargeAdd with vendor ListID, TxnDate before RefNumber");
    const r2 = await dispatchAndConfirm(client, rows[0]!.id);
    const link2 = await docLink(client, "gl_check", check2);
    assert(r2.status === WRITE.sales.synced && link2.qb_txn_type === "CreditCardCharge", "confirmed as CreditCardCharge", `${r2.status} ${link2.qb_txn_type}`);
    txnIdsSeen.push(r2.qb_txn_id!);

    // ── 3 · transfers ──────────────────────────────────────────────────────
    console.log("\n── 3. gl_transfer sin fee / con fee → JournalEntryAddRq");
    const t1 = await api("POST", "/admin/accounting/transfers", { day: "2026-09-01", from_account_list_id: WELLS, to_account_list_id: CHASE, amount_cents: 100000, memo: `${PREFIX}wire`, post: true });
    const t2 = await api("POST", "/admin/accounting/transfers", { day: "2026-09-02", from_account_list_id: WELLS, to_account_list_id: CHASE, amount_cents: 100000, fee_cents: 1500, fee_account_list_id: BANK_FEES, memo: `${PREFIX}wire fee`, post: true });
    assert(t1.status === 201 && t2.status === 201, "two transfers created + posted", `${t1.status} ${t2.status}`);
    const tr1 = t1.json.transfer?.id ?? t1.json.id;
    const tr2 = t2.json.transfer?.id ?? t2.json.id;
    const xt1 = String((await rowsFor(client, tr1, "gl_document_add"))[0]?.payload?.qbxml ?? "");
    const xt2 = String((await rowsFor(client, tr2, "gl_document_add"))[0]?.payload?.qbxml ?? "");
    assert(xt1.includes("<JournalEntryAddRq>") && (xt1.match(/<JournalDebitLine>/g) ?? []).length === 1 && xt1.includes(`<JournalCreditLine><AccountRef><ListID>${WELLS}</ListID></AccountRef><Amount>1000.00</Amount>`), "transfer without fee = JE with 1 debit (to) + 1 credit (from)");
    assert((xt2.match(/<JournalDebitLine>/g) ?? []).length === 2 && xt2.includes("<Amount>985.00</Amount>") && xt2.includes("<Amount>15.00</Amount>") && xt2.includes("<Amount>1000.00</Amount>"), "transfer with fee = JE Dr to 985 · Dr fee 15 · Cr from 1000");
    const rt1 = await dispatchAndConfirm(client, (await rowsFor(client, tr1, "gl_document_add"))[0]!.id);
    const rt2 = await dispatchAndConfirm(client, (await rowsFor(client, tr2, "gl_document_add"))[0]!.id);
    const lt2 = await docLink(client, "gl_transfer", tr2);
    assert(rt1.status === WRITE.sales.synced && rt2.status === WRITE.sales.synced && lt2.qb_txn_type === "JournalEntry", "both transfers confirmed as JournalEntry");
    txnIdsSeen.push(rt1.qb_txn_id!, rt2.qb_txn_id!);

    // ── 4 · journal entry ──────────────────────────────────────────────────
    console.log("\n── 4. gl_journal_entry → JournalEntryAddRq");
    const je = await api("POST", "/admin/accounting/journal-entries", {
      day: "2026-09-03", memo: `${PREFIX}reclass`,
      lines: [{ account_list_id: BANK_FEES, debit_cents: 2500, memo: "fee reclass" }, { account_list_id: CHASE, credit_cents: 2500 }], post: true,
    });
    assert(je.status === 201, "journal entry created + posted", `HTTP ${je.status} ${JSON.stringify(je.json).slice(0, 120)}`);
    const jeId = je.json.journal_entry?.id ?? je.json.id;
    const rj = await dispatchAndConfirm(client, (await rowsFor(client, jeId, "gl_document_add"))[0]!.id);
    const lj = await docLink(client, "gl_journal_entry", jeId);
    assert(rj.status === WRITE.sales.synced && lj.qb_txn_type === "JournalEntry" && lj.qb_txn_id === rj.qb_txn_id, "JE confirmed, TxnID on the document");
    txnIdsSeen.push(rj.qb_txn_id!);

    // ── 5 · deposit ────────────────────────────────────────────────────────
    console.log("\n── 5. bank_deposit → GL document → DepositAddRq (PaymentTxnID + manual line + fee) → reverse → TxnVoid");
    const { accountId } = await seedSandboxBank(client);
    // Un cobro que el LIBRO ya reconoce (asiento customer_payment activo), con
    // TxnID en QB y procedencia que Banking admite (no sales receipt, no
    // qb_import): el candidato se elige por SQL y se pide por display_id, porque
    // el endpoint lista los 50 más VIEJOS.
    await freeReceipt(client, ["cash", "ach", "zelle", "check"], "AND cp.surcharge_cents IS NOT DISTINCT FROM 0");
    const pick = (await client.query<{ id: string; display_id: number; txn: string }>(
      `SELECT cp.id, cp.display_id, COALESCE(cp.qb->>'txn_id', cp.metadata->>'qb_txn_id') AS txn
         FROM customer_payment cp JOIN customer c ON c.id=cp.customer_id AND c.deleted_at IS NULL
        WHERE cp.deleted_at IS NULL AND cp.type='payment' AND cp.method IN ('cash','ach','zelle','check')
          AND cp.status IN ('available','partially_applied','applied') AND COALESCE(cp.metadata->>'qb_import','false')='false'
          AND COALESCE(cp.metadata->>'qb_source','') <> 'sales_receipt'
          AND COALESCE(cp.qb->>'txn_id', cp.metadata->>'qb_txn_id') IS NOT NULL
          AND EXISTS (SELECT 1 FROM bank_journal_entry e WHERE e.source_kind='customer_payment' AND e.source_id=cp.id AND e.kind='document'
                        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
          AND NOT EXISTS (SELECT 1 FROM bank_transaction_review dr WHERE dr.matched_payment_id=cp.id AND dr.status<>'excluded' AND dr.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM bank_deposit_line dl WHERE dl.payment_id=cp.id AND dl.deleted_at IS NULL)
        ORDER BY cp.received_at DESC LIMIT 1`
    )).rows[0];
    assert(!!pick, "a GL-recognised POS payment with a QuickBooks TxnID exists in the clone", JSON.stringify(pick));
    const cands = await api("GET", `/admin/banking/deposit-candidates?account_id=${accountId}&q=${pick?.display_id ?? ""}`);
    const candidate = (cands.json.candidates ?? []).find((c: any) => c.display_id === pick?.display_id);
    assert(!!candidate, "Banking offers it as a deposit candidate", JSON.stringify(cands.json).slice(0, 160));
    if (candidate) {
      // record-deposits-gl-20260915: la línea MANUAL (pre-cutover, contra
      // Undeposited Funds) vuelve — el CHECK y el guard de partidas ya la admiten.
      const save = await api("POST", "/admin/banking/deposits", {
        expected_revision: 0, account_id: accountId, date: "2026-09-14", reference: `${PREFIX}dep`, memo: "e2e deposit",
        fee_amount: "1.25", fee_account_list_id: BANK_FEES, fee_reference: "processor",
        lines: [
          { payment_id: candidate.id, amount: candidate.amount, expected_source_hash: candidate.source_hash },
          { payment_id: null, manual: true, reference: `${PREFIX}precut`, description: "pre-cutover check", amount: "40.00" },
        ],
      }, idem());
      const depositId: string = save.json.deposit?.id ?? "";
      assert(save.status === 200 && !!depositId, "deposit saved (draft) with a payment line AND a manual UF line", `HTTP ${save.status} ${JSON.stringify(save.json).slice(0, 160)}`);
      // Un save fallido ya cuenta como ❌; el resto de la sección leería `undefined` y
      // tumbaría la corrida entera (BANKING_DEPOSIT_SOURCE_STALE en el clon del 09/18).
      if (!depositId) console.log("   [skip] rest of §5 skipped: the deposit could not be saved in this clone");
      if (depositId) {
      assert(/^DEP-\d{4}$/.test(String(save.json.deposit?.number)) && save.json.deposit?.account_list_id === PETTY, "deposit carries its DEP-#### number and the deposit-to ListID", `${save.json.deposit?.number} ${save.json.deposit?.account_list_id}`);
      const ready = await api("POST", `/admin/banking/deposits/${depositId}/ready`, { expected_revision: save.json.deposit.revision, expected_source_hash: save.json.deposit.source_hash }, idem());
      assert(ready.status === 200 && ready.json.deposit?.status === "ready", "deposit ready", `HTTP ${ready.status} ${JSON.stringify(ready.json).slice(0, 120)}`);
      assert((await rowsFor(client, depositId, "gl_document_add")).length === 0, "READY does not enqueue: only the ledger posting does");
      const acct = await api("GET", `/admin/banking/accounting/deposits/${depositId}`);
      assert(acct.json.eligible === true && (acct.json.blockers ?? []).length === 0, "the GL-recognised payment is eligible evidence (no Banking receipt posting required)", JSON.stringify(acct.json.blockers));
      const preview = await api("POST", `/admin/banking/accounting/deposits/${depositId}/preview`, { expected_source_hash: acct.json.source_hash, fee_attested: true });
      const roles = (preview.json.lines ?? []).map((l: any) => `${l.role}:${l.debit_cents}/${l.credit_cents}`);
      assert(preview.status === 200 && (preview.json.lines ?? []).length === 4, "preview shows the GL document: Dr bank net, Dr fee, Cr payment (UF), Cr manual (UF)", roles.join(" "));
      const post = await api("POST", `/admin/banking/accounting/deposits/${depositId}/post`, { expected_source_hash: acct.json.source_hash, fee_attested: true, preview_hash: preview.json.preview_hash }, idem());
      assert(post.status === 200 && post.json.posting && !post.json.posting.reversed_by, "Post to ledger succeeds", `HTTP ${post.status} ${JSON.stringify(post.json).slice(0, 200)}`);
      const glDoc = (await client.query(`SELECT e.id, e.document_number, e.day, e.amount_cents::text, (SELECT count(*)::int FROM bank_journal_line l WHERE l.entry_id=e.id) AS n
        FROM bank_journal_entry e WHERE e.source_kind='bank_deposit' AND e.source_id=$1 AND e.kind='document'`, [depositId])).rows[0];
      assert(!!glDoc && glDoc.n === 4 && glDoc.document_number === save.json.deposit.number && glDoc.amount_cents === String(acct.json.source.amount_cents), "ledger holds ONE bank_deposit document (4 lines, amount = gross in CENTS) numbered like the deposit", JSON.stringify(glDoc));
      assert(roles.join(" ") === "bank:39078/0 expense:125/0 clearing:0/35203 clearing:0/4000" || roles.some((r: string) => r.startsWith("clearing:0/4000")), "preview amounts are cents of the 2-decimal deposit amounts (not truncated dollars)", roles.join(" "));
      assert((await client.query(`SELECT 1 FROM bank_journal_entry WHERE deposit_id=$1 OR (kind='deposit' AND source_id=$1)`, [depositId])).rowCount === 0, "no Banking-local deposit entry was written");
      let drows = await rowsFor(client, depositId, "gl_document_add");
      assert(drows.length === 1 && drows[0]!.status === WRITE.sales.dispatchable && drows[0]!.reference_type === "bank_deposit", "posting enqueued exactly one gl_document_add(bank_deposit)");
      const dx = String(drows[0]!.payload?.qbxml ?? "");
      assert(dx.includes(`<DepositToAccountRef><ListID>${PETTY}</ListID>`), "DepositAdd into the deposit-to account", dx.slice(0, 200));
      assert(dx.includes(`<DepositLineAdd><PaymentTxnID>${pick.txn}</PaymentTxnID></DepositLineAdd>`), "payment line references the payment's real QuickBooks TxnID", `txn=${pick.txn}`);
      assert(dx.includes(`<AccountRef><ListID>${UF}</ListID></AccountRef><Memo>pre-cutover check</Memo><Amount>40.00</Amount>`), "manual line goes to Undeposited Funds with its memo and amount");
      assert(dx.includes(`<AccountRef><ListID>${BANK_FEES}</ListID></AccountRef><Memo>Fee processor</Memo><Amount>-1.25</Amount>`), "fee is a negative line to the fee account");
      const rd = await dispatchAndConfirm(client, drows[0]!.id);
      const dlink = await docLink(client, "bank_deposit", depositId);
      assert(rd.status === WRITE.sales.synced && !!rd.qb_txn_id && dlink.qb_txn_id === rd.qb_txn_id && dlink.qb_txn_type === "Deposit", "DepositAdd confirmed; bank_deposit carries qb_txn_id + qb_txn_type=Deposit", JSON.stringify(dlink));
      txnIdsSeen.push(rd.qb_txn_id!);
      const listed = await api("GET", `/admin/banking/deposits?q=${PREFIX}dep`);
      const row = (listed.json.deposits ?? []).find((d: any) => d.id === depositId);
      assert(!!row && row.accounting_posted === true && row.qb_txn_id === rd.qb_txn_id && row.account_name === "Petty Cash", "Record Deposits lists it posted, synced, with the deposit-to account name", JSON.stringify(row).slice(0, 200));
      // Reverse → TxnVoid Deposit, y el documento queda sin TxnID.
      const rev = await api("POST", `/admin/banking/accounting/deposits/${depositId}/reverse`, { posting_id: post.json.posting.id, day: "2026-09-14", reason: `${PREFIX}reverse` }, idem());
      assert(rev.status === 200 && rev.json.posting?.reversed_by, "reverse of the deposit posting succeeds", `HTTP ${rev.status} ${JSON.stringify(rev.json).slice(0, 160)}`);
      const vrows = await rowsFor(client, depositId, "gl_document_void");
      assert(vrows.length === 1 && vrows[0]!.qb_txn_id === rd.qb_txn_id, "reverse enqueued one gl_document_void with the Deposit's TxnID");
      const rvd = await dispatchAndConfirm(client, vrows[0]!.id);
      const dlink2 = await docLink(client, "bank_deposit", depositId);
      assert(rvd.status === WRITE.sales.synced && dlink2.qb_txn_id === null, "TxnVoid confirmed; qb_txn_id cleared on the deposit", JSON.stringify(dlink2));
      assert(lastJournal("TxnVoid")?.qbxml?.includes("<TxnVoidType>Deposit</TxnVoidType>"), "the bridge received TxnVoidRq with TxnVoidType Deposit");
      // Void del depósito en el POS (ya reversado) → nada más que anular en QB.
      const cur = await api("GET", `/admin/banking/deposits/${depositId}`);
      const dvoid = await api("POST", `/admin/banking/deposits/${depositId}/void`, { expected_revision: cur.json.deposit.revision, reason: `${PREFIX}void` }, idem());
      assert(dvoid.status === 200 && (await rowsFor(client, depositId)).length === 2, "voiding the reversed deposit enqueues nothing new", `HTTP ${dvoid.status}`);
      }
    }

    // ── 6 · void de un cheque confirmado ───────────────────────────────────
    console.log("\n── 6. void of a confirmed check → TxnVoidRq Check");
    const v1 = await api("POST", `/admin/accounting/checks/${check1}/void`, { reason: `${PREFIX}void` });
    assert(v1.status === 200, "check voided in the POS", `HTTP ${v1.status}`);
    const vr = await rowsFor(client, check1, "gl_document_void");
    assert(vr.length === 1 && vr[0]!.qb_txn_id === r1.qb_txn_id, "one void row with the check's TxnID");
    const rv1 = await dispatchAndConfirm(client, vr[0]!.id);
    link1 = await docLink(client, "gl_check", check1);
    assert(rv1.status === WRITE.sales.synced && link1.status === "voided" /* entity-status */ && link1.qb_txn_id === null, "void confirmed; document voided with qb_txn_id cleared", JSON.stringify(link1));

    // ── 7 · carrera void-in-flight ─────────────────────────────────────────
    console.log("\n── 7. void while the Add is in flight (submitted, not yet confirmed)");
    const c7 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-11", bank_account_list_id: CHASE, payee_type: "other", payee_name: "Race", memo: `${PREFIX}race`,
      lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }], post: true,
    });
    const check7 = c7.json.check.id as string;
    const add7 = (await rowsFor(client, check7, "gl_document_add"))[0]!;
    const submitted7 = await dispatchAndConfirm(client, add7.id, { confirm: false });
    assert(submitted7.status === WRITE.sales.submitted, "Add submitted (not confirmed yet)", submitted7.status);
    const v7 = await api("POST", `/admin/accounting/checks/${check7}/void`, { reason: `${PREFIX}race-void` });
    assert(v7.status === 200 && (await rowsFor(client, check7, "gl_document_void")).length === 0, "void in the POS with the Add in flight enqueues NOTHING yet (no TxnID to name)");
    const { pollSubmittedRows } = await import("../../lib/quickbooks/consolidator/poll-submitted-rows");
    await pollSubmittedRows([{ ...submitted7, bridge_op_id: submitted7.bridge_op_id! }], stubContainer, logger);
    const add7After = await rowById(client, add7.id);
    const void7 = await rowsFor(client, check7, "gl_document_void");
    assert(add7After.status === WRITE.sales.synced && void7.length === 1 && void7[0]!.qb_txn_id === add7After.qb_txn_id, "confirming the Add of a voided document enqueues its void with the fresh TxnID", `${add7After.status} voids=${void7.length}`);
    const rv7 = await dispatchAndConfirm(client, void7[0]!.id);
    assert(rv7.status === WRITE.sales.synced && (await docLink(client, "gl_check", check7)).qb_txn_id === null, "race void dispatched, confirmed, TxnID cleared");
    txnIdsSeen.push(add7After.qb_txn_id!);

    // ── 8 · void antes de despachar ────────────────────────────────────────
    console.log("\n── 8. void before the Add is dispatched → Add skipped, no void row");
    const c8 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-12", bank_account_list_id: CHASE, payee_type: "other", payee_name: "Never", memo: `${PREFIX}never`,
      lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }], post: true,
    });
    const check8 = c8.json.check.id as string;
    await api("POST", `/admin/accounting/checks/${check8}/void`, { reason: `${PREFIX}never-void` });
    const rows8 = await rowsFor(client, check8);
    assert(rows8.length === 1 && rows8[0]!.step === "gl_document_add" && rows8[0]!.status === WRITE.sales.skipped, "Add row skipped with a reason, no void row", JSON.stringify(rows8.map((r) => [r.step, r.status])));

    // ── 9 · cuenta creada en el POS ────────────────────────────────────────
    console.log("\n── 9. line on a pos_ account → Add failed (structural), GL still posted");
    await client.query(
      `INSERT INTO qb_account (id, qb_list_id, full_name, name, account_type, is_active) VALUES ($1,$2,$3,$3,'Expense',true) ON CONFLICT DO NOTHING`,
      [`qbacct_${PREFIX}exp`, `pos_${PREFIX}exp`, `${PREFIX}POS-only expense`]
    );
    const c9 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-13", bank_account_list_id: CHASE, payee_type: "other", payee_name: "Local", memo: `${PREFIX}posacct`,
      lines: [{ account_list_id: `pos_${PREFIX}exp`, amount_cents: 100 }], post: true,
    });
    const check9 = c9.json.check?.id as string;
    const rows9 = check9 ? await rowsFor(client, check9, "gl_document_add") : [];
    assert(c9.status === 201 && c9.json.check?.status === "posted", "GL posting succeeds regardless of QuickBooks", `HTTP ${c9.status} ${JSON.stringify(c9.json).slice(0, 160)}`);
    assert(rows9.length === 1 && rows9[0]!.status === WRITE.sales.failed && rows9[0]!.next_retry_at === null && /account_not_in_quickbooks/.test(rows9[0]!.error ?? ""), "pipeline row failed terminal with account_not_in_quickbooks", JSON.stringify(rows9.map((r) => [r.status, r.error?.slice(0, 80)])));

    // ── 10 · deposit con partida de apertura → skip ────────────────────────
    console.log("\n── 10. deposit consuming an opening item → facts skip");
    // La línea con opening_item_id no se puede sembrar (el trigger
    // bank_opening_deposit_guard exige una partida adoptada real): se simula la
    // fila de línea sobre la MISMA consulta real de los facts.
    const openingStub = {
      raw: async (sql: string, b: unknown[] = []) => {
        if (sql.includes("FROM bank_deposit_line l")) {
          return { rows: [{ id: "bdl_sim", payment_id: null, opening_item_id: `${PREFIX}item`, manual_reference: null, manual_description: null, amount: "10.00", payment_qb_txn_id: null, payment_status: null }] };
        }
        let i = 0;
        const r = await client.query(sql.replace(/\?/g, () => `$${++i}`), b);
        return { rows: r.rows };
      },
    };
    const dep10 = (await client.query<{ id: string }>(`SELECT id FROM bank_deposit WHERE reference = $1 ORDER BY created_at DESC LIMIT 1`, [`${PREFIX}dep`])).rows[0]?.id;
    await client.query(`UPDATE bank_deposit SET status='ready' WHERE id=$1`, [dep10]);
    const facts10 = dep10 ? await loadGlDocumentAddFacts(openingStub, "bank_deposit", dep10) : null;
    assert(!!facts10 && !facts10.ready && "skip" in facts10 && facts10.skip === true, "facts → skip for an opening-item deposit (before any posting/bank check)", JSON.stringify(facts10).slice(0, 160));

    // ── 11 · controles ─────────────────────────────────────────────────────
    console.log("\n── 11. controls: dead bridge · unknown outcome · QB rejection");
    const mk = async (memo: string): Promise<string> => {
      const c = await api("POST", "/admin/accounting/checks", {
        day: "2026-09-14", bank_account_list_id: CHASE, payee_type: "other", payee_name: "Ctl", memo: `${PREFIX}${memo}`,
        lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }], post: true,
      });
      return (await rowsFor(client, c.json.check.id, "gl_document_add"))[0]!.id;
    };
    const dead = await mk("dead");
    process.env.QB_BRIDGE_URL = CLOSED_PORT_URL;
    const rDead = await dispatchAndConfirm(client, dead);
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${STUB_PORT}`;
    assert(rDead.status === WRITE.sales.failed && rDead.next_retry_at === null, "dead bridge → Add failed TERMINAL (no auto-retry of an ADD)", `${rDead.status} retry_at=${rDead.next_retry_at}`);
    const unknown = await mk("unknown");
    state!.directQueryMode = "unknown_outcome";
    const rUnknown = await dispatchAndConfirm(client, unknown);
    assert(rUnknown.status === WRITE.sales.failed && rUnknown.next_retry_at === null && /Outcome unknown/.test(rUnknown.error ?? ""), "bridge op failed without a verdict → failed terminal, reason says to reconcile", `${rUnknown.status} ${rUnknown.error?.slice(0, 100)}`);
    const rejected = await mk("reject");
    state!.directQueryMode = "reject";
    const rRej = await dispatchAndConfirm(client, rejected);
    assert(rRej.status === WRITE.sales.failed && rRej.next_retry_at === null && /rejected gl_document_add \(3140\)/.test(rRej.error ?? ""), "QB rejection (3140, under `$`) → failed terminal with the code", `${rRej.status} ${rRej.error?.slice(0, 100)}`);
    assert((await docLink(client, "gl_check", (await rowById(client, rejected)).reference_id!)).qb_txn_id === null, "a rejected Add leaves the document without TxnID");

    // ── 14 · Other Name de QB enlazado (qb-other-names-picker-20260916) ────
    console.log("\n── 14. other_name: JE line → EntityRef · check payee → PayeeEntityRef · A/R line rejected");
    const OTHER_LIST_ID = `E2E-${PREFIX}ON`;
    await client.query(
      `INSERT INTO qb_other_name (id, qb_list_id, name, is_active) VALUES ($1, $2, $3, true)
       ON CONFLICT (qb_list_id) DO UPDATE SET name = EXCLUDED.name, is_active = true, deleted_at = NULL`,
      [`qbon_${PREFIX}on`, OTHER_LIST_ID, "Amerant Bank (e2e)"]
    );
    const jeOn = await api("POST", "/admin/accounting/journal-entries", {
      day: "2026-09-15", memo: `${PREFIX}interest ACH`,
      lines: [
        { account_list_id: CHASE, credit_cents: 72202, memo: "Account 140109363 ACH", entity_type: "other_name", entity_id: `qbon_${PREFIX}on`, entity_name: "whatever the client typed" },
        { account_list_id: BANK_FEES, debit_cents: 72202 },
      ],
      post: true,
    });
    assert(jeOn.status === 201, "JE with an other_name line created + posted", `HTTP ${jeOn.status} ${JSON.stringify(jeOn.json).slice(0, 160)}`);
    const jeOnLine = (jeOn.json.journal_entry?.lines ?? []).find((l: { entity_type: string | null }) => l.entity_type === "other_name");
    assert(jeOnLine?.entity_name === "Amerant Bank (e2e)", "the line's entity_name is the table's name, not what the client sent", JSON.stringify(jeOnLine).slice(0, 160));
    const jeOnId = jeOn.json.journal_entry?.id ?? jeOn.json.id;
    const jeOnRows = await rowsFor(client, jeOnId, "gl_document_add");
    const xjOn = String(jeOnRows[0]?.payload?.qbxml ?? "");
    const creditOn = xjOn.slice(xjOn.indexOf("<JournalCreditLine>"));
    assert(jeOnRows[0]?.status === WRITE.sales.dispatchable && creditOn.includes(`<EntityRef><ListID>${OTHER_LIST_ID}</ListID></EntityRef>`), "JournalEntryAdd carries EntityRef = the Other Name's ListID on the bank line", creditOn.slice(0, 200));
    assert(!xjOn.slice(0, xjOn.indexOf("<JournalCreditLine>")).includes("<EntityRef>"), "the expense line (no entity) carries no EntityRef");
    const rjOn = await dispatchAndConfirm(client, jeOnRows[0]!.id);
    assert(rjOn.status === WRITE.sales.synced && !!rjOn.qb_txn_id, "other_name JE confirmed with TxnID", `${rjOn.status}`);
    txnIdsSeen.push(rjOn.qb_txn_id!);

    const chkOn = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-15", bank_account_list_id: CHASE, number: null, payee_type: "other_name", payee_id: `qbon_${PREFIX}on`, payee_name: "ignored",
      memo: `${PREFIX}interest check`, lines: [{ account_list_id: BANK_FEES, amount_cents: 72202, memo: "Account 140109363 ACH" }], post: true,
    });
    assert(chkOn.status === 201 && chkOn.json.check?.payee_name === "Amerant Bank (e2e)", "check paid to an Other Name: created, payee_name from the table", `HTTP ${chkOn.status} ${chkOn.json.check?.payee_name}`);
    const xcOn = String((await rowsFor(client, chkOn.json.check?.id, "gl_document_add"))[0]?.payload?.qbxml ?? "");
    assert(xcOn.includes(`<PayeeEntityRef><ListID>${OTHER_LIST_ID}</ListID></PayeeEntityRef>`) && !xcOn.includes("Payee: Amerant"), "CheckAdd carries PayeeEntityRef (no 'Payee:' memo fallback)", xcOn.slice(0, 200));
    const rcOn = await dispatchAndConfirm(client, (await rowsFor(client, chkOn.json.check?.id, "gl_document_add"))[0]!.id);
    assert(rcOn.status === WRITE.sales.synced, "other_name check confirmed", rcOn.status);
    txnIdsSeen.push(rcOn.qb_txn_id!);

    // Negativas: A/R con Other Name → estructural; sin id → 400; id inexistente → 400.
    const AR_ACCT = (await client.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE account_type = 'AccountsReceivable' AND is_active AND deleted_at IS NULL ORDER BY qb_list_id LIMIT 1`)).rows[0]?.qb_list_id;
    if (AR_ACCT) {
      const jeAr = await api("POST", "/admin/accounting/journal-entries", {
        day: "2026-09-15", memo: `${PREFIX}other on AR`,
        lines: [{ account_list_id: AR_ACCT, debit_cents: 100, entity_type: "other_name", entity_id: `qbon_${PREFIX}on` }, { account_list_id: BANK_FEES, credit_cents: 100 }],
        post: true,
      });
      const arRow = (await rowsFor(client, jeAr.json.journal_entry?.id ?? "", "gl_document_add"))[0];
      assert(jeAr.status === 201 && arRow?.status === WRITE.sales.failed && /other_name_on_ar_ap_line/.test(arRow?.error ?? ""), "Other Name on an A/R line: GL posts, QB row failed structural", `${jeAr.status} ${arRow?.status} ${arRow?.error?.slice(0, 80)}`);
    } else {
      assert(false, "no AccountsReceivable account in the sandbox mirror (cannot run the A/R negative)");
    }
    const noId = await api("POST", "/admin/accounting/journal-entries", {
      day: "2026-09-15", memo: `${PREFIX}other no id`,
      lines: [{ account_list_id: CHASE, credit_cents: 100, entity_type: "other_name" }, { account_list_id: BANK_FEES, debit_cents: 100 }],
    });
    assert(noId.status === 400 && /entity_id is required/.test(JSON.stringify(noId.json)), "other_name without entity_id → 400", `${noId.status}`);
    const badId = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-15", bank_account_list_id: CHASE, payee_type: "other_name", payee_id: "qbon_nope", payee_name: "x",
      memo: `${PREFIX}bad other id`, lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }],
    });
    assert(badId.status === 400 && /other_name_not_active/.test(JSON.stringify(badId.json)), "other_name with an unknown id → 400 other_name_not_active", `${badId.status}`);

    // ── 15 · revise en el lugar (check-revise-20260918) ────────────────────
    console.log("\n── 15. revise a POSTED check in place → reversal + re-post + CheckModRq");
    const OTHER_EXPENSE = (await client.query<{ qb_list_id: string }>(
      `SELECT qb_list_id FROM qb_account WHERE account_type = 'Expense' AND is_active AND deleted_at IS NULL AND qb_list_id <> $1 AND qb_list_id NOT LIKE 'pos_%' ORDER BY qb_list_id LIMIT 1`, [BANK_FEES]
    )).rows[0]!.qb_list_id;
    const entriesOf = async (id: string) => (await client.query<{ id: string; kind: string; day: string; reverses_entry_id: string | null; amount_cents: string }>(
      `SELECT id, kind, day::text AS day, reverses_entry_id, amount_cents::text FROM bank_journal_entry WHERE source_kind='bank_check' AND source_id=$1 ORDER BY created_at`, [id]
    )).rows;
    const linesOf = async (entryId: string) => (await client.query<{ account_list_id: string; debit_cents: string; credit_cents: string }>(
      `SELECT account_list_id, debit_cents::text, credit_cents::text FROM bank_journal_line WHERE entry_id=$1 ORDER BY account_list_id`, [entryId]
    )).rows;

    // 15a · cheque propio, confirmado en QB por el Add: cambiar cuenta, monto, memo y día.
    const c15a = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-10", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber",
      memo: `${PREFIX}uber rev`, lines: [{ account_list_id: BANK_FEES, amount_cents: 615, memo: "ride" }], post: true,
    });
    const check15a = c15a.json.check.id as string;
    const add15a = (await rowsFor(client, check15a, "gl_document_add"))[0]!;
    const rAdd15a = await dispatchAndConfirm(client, add15a.id);
    assert(rAdd15a.status === WRITE.sales.synced, "fixture: a fresh check confirmed in QuickBooks", rAdd15a.status);
    txnIdsSeen.push(rAdd15a.qb_txn_id!);
    const before15 = await entriesOf(check15a);
    const linkBefore = await client.query<{ qb_txn_id: string; qb_edit_sequence: string | null; revision: number }>(`SELECT qb_txn_id, qb_edit_sequence, revision FROM gl_check WHERE id=$1`, [check15a]);
    // El EditSequence guardado se corrompe A PROPÓSITO: el despachador tiene que leer el fresco de QB.
    await client.query(`UPDATE gl_check SET qb_edit_sequence='stale-1' WHERE id=$1`, [check15a]);
    const rev1 = await api("POST", `/admin/accounting/checks/${check15a}/revise`, {
      day: "2026-09-11", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber Technologies",
      memo: `${PREFIX}uber · corregido`, lines: [{ account_list_id: OTHER_EXPENSE, amount_cents: 715, memo: "ride (fixed)" }],
      reason: "wrong account and amount",
    });
    assert(rev1.status === 200 && rev1.json.check?.status === "posted" && rev1.json.check?.revision === 1, "revise → 200, still posted, revision 1", `HTTP ${rev1.status} ${JSON.stringify(rev1.json).slice(0, 160)}`);
    assert(rev1.json.check?.doc_number === c15a.json.check.doc_number && rev1.json.check?.total_cents === 715 && rev1.json.check?.payee_name === "Uber Technologies" && rev1.json.check?.day === "2026-09-11", "same CHK number; header + lines rewritten");
    assert(rev1.json.check?.revised_by && rev1.json.check?.revision_reason === "wrong account and amount", "revised_by / revision_reason persisted");
    const after15 = await entriesOf(check15a);
    const reversal = after15.find((e) => e.kind === "reversal");
    const active = after15.filter((e) => e.kind === "document" && !after15.some((r) => r.reverses_entry_id === e.id));
    assert(before15.length === 1 && after15.length === 3 && !!reversal && reversal.reverses_entry_id === before15[0]!.id, "ledger: original + reversal + new document entry (append-only)", JSON.stringify(after15));
    assert(reversal?.day === "2026-09-10", "the reversal is dated on the ORIGINAL day (2026-09-10), not today", reversal?.day);
    assert(active.length === 1 && active[0]!.day === "2026-09-11" && active[0]!.id === rev1.json.entry_id, "exactly one active entry, on the new day, = response.entry_id");
    const newLines = await linesOf(active[0]!.id);
    assert(newLines.some((l) => l.account_list_id === OTHER_EXPENSE && l.debit_cents === "715") && newLines.some((l) => l.account_list_id === CHASE && l.credit_cents === "715"), "new entry lines: Dr new expense 7.15 / Cr Chase 7.15", JSON.stringify(newLines));
    const modRows = await rowsFor(client, check15a, "gl_document_mod");
    assert(modRows.length === 1 && [WRITE.sales.dispatchable, WRITE.sales.blocked].includes(modRows[0]!.status as never) && modRows[0]!.payload?.revision === 1, "one gl_document_mod row queued with revision 1", JSON.stringify(modRows.map((r) => [r.status, r.payload?.revision])));
    const linkMid = await client.query<{ qb_txn_id: string; qb_edit_sequence: string }>(`SELECT qb_txn_id, qb_edit_sequence FROM gl_check WHERE id=$1`, [check15a]);
    assert(linkMid.rows[0]!.qb_txn_id === linkBefore.rows[0]!.qb_txn_id, "revise never touches qb_txn_id");
    const rm1 = await dispatchAndConfirm(client, modRows[0]!.id);
    assert(rm1.status === WRITE.sales.synced && rm1.qb_txn_id === linkBefore.rows[0]!.qb_txn_id, "dispatch → CheckQuery (fresh EditSequence) → CheckMod → confirmed on the SAME TxnID", `${rm1.status} ${rm1.qb_txn_id} ${rm1.error ?? ""}`);
    const jq = lastJournal("Check");
    const journalAll = require("fs").readFileSync(JOURNAL, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
    const modEvt = [...journalAll].reverse().find((l: any) => l.event === "document_mod");
    const queryEvt = [...journalAll].reverse().find((l: any) => l.event === "direct_query" && l.isQuery && l.rqName === "Check");
    assert(!!queryEvt && !!modEvt && modEvt.editSequence !== "stale-1" && modEvt.clear === true && modEvt.lines === 1, "bridge saw CheckQueryRq then CheckModRq with the FRESH EditSequence, ClearExpenseLines + 1 line", JSON.stringify({ q: !!queryEvt, mod: modEvt }));
    assert(!!jq && jq.qbxml.includes("<CheckModRq>") && jq.qbxml.includes(`<ListID>${OTHER_EXPENSE}</ListID>`) && jq.qbxml.includes("<Amount>7.15</Amount>") && jq.qbxml.includes("<TxnDate>2026-09-11</TxnDate>") && jq.qbxml.includes("<Memo>Payee: Uber Technologies - e2e_gldq_uber - corregido</Memo>"), "CheckMod carries the corrected account, amount, date and payee memo", jq?.qbxml?.slice(0, 300));
    const linkAfter = await client.query<{ qb_edit_sequence: string; qb_synced_at: string | null }>(`SELECT qb_edit_sequence, qb_synced_at::text FROM gl_check WHERE id=$1`, [check15a]);
    assert(linkAfter.rows[0]!.qb_edit_sequence === modEvt?.newEditSequence && !!linkAfter.rows[0]!.qb_synced_at, "confirm wrote the NEW EditSequence back to gl_check", JSON.stringify(linkAfter.rows[0]));

    // 15b · segundo revise antes de despachar → una sola fila (coalesce), revision 2.
    const rv2 = await api("POST", `/admin/accounting/checks/${check15a}/revise`, {
      day: "2026-09-11", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber Technologies",
      memo: `${PREFIX}uber · corregido 2`, lines: [{ account_list_id: OTHER_EXPENSE, amount_cents: 715, memo: "ride (fixed twice)" }], reason: "memo typo",
    });
    const rv3 = await api("POST", `/admin/accounting/checks/${check15a}/revise`, {
      day: "2026-09-11", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber Technologies",
      memo: `${PREFIX}uber · corregido 3`, lines: [{ account_list_id: OTHER_EXPENSE, amount_cents: 715, memo: "ride (fixed thrice)" }], reason: "memo typo again",
    });
    assert(rv2.status === 200 && rv3.status === 200 && rv3.json.check?.revision === 3, "two more revisions → revision 3", `${rv2.status} ${rv3.status} ${rv3.json.check?.revision}`);
    const modRows2 = (await rowsFor(client, check15a, "gl_document_mod")).filter((r) => r.status !== WRITE.sales.synced);
    assert(modRows2.length === 1 && modRows2[0]!.payload?.revision === 3, "the second unsent revise REWROTE the pending Mod row (one live row, payload.revision 3)", JSON.stringify(modRows2.map((r) => [r.status, r.payload?.revision])));
    const rm3 = await dispatchAndConfirm(client, modRows2[0]!.id);
    assert(rm3.status === WRITE.sales.synced, "coalesced Mod dispatches and confirms", `${rm3.status} ${rm3.error ?? ""}`);
    assert((await entriesOf(check15a)).length === 7, "ledger has original + 3×(reversal + repost) = 7 entries");

    // 15c · Bank → CreditCard rechazado ANTES de escribir nada.
    const entriesBeforeType = (await entriesOf(check15a)).length;
    const rvType = await api("POST", `/admin/accounting/checks/${check15a}/revise`, {
      day: "2026-09-11", bank_account_list_id: VISA_7704, number: null, payee_type: "other", payee_name: "Uber Technologies",
      memo: `${PREFIX}uber · card`, lines: [{ account_list_id: OTHER_EXPENSE, amount_cents: 715 }], reason: "paid by card actually",
    });
    assert(rvType.status === 400 && rvType.json.code === "GL_SOURCE_INVALID" && rvType.json.details?.reason === "revise_type_change", "Bank → CreditCard → 400 revise_type_change", `${rvType.status} ${JSON.stringify(rvType.json).slice(0, 160)}`);
    assert((await entriesOf(check15a)).length === entriesBeforeType && (await client.query(`SELECT revision FROM gl_check WHERE id=$1`, [check15a])).rows[0].revision === 3, "rejected revise wrote nothing (no reversal, revision unchanged)");

    // 15d · mes cerrado → 409 GL_PERIOD_CLOSED, sin escribir.
    const APC_E2E = `apc_${PREFIX}sept`;
    await client.query(`DELETE FROM accounting_period_close WHERE id=$1`, [APC_E2E]);
    await client.query(
      `INSERT INTO accounting_period_close (id, period_start, period_end, revision, status, summary, open_documents, readiness, closed_by_user_id)
       VALUES ($1, '2026-09-01', '2026-10-01', (SELECT COALESCE(MAX(revision),0)+1 FROM accounting_period_close WHERE period_start='2026-09-01'), 'closed', '{}', '[]', '{}', 'e2e-gl-docs')`, [APC_E2E]
    );
    try {
      const rvClosed = await api("POST", `/admin/accounting/checks/${check15a}/revise`, {
        day: "2026-09-11", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Uber Technologies",
        memo: `${PREFIX}uber · closed`, lines: [{ account_list_id: OTHER_EXPENSE, amount_cents: 715 }], reason: "after close",
      });
      assert(rvClosed.status === 409 && rvClosed.json.code === "GL_PERIOD_CLOSED", "closed accounting period → 409 GL_PERIOD_CLOSED", `${rvClosed.status} ${JSON.stringify(rvClosed.json).slice(0, 120)}`);
      assert((await entriesOf(check15a)).length === entriesBeforeType, "nothing written under a closed period");
    } finally {
      await client.query(`DELETE FROM accounting_period_close WHERE id=$1`, [APC_E2E]);
    }

    // 15e · revise de un check cuyo ADD no salió → el ADD viejo queda skipped (superseded) y nace un ADD nuevo.
    const c15 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Lyft",
      memo: `${PREFIX}lyft`, lines: [{ account_list_id: BANK_FEES, amount_cents: 500 }], post: true,
    });
    const check15 = c15.json.check.id as string;
    const addUnsent = (await rowsFor(client, check15, "gl_document_add"))[0]!;
    const rvUnsent = await api("POST", `/admin/accounting/checks/${check15}/revise`, {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Lyft",
      memo: `${PREFIX}lyft fixed`, lines: [{ account_list_id: BANK_FEES, amount_cents: 550 }], reason: "tip included",
    });
    const adds15 = await rowsFor(client, check15, "gl_document_add");
    const superseded = adds15.find((r) => r.id === addUnsent.id);
    const freshAdd = adds15.find((r) => r.id !== addUnsent.id);
    assert(rvUnsent.status === 200 && superseded?.status === WRITE.sales.skipped && /superseded by revision 1/.test(superseded?.error ?? "") && !!freshAdd && freshAdd.status === WRITE.sales.dispatchable, "unsent Add → skipped 'superseded', a new Add is queued", JSON.stringify(adds15.map((r) => [r.status, r.error?.slice(0, 40)])));
    assert(String(freshAdd?.payload?.qbxml ?? "").includes("<Amount>5.50</Amount>") && (await rowsFor(client, check15, "gl_document_mod")).length === 0, "the new Add carries the corrected amount; no Mod row for a document QuickBooks never saw");
    const rAdd15 = await dispatchAndConfirm(client, freshAdd!.id);
    assert(rAdd15.status === WRITE.sales.synced, "the superseding Add confirms", rAdd15.status);
    txnIdsSeen.push(rAdd15.qb_txn_id!);

    // 15f · revise con el ADD EN VUELO → el Mod nace blocked/diferido y sale cuando el Add confirma.
    const c16 = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Bolt",
      memo: `${PREFIX}bolt`, lines: [{ account_list_id: BANK_FEES, amount_cents: 300 }], post: true,
    });
    const check16 = c16.json.check.id as string;
    const add16 = (await rowsFor(client, check16, "gl_document_add"))[0]!;
    const submitted16 = await dispatchAndConfirm(client, add16.id, { confirm: false });
    assert(submitted16.status === WRITE.sales.submitted, "fixture: Add in flight (submitted, not confirmed)", submitted16.status);
    const rvFlight = await api("POST", `/admin/accounting/checks/${check16}/revise`, {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Bolt",
      memo: `${PREFIX}bolt fixed`, lines: [{ account_list_id: BANK_FEES, amount_cents: 350 }], reason: "amount",
    });
    const mod16 = (await rowsFor(client, check16, "gl_document_mod"))[0];
    assert(rvFlight.status === 200 && !!mod16 && mod16.status !== WRITE.sales.failed, "revise during an in-flight Add → Mod row queued (not failed)", `${rvFlight.status} ${mod16?.status}`);
    const deferred16 = await dispatchAndConfirm(client, mod16!.id);
    assert(deferred16.status !== WRITE.sales.synced && deferred16.status !== WRITE.sales.failed && /waiting on the add's qb_txn_id/.test(deferred16.error ?? ""), "dispatching the Mod before the Add confirms DEFERS it", `${deferred16.status} ${deferred16.error}`);
    const { pollSubmittedRows: poll16 } = await import("../../lib/quickbooks/consolidator/poll-submitted-rows");
    await poll16([{ ...submitted16, bridge_op_id: submitted16.bridge_op_id! }], stubContainer, logger);
    const link16 = await docLink(client, "gl_check", check16);
    assert(!!link16.qb_txn_id, "fixture: the Add confirmed and wrote the TxnID", JSON.stringify(link16));
    const rm16 = await dispatchAndConfirm(client, mod16!.id);
    assert(rm16.status === WRITE.sales.synced && rm16.qb_txn_id === link16.qb_txn_id, "after the Add confirms, the deferred Mod dispatches and confirms on that TxnID", `${rm16.status} ${rm16.error ?? ""}`);
    txnIdsSeen.push(link16.qb_txn_id!);

    // 15g · QB rechaza el Mod (3120) → failed con retry, sin tocar el documento.
    const revRej = await api("POST", `/admin/accounting/checks/${check16}/revise`, {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Bolt",
      memo: `${PREFIX}bolt rejected`, lines: [{ account_list_id: BANK_FEES, amount_cents: 360 }], reason: "control: QB rejects",
    });
    const modRejRow = (await rowsFor(client, check16, "gl_document_mod")).find((r) => r.status !== WRITE.sales.synced)!;
    state!.directQueryMode = "reject";
    const rModRej = await dispatchAndConfirm(client, modRejRow.id);
    assert(revRej.status === 200 && rModRej.status !== WRITE.sales.synced && /3120|rejected/.test(rModRej.error ?? ""), "control: QuickBooks rejection → row not synced, error names the code", `${rModRej.status} ${rModRej.error?.slice(0, 100)}`);
    assert((await docLink(client, "gl_check", check16)).qb_txn_id === link16.qb_txn_id, "a rejected Mod leaves the document's QuickBooks link intact");

    // 15h · draft/voided no se revisan.
    const cDraft = await api("POST", "/admin/accounting/checks", {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Draft",
      memo: `${PREFIX}draft`, lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }],
    });
    const rvDraft = await api("POST", `/admin/accounting/checks/${cDraft.json.check.id}/revise`, {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Draft",
      memo: `${PREFIX}draft`, lines: [{ account_list_id: BANK_FEES, amount_cents: 100 }], reason: "x",
    });
    assert(rvDraft.status === 409 && rvDraft.json.code === "GL_DOCUMENT_NOT_POSTED", "a draft cannot be revised (PATCH is its path) → 409", `${rvDraft.status}`);
    const rvNoReason = await api("POST", `/admin/accounting/checks/${check16}/revise`, {
      day: "2026-09-12", bank_account_list_id: CHASE, number: null, payee_type: "other", payee_name: "Bolt",
      memo: `${PREFIX}bolt`, lines: [{ account_list_id: BANK_FEES, amount_cents: 350 }],
    });
    assert(rvNoReason.status === 400, "reason is mandatory → 400", `${rvNoReason.status}`);

    // ── 12 · importador ────────────────────────────────────────────────────
    console.log("\n── 12. importer recognises every TxnID this lane wrote (live and voided)");
    const known = await loadPosKnownTxnIds(client as never);
    const missing = txnIdsSeen.filter((t) => !known.has(t));
    assert(txnIdsSeen.length >= 6 && missing.length === 0, `loadPosKnownTxnIds knows all ${txnIdsSeen.length} TxnIDs (incl. voided ones)`, `missing=${missing.join(",")}`);
    assert(classify("Check", "2026-09-14", undefined, true).action === "skip_pos_owned_after_cutoff" && classify("Deposit", "2026-09-14", undefined, true).action === "skip_pos_owned_after_cutoff", "classify skips a known bank-side TxnID after the cutoff");
    assert(classify("Check", "2026-09-14", undefined, false).action === "import", "control: an unknown Check still imports");

    // ── 13 · negativas ─────────────────────────────────────────────────────
    console.log("\n── 13. negatives");
    const stray = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM qb_order_pipeline WHERE step LIKE 'gl_document_%' AND reference_type NOT IN ('gl_check','gl_transfer','gl_journal_entry','bank_deposit','gl_sales_tax_payment','gl_sales_tax_adjustment')`
    );
    assert(stray.rows[0]!.n === "0", "no gl_document_* row for any other reference_type");
    const other = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM qb_order_pipeline WHERE step IN ('bill_payment_add','vendor_credit_add') AND created_at > NOW() - INTERVAL '30 minutes'`
    );
    assert(other.rows[0]!.n === "0", "no bill_payment/vendor_credit row was created by this run");
  } finally {
    try {
      await cleanup(client);
      const left = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM gl_check WHERE memo LIKE $1`, [`${PREFIX}%`]);
      assert(left.rows[0]!.n === "0", "fixtures removed (gl_check by memo prefix)");
    } catch (e) {
      assert(false, "cleanup", e instanceof Error ? e.message : String(e));
    }
    server?.close();
    await client.end();
  }
  console.log(`\n${failures === 0 ? "✅" : "❌"} e2e-gl-documents-qb-sandbox: ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
