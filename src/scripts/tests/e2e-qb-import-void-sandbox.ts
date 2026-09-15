/**
 * e2e-qb-import-void-sandbox — "Void & redo" de un documento importado de
 * QuickBooks de punta a punta (plan qb-import-void-ui-20260915): la ruta HTTP
 * con guard Accounting, la reversa contable el MISMO día, la fila
 * `qb_import_void` y su TxnVoid por el stub bridge, y la matriz de rechazos.
 *
 *   1. Check libre (sin extracto)         → 201: reversa mismo día, líneas espejo, fila pending con TxnVoidRq Check
 *   2. dispatch + confirm por el stub     → submitted → confirmed; el stub recibió <TxnVoidType>Check
 *   3. segundo void del mismo TxnID       → 400 already_reversed, 0 filas nuevas
 *   4. doc anulable en extracto DRAFT      → 201 (assert_open deja pasar un borrador), TxnVoidType mapeado
 *   5. NEGATIVAS sin escritura: match vivo → entry_matched · dentro de extracto CERRADO → statement_closed
 *      · Transfer/Invoice → type_not_voidable · TxnID inexistente → not_imported
 *   6. AUTH: sin token 401 · cajero 403 (el guard es la ruta, no la pantalla)
 *   7. QB rechaza el TxnVoid (3120)       → failed con reintento; retry route re-encola; mark-fixed cierra
 *   8. QB_SYNC_ENABLED=false (in-process) → reversa posteada, qb.queued=false con motivo
 *   9. feed de compras lista las filas `void_qb_import`; el importador NO conoce el TxnID anulado (S4)
 *
 * Corre contra un CLON desechable (el libro es inmutable: no hay limpieza posible de una reversa):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa_qbvoid \
 *       E2E_BACKEND_URL=http://localhost:9093 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-import-void-sandbox.ts
 */
import type { Server } from "http";
import { Client } from "pg";

import { startStubBridge, type StubState } from "./_stub-qb-bridge";

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9093";
const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 19997);
const JOURNAL = `/tmp/e2e_qbvoid_stub-bridge.jsonl`;
const connectionString = process.env.DATABASE_URL ?? "";
if (!/localhost:5499|127\.0\.0\.1:5499/.test(connectionString)) {
  console.error("SAFETY: DATABASE_URL must point at the sandbox (:5499)");
  process.exit(2);
}
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BACKEND)) {
  console.error("SAFETY: E2E_BACKEND_URL must be a local port");
  process.exit(2);
}

let failures = 0;
let checks = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  checks++;
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
type Fixture = { txn_id: string; entry_id: string; day: string; txn_type: string; reference: string };

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error(`login failed for ${email} (${res.status})`);
  return j.token;
}
async function api<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
const voidCall = (token: string | null, txn_id: string, reason = "E2E-QBVOID") =>
  api(token, "POST", "/admin/accounting/ledger/qb-import/void", { txn_id, reason });

/** Un `qb_import` ACTIVO por tipo y situación de extracto de su línea bancaria. */
async function pickFixture(
  client: Client,
  txnType: string,
  situation: "none" | "draft" | "closed",
  opts: { matched?: boolean; minDay?: string; exclude?: string[] } = {}
): Promise<Fixture> {
  const r = await client.query<Fixture>(
    `WITH act AS (
       SELECT e.id AS entry_id, e.day::text AS day, e.source_id AS txn_id, e.source_snapshot->>'txn_type' AS txn_type, e.reference
         FROM bank_journal_entry e
        WHERE e.source_kind='qb_import' AND e.kind='document' AND e.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
     SELECT DISTINCT ON (a.txn_id) a.txn_id, a.entry_id, a.day, a.txn_type, a.reference
       FROM act a
       JOIN bank_journal_line l ON l.entry_id=a.entry_id AND l.account_snapshot->>'account_type' IN ('Bank','CreditCard')
       LEFT JOIN bank_statement s ON s.account_list_id=l.account_list_id AND s.deleted_at IS NULL AND a.day BETWEEN s.from_day AND s.to_day
      WHERE a.txn_type=$1
        AND (($2='none' AND s.id IS NULL) OR s.status=$2)
        AND (EXISTS (SELECT 1 FROM bank_statement_match m JOIN bank_journal_line ml ON ml.id=m.book_id
                      WHERE ml.entry_id=a.entry_id AND m.deleted_at IS NULL)) = $3
        AND ($2='closed' OR NOT EXISTS (SELECT 1 FROM bank_journal_line l2 JOIN bank_statement s2 ON s2.account_list_id=l2.account_list_id
                      AND s2.deleted_at IS NULL AND s2.status='closed' AND a.day BETWEEN s2.from_day AND s2.to_day
                      WHERE l2.entry_id=a.entry_id AND l2.account_snapshot->>'account_type' IN ('Bank','CreditCard')))
        AND a.day >= $4 AND NOT (a.txn_id = ANY($5::text[]))
        AND NOT EXISTS (SELECT 1 FROM accounting_period_close p WHERE p.status='closed' AND a.day::date >= p.period_start AND a.day::date < p.period_end)
      ORDER BY a.txn_id, a.day DESC LIMIT 1`,
    [txnType, situation, opts.matched ?? false, opts.minDay ?? "2026-01-01", opts.exclude ?? []]
  );
  const f = r.rows[0];
  if (!f) throw new Error(`no fixture: ${txnType} / ${situation} / matched=${opts.matched ?? false}`);
  return f;
}
async function counts(client: Client): Promise<{ entries: number; lines: number; rows: number }> {
  const r = await client.query<{ entries: string; lines: string; rows: string }>(
    `SELECT (SELECT COUNT(*) FROM bank_journal_entry) AS entries, (SELECT COUNT(*) FROM bank_journal_line) AS lines,
            (SELECT COUNT(*) FROM qb_order_pipeline WHERE step='qb_import_void') AS rows`
  );
  return { entries: Number(r.rows[0]!.entries), lines: Number(r.rows[0]!.lines), rows: Number(r.rows[0]!.rows) };
}
async function reversalOf(client: Client, entryId: string) {
  const r = await client.query<{ id: string; day: string; kind: string; reference: string; description: string; actor_id: string; reason: string | null }>(
    `SELECT id, day::text AS day, kind, reference, description, actor_id, reason FROM bank_journal_entry WHERE reverses_entry_id=$1`,
    [entryId]
  );
  return r.rows[0] ?? null;
}
async function lineSums(client: Client, entryId: string) {
  const r = await client.query<{ n: string; d: string; c: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(debit_cents),0)::text AS d, COALESCE(SUM(credit_cents),0)::text AS c FROM bank_journal_line WHERE entry_id=$1`,
    [entryId]
  );
  return { n: Number(r.rows[0]!.n), d: r.rows[0]!.d, c: r.rows[0]!.c };
}
async function rowsFor(client: Client, txnId: string): Promise<Row[]> {
  const r = await client.query<Row>(
    `SELECT id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count,
            qb_txn_id, next_retry_at, error, payload FROM qb_order_pipeline WHERE step='qb_import_void' AND reference_id=$1 ORDER BY created_at`,
    [txnId]
  );
  return r.rows;
}
async function rowById(client: Client, id: string): Promise<Row> {
  return (await rowsForId(client, id))!;
}
async function rowsForId(client: Client, id: string): Promise<Row | undefined> {
  const r = await client.query<Row>(
    `SELECT id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count,
            qb_txn_id, next_retry_at, error, payload FROM qb_order_pipeline WHERE id=$1`,
    [id]
  );
  return r.rows[0];
}
async function dispatchAndConfirm(client: Client, rowId: string): Promise<Row> {
  const { resubmitByStep } = await import("../../lib/quickbooks/consolidator/resubmit-by-step");
  const { pollSubmittedRows } = await import("../../lib/quickbooks/consolidator/poll-submitted-rows");
  const claimed = (
    await client.query<Row>(
      `UPDATE qb_order_pipeline SET status='processing', updated_at=NOW(), error=NULL WHERE id=$1 AND status IN ('pending','waiting','failed')
       RETURNING id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count, qb_txn_id, next_retry_at, error, payload`,
      [rowId]
    )
  ).rows[0]!;
  await resubmitByStep(claimed, stubContainer, logger);
  let after = await rowById(client, rowId);
  if (after.status === "submitted" && after.bridge_op_id) {
    await pollSubmittedRows([{ ...after, bridge_op_id: after.bridge_op_id }], stubContainer, logger);
    after = await rowById(client, rowId);
  }
  return after;
}
function journalEntries(): Array<Record<string, any>> {
  const fs = require("fs") as typeof import("fs");
  return fs
    .readFileSync(JOURNAL, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}

async function main(): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  let server: Server | undefined;
  let state: StubState | undefined;
  try {
    const contador = await login("contador@test.com", "Contador123");
    const cajero = await login("cajero@test.com", "Cajero123");
    ({ server, state } = await startStubBridge(STUB_PORT, JOURNAL));
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${STUB_PORT}`;
    process.env.QB_API_KEY = process.env.QB_API_KEY ?? "e2e-stub-key";
    const used: string[] = [];

    // ── 1 · Check libre → 201, reversa mismo día, fila pending ────────────
    console.log("\n── 1. Check sin extracto → void");
    const a = await pickFixture(client, "Check", "none", { minDay: "2026-09-01" });
    used.push(a.txn_id);
    const before1 = await counts(client);
    const r1 = await voidCall(contador, a.txn_id, "E2E-QBVOID wrong vendor");
    assert(r1.status === 201, "POST void → 201", `${r1.status} ${JSON.stringify(r1.json).slice(0, 200)}`);
    assert(r1.json.entry_id === a.entry_id && r1.json.day === a.day, "response names the entry and the ORIGINAL day", `${r1.json.day} vs ${a.day}`);
    const rev1 = await reversalOf(client, a.entry_id);
    assert(!!rev1 && rev1.id === r1.json.reversal_entry_id, "a reversal entry hangs off the original");
    assert(rev1?.day === a.day, "the reversal is dated the SAME day as the original (not today)", `${rev1?.day}`);
    assert(rev1?.kind === "reversal", "reversal kind", rev1?.kind);
    assert(rev1?.reason === "E2E-QBVOID wrong vendor", "the reason travels with the reversal (bank_journal_entry.reason)", `${rev1?.reason}`);
    const actor1 = (await client.query<{ id: string }>(`SELECT id FROM "user" WHERE email='contador@test.com' AND deleted_at IS NULL`)).rows[0]!;
    assert(rev1?.actor_id === actor1.id, "the reversal is signed by the caller (actor_id)", `${rev1?.actor_id}`);
    const orig = await lineSums(client, a.entry_id);
    const mirror = await lineSums(client, rev1!.id);
    assert(orig.n === mirror.n && orig.d === mirror.c && orig.c === mirror.d, "reversal lines mirror the original (debit↔credit)", `${orig.n}/${mirror.n} · ${orig.d}/${mirror.c}`);
    const rows1 = await rowsFor(client, a.txn_id);
    assert(rows1.length === 1 && rows1[0]!.status === "pending", "one qb_import_void row, pending", rows1.map((r) => r.status).join(","));
    assert(rows1[0]?.reference_type === "qb_import" && rows1[0]?.qb_txn_id === a.txn_id, "row keyed by the TxnID (reference_type qb_import)");
    const payload1 = rows1[0]?.payload as { qb_txn_type?: string; qbxml?: string; reason?: string } | null;
    assert(payload1?.qb_txn_type === "Check" && (payload1?.qbxml ?? "").includes(`<TxnVoidType>Check</TxnVoidType><TxnID>${a.txn_id}</TxnID>`), "payload carries TxnVoidRq Check for that TxnID");
    assert(r1.json.qb?.queued === true && r1.json.qb.pipeline_row_id === rows1[0]!.id, "response reports the queued row");
    const after1 = await counts(client);
    assert(after1.entries === before1.entries + 1 && after1.rows === before1.rows + 1, "exactly one entry + one row written");

    // ── 2 · dispatch + confirm por el stub ────────────────────────────────
    console.log("\n── 2. dispatch → stub bridge → confirm");
    const d2 = await dispatchAndConfirm(client, rows1[0]!.id);
    assert(d2.status === "confirmed", "row confirmed after TxnVoidRs statusCode 0", `${d2.status} ${d2.error ?? ""}`);
    assert(d2.qb_txn_id === a.txn_id, "confirmed row keeps the TxnID");
    const j2 = journalEntries().filter((e) => e.event === "direct_query" && e.isVoid);
    assert(j2.length === 1 && String(j2[0]!.qbxml).includes("<TxnVoidType>Check</TxnVoidType>"), "the stub received exactly one TxnVoidRq Check", `${j2.length}`);
    assert(!(await reversalOf(client, rev1!.id)), "confirm writes nothing else to the ledger (no reversal of the reversal)");

    // ── 3 · segundo void → already_reversed ───────────────────────────────
    console.log("\n── 3. second void of the same TxnID");
    const before3 = await counts(client);
    const r3 = await voidCall(contador, a.txn_id);
    assert(r3.status === 400 && r3.json.details?.reason === "already_reversed", "→ 400 already_reversed", `${r3.status} ${r3.json.details?.reason}`);
    const after3 = await counts(client);
    assert(after3.entries === before3.entries && after3.rows === before3.rows, "nothing written");

    // ── 4 · Credit Card Charge en extracto DRAFT ──────────────────────────
    console.log("\n── 4. a voidable doc inside a DRAFT statement");
    // The clone rarely has a free doc inside a draft period: extend the latest
    // DRAFT statement of an account up to a free doc of that account (the
    // statement guard allows a draft's range to move while nothing overlaps).
    const draftFx = await client.query<Fixture & { statement_id: string }>(
      `WITH act AS (SELECT e.id AS entry_id, e.day::text AS day, e.source_id AS txn_id, e.source_snapshot->>'txn_type' AS txn_type, e.reference
                      FROM bank_journal_entry e WHERE e.source_kind='qb_import' AND e.kind='document' AND e.deleted_at IS NULL
                       AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
       SELECT a.txn_id, a.entry_id, a.day, a.txn_type, a.reference, s.id AS statement_id
         FROM bank_statement s
         JOIN bank_journal_line l ON l.account_list_id=s.account_list_id AND l.account_snapshot->>'account_type' IN ('Bank','CreditCard')
         JOIN act a ON a.entry_id=l.entry_id AND a.day > s.to_day
          AND a.txn_type IN ('Credit Card Charge','Credit Card Credit','Check','Deposit','General Journal')
        WHERE s.status='draft' AND s.deleted_at IS NULL AND NOT (a.txn_id = ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM bank_statement s2 WHERE s2.account_list_id=s.account_list_id AND s2.deleted_at IS NULL AND s2.from_day > s.to_day)
          AND NOT EXISTS (SELECT 1 FROM bank_statement_match m JOIN bank_journal_line ml ON ml.id=m.book_id WHERE ml.entry_id=a.entry_id AND m.deleted_at IS NULL)
        ORDER BY a.day LIMIT 1`,
      [used]
    );
    const b = draftFx.rows[0];
    if (!b) console.log("   ⏭ OMITIDA: no queda en este clon un doc anulable después de un extracto DRAFT (la mitad browser, qb-import-void.mjs §4, cubre el mismo caso)");
    if (b) {
    await client.query(`UPDATE bank_statement SET to_day=$2, revision=revision+1, updated_at=now() WHERE id=$1 AND status='draft'`, [b.statement_id, b.day]);
    const covering = await client.query<{ status: string }>(
      `SELECT status FROM bank_statement WHERE id=$1 AND $2 BETWEEN from_day AND to_day`, [b.statement_id, b.day]
    );
    assert(covering.rows[0]?.status === "draft", "fixture: the doc's day now falls inside a DRAFT statement", `${b.txn_id} ${b.day} in ${b.statement_id}`);
    used.push(b.txn_id);
    const r4 = await voidCall(contador, b.txn_id, "E2E-QBVOID amount");
    assert(r4.status === 201, "→ 201 (a draft statement does not block)", `${r4.status} ${JSON.stringify(r4.json).slice(0, 160)}`);
    const rev4 = await reversalOf(client, b.entry_id);
    assert(rev4?.day === b.day, "reversal on the original day inside the draft period", `${rev4?.day} vs ${b.day}`);
    const rows4 = await rowsFor(client, b.txn_id);
    const { QB_IMPORT_VOIDABLE_TYPES } = await import("../../lib/ledger/qb-import/void");
    assert((rows4[0]?.payload as { qb_txn_type?: string })?.qb_txn_type === QB_IMPORT_VOIDABLE_TYPES[b.txn_type], `TxnVoidType mapped for ${b.txn_type}`, `${(rows4[0]?.payload as { qb_txn_type?: string })?.qb_txn_type}`);
    }

    // ── 5 · NEGATIVAS sin escritura ───────────────────────────────────────
    console.log("\n── 5. rejections write nothing");
    const before5 = await counts(client);
    const matched = await client.query<Fixture & { st: string }>(
      `SELECT e.source_id AS txn_id, e.id AS entry_id, e.day::text AS day, e.source_snapshot->>'txn_type' AS txn_type, e.reference, st.status AS st
         FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id=e.id
         JOIN bank_statement_match m ON m.book_id=l.id AND m.deleted_at IS NULL JOIN bank_statement st ON st.id=m.statement_id
        WHERE e.source_kind='qb_import' AND e.kind='document' AND e.source_snapshot->>'txn_type' IN ('Check','Deposit','Credit Card Charge')
          AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) ORDER BY st.status LIMIT 1`
    );
    const m = matched.rows[0]!;
    const r5a = await voidCall(contador, m.txn_id);
    assert(r5a.status === 400 && r5a.json.details?.reason === "entry_matched" && r5a.json.details?.statement_status === m.st, "matched entry → entry_matched with the statement status", `${r5a.status} ${JSON.stringify(r5a.json.details)}`);
    const closedFx = await pickFixture(client, "Check", "closed", { exclude: used });
    const r5b = await voidCall(contador, closedFx.txn_id);
    assert(r5b.status === 400 && r5b.json.details?.reason === "statement_closed", "unmatched Check inside a CLOSED statement → statement_closed (trigger, tx rolled back)", `${r5b.status} ${JSON.stringify(r5b.json.details)}`);
    assert(!(await reversalOf(client, closedFx.entry_id)), "no reversal left behind by the rolled-back void");
    const transfer = await client.query<{ txn_id: string }>(
      `SELECT source_id AS txn_id FROM bank_journal_entry WHERE source_kind='qb_import' AND kind='document' AND source_snapshot->>'txn_type'='Transfer'
         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=bank_journal_entry.id) LIMIT 1`
    );
    const r5c = await voidCall(contador, transfer.rows[0]!.txn_id);
    assert(r5c.status === 400 && r5c.json.details?.reason === "type_not_voidable" && r5c.json.details?.txn_type === "Transfer", "Transfer → type_not_voidable", `${r5c.status} ${JSON.stringify(r5c.json.details)}`);
    const invoice = await client.query<{ txn_id: string }>(
      `SELECT source_id AS txn_id FROM bank_journal_entry WHERE source_kind='qb_import' AND kind='document' AND source_snapshot->>'txn_type'='Invoice'
         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=bank_journal_entry.id) LIMIT 1`
    );
    const r5d = await voidCall(contador, invoice.rows[0]!.txn_id);
    assert(r5d.status === 400 && r5d.json.details?.reason === "type_not_voidable", "Invoice → type_not_voidable (AR lives elsewhere)");
    const r5e = await voidCall(contador, "1FFFFF-0000000000");
    assert(r5e.status === 400 && r5e.json.details?.reason === "not_imported", "unknown TxnID → not_imported");
    const r5f = await api(contador, "POST", "/admin/accounting/ledger/qb-import/void", { txn_id: a.txn_id });
    assert(r5f.status === 400 && r5f.json.code === "invalid_body", "missing reason → invalid_body");
    const after5 = await counts(client);
    assert(after5.entries === before5.entries && after5.lines === before5.lines && after5.rows === before5.rows, "six rejections: 0 entries, 0 lines, 0 rows written");

    // ── 6 · AUTH ──────────────────────────────────────────────────────────
    console.log("\n── 6. the route is the gate");
    const fresh6 = await pickFixture(client, "Check", "none", { exclude: used });
    const r6a = await voidCall(null, fresh6.txn_id);
    assert(r6a.status === 401, "no token → 401", `${r6a.status}`);
    const r6b = await voidCall(cajero, fresh6.txn_id);
    assert(r6b.status === 403, "cashier (no Accounting) → 403", `${r6b.status} ${JSON.stringify(r6b.json).slice(0, 120)}`);
    assert(!(await reversalOf(client, fresh6.entry_id)), "denied calls wrote nothing");

    // ── 7 · QB rechaza el TxnVoid → failed con reintento; retry; mark-fixed ─
    console.log("\n── 7. QuickBooks rejects the TxnVoid (3120)");
    used.push(fresh6.txn_id);
    const r7 = await voidCall(contador, fresh6.txn_id, "E2E-QBVOID reject");
    assert(r7.status === 201, "void posted", `${r7.status} ${JSON.stringify(r7.json).slice(0, 160)}`);
    const row7 = (await rowsFor(client, fresh6.txn_id))[0]!;
    state!.directQueryMode = "reject";
    const d7 = await dispatchAndConfirm(client, row7.id);
    assert(d7.status === "failed" && /3120/.test(d7.error ?? ""), "rejected → failed with the QB code", `${d7.status} ${d7.error}`);
    assert(d7.next_retry_at !== null, "…and a retry is scheduled (void family)", `${d7.next_retry_at}`);
    assert(!!(await reversalOf(client, fresh6.entry_id)), "the ledger reversal stays (QB is the mirror; the row shows the drift)");
    const retry = await api(contador, "POST", `/admin/purchase-orders/qb-pipeline/${row7.id}__qb_import_void/retry`, {});
    assert(retry.status === 200 && retry.json.success === true, "retry route re-queues a qb_import_void row", `${retry.status} ${JSON.stringify(retry.json).slice(0, 120)}`);
    const after7r = await rowById(client, row7.id);
    assert(["pending", "waiting"].includes(after7r.status), "row back to pending/waiting", after7r.status);
    const fixed = await api(contador, "POST", `/admin/purchase-orders/qb-pipeline/${row7.id}__qb_import_void/mark-fixed`, {});
    assert(fixed.status === 200 && fixed.json.success === true, "mark-fixed route accepts a qb_import_void row", `${fixed.status} ${JSON.stringify(fixed.json).slice(0, 120)}`);
    const after7f = await rowById(client, row7.id);
    assert(after7f.status === "fixed", "row marked fixed", after7f.status);

    // ── 8 · QB_SYNC_ENABLED=false (in-process) ────────────────────────────
    console.log("\n── 8. QB sync disabled: reversal still posts, void not queued");
    const fresh8 = await pickFixture(client, "Check", "none", { exclude: used });
    used.push(fresh8.txn_id);
    process.env.QB_SYNC_ENABLED = "false";
    const { voidQbImportDocument } = await import("../../lib/ledger/qb-import/void");
    const { getDbPool } = await import("../../api/utils/db-pool");
    const actor = (await client.query<{ id: string }>(`SELECT id FROM "user" WHERE email='contador@test.com' AND deleted_at IS NULL`)).rows[0]!;
    const poolClient = await getDbPool().connect();
    let r8: Awaited<ReturnType<typeof voidQbImportDocument>>;
    try {
      r8 = await voidQbImportDocument(poolClient, { txn_id: fresh8.txn_id, reason: "E2E-QBVOID sync off" }, actor.id);
    } finally {
      poolClient.release();
      delete process.env.QB_SYNC_ENABLED;
    }
    assert(r8.qb.queued === false && /QB_SYNC_ENABLED/.test(r8.qb.queued ? "" : r8.qb.reason), "qb.queued=false with the reason", JSON.stringify(r8.qb));
    assert(!!(await reversalOf(client, fresh8.entry_id)), "reversal posted anyway");
    assert((await rowsFor(client, fresh8.txn_id)).length === 0, "no pipeline row");

    // ── 9 · feed de compras + importador ──────────────────────────────────
    console.log("\n── 9. purchases feed + importer");
    const { PURCHASE_PIPELINE_FEED_SQL } = await import("../../api/admin/purchase-orders/qb-pipeline/_lib/feed-sql");
    const feed = await client.query<{ id: string; step: string; status: string; vendor_name: string; qb_list_id: string }>(
      `SELECT id, step, status, vendor_name, qb_list_id FROM (${PURCHASE_PIPELINE_FEED_SQL}) f WHERE f.step='void_qb_import' AND f.qb_list_id = ANY($1::text[])`,
      [[a.txn_id, ...(b ? [b.txn_id] : []), fresh6.txn_id]]
    );
    assert(feed.rows.length === (b ? 3 : 2), `feed lists this run's ${b ? 3 : 2} qb_import_void rows (confirmed · ${b ? "pending · " : ""}fixed)`, `${feed.rows.length}`);
    assert(feed.rows.every((r) => r.id.endsWith("__qb_import_void")), "feed ids carry the step suffix the retry/mark-fixed routes parse");
    const feedA = feed.rows.find((r) => r.qb_list_id === a.txn_id);
    assert(feedA?.status === "synced" && feedA.vendor_name === a.reference, "confirmed row reads synced with the entry's label", `${feedA?.status} · ${feedA?.vendor_name}`);
    const { loadPosKnownTxnIds } = await import("../../lib/ledger/qb-import/pos-links");
    const known = await loadPosKnownTxnIds(poolClientFor(client));
    assert(!known.has(a.txn_id), "importer does NOT treat a voided TxnID as POS-owned (S4: QB stays the mirror)");

    console.log(`\n${failures === 0 ? "✅" : "❌"} ${checks - failures}/${checks} checks passed`);
  } finally {
    server?.close();
    await client.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** `loadPosKnownTxnIds` wants a PoolClient-shaped `query`; a pg Client has the same one. */
function poolClientFor(client: Client): Parameters<typeof import("../../lib/ledger/qb-import/pos-links").loadPosKnownTxnIds>[0] {
  return client as unknown as Parameters<typeof import("../../lib/ledger/qb-import/pos-links").loadPosKnownTxnIds>[0];
}

main().catch((e: unknown) => {
  console.error("e2e-qb-import-void-sandbox:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
