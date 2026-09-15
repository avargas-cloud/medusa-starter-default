/**
 * e2e-vendor-credit-apply-qb-sandbox — el carril `vendor_credit_apply` de punta a
 * punta contra Postgres REAL (clon desechable) y el stub del bridge
 * (plan vc-apply-qb-20260915).
 *
 * Qué ejercita (cada sección con su evidencia):
 *   1. apply → enqueue: fila `vendor_credit_apply` pending, payload con qbxml
 *      `PaymentAmount 0.00` + `SetCredit`, cuenta = la tarjeta que acredita el crédito.
 *   2. dispatch + poll: el stub contesta statusCode 0 SIN TxnID (como QB en prod
 *      09/15/2026); el poller hace el readback (`/api/bills/query`) y confirma; la
 *      aplicación queda estampada (`qb_applied_at`, `qb_bill_txn_id`, `qb_credit_txn_id`).
 *   3. des-aplicar una aplicación que ya viajó → 409 `applied_in_quickbooks`.
 *   4. CONTROL NEGATIVO: readback sin LinkedTxn → `failed` terminal (sin next_retry_at)
 *      y la aplicación NO se estampa; des-aplicar → permitido.
 *   5. bill sin `qb_txn_id` → la fila espera (`waiting`, blocking_reference_ids); al
 *      despachar se difiere (`pending` + next_retry_at), nunca `failed`.
 *   6. fila viva → des-aplicar → 409 `applying_in_quickbooks`.
 *   7. rechazo de QB (statusCode 3140) → `failed` terminal.
 *   8. negativa: `feed-sql` muestra la lane `apply_vendor_credit` con su documento.
 *
 * SAFETY: DATABASE_URL debe apuntar a :5499 y a una base que NO sea `medusa`
 * (clon: `CREATE DATABASE medusa_vcapply TEMPLATE medusa` + las 4 columnas de
 * `Migration20260915150000`). Fixtures = pares reales de Part Express del clon;
 * la limpieza borra por id y restaura `applied_cents`.
 *
 * Run:
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa_vcapply \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-vendor-credit-apply-qb-sandbox.ts
 */
import type { Server } from "node:http";
import { Client } from "pg";

import { startStubBridge, type StubState } from "./_stub-qb-bridge";

const STUB_PORT = Number(process.env.E2E_STUB_PORT ?? 19997);
const JOURNAL = `/tmp/e2e_vcapply_stub-bridge.jsonl`;
const ACTOR = "e2e_vcapply_actor";

// Pares reales (clon de prod al 09/11): crédito = cargo a la Visa 2084 que paga el bill.
const PAIRS = {
  ok: { credit: "vcr_01m2a4yvj6csvr46yzx38vpgy5", bill: "vb_fec5ab7fe77b4f8c85bad3a7c4b3d104", cents: 19716 }, // VC-1060 ↔ VB-1065
  noLinks: { credit: "vcr_01m2a4z0cf0b2c2j3eyanj99n2", bill: "vb_6656794175204dfebf53d7dec4bc2a2a", cents: 16511 }, // VC-1073 ↔ VB-1067
  waiting: { credit: "vcr_01m2a4z487vkjnke12584szvwj", bill: "vb_4039c2b17f274fd38e9857c43fc5879a", cents: 15985 }, // VC-1082 ↔ VB-1068
  reject: { credit: "vcr_01m2a4z6v2xjs9cwbcbxkdv4ga", bill: "vb_d78c1f9acd844b85908f4d7910ccf757", cents: 19213 }, // VC-1090 ↔ VB-1069
};
const VISA_2084 = "80000127-1546534209";

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
const ROW_COLS = `id, order_id, reference_id, reference_type, step, status, bridge_op_id, COALESCE(retry_count,0) AS retry_count,
  qb_txn_id, next_retry_at, error, payload`;

function knexOf(client: Client) {
  const k = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const r = await client.query(sql.replace(/\?/g, () => `$${++i}`), bindings);
      return { rows: r.rows as unknown[], rowCount: r.rowCount ?? 0 };
    },
    transaction: async <T>(handler: (trx: typeof k) => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      try {
        const out = await handler(k);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  };
  return k;
}

async function rowsFor(client: Client, refId: string): Promise<Row[]> {
  const r = await client.query<Row>(
    `SELECT ${ROW_COLS} FROM qb_order_pipeline WHERE reference_id=$1 AND step='vendor_credit_apply' ORDER BY created_at`,
    [refId]
  );
  return r.rows;
}
async function rowById(client: Client, id: string): Promise<Row> {
  return (await client.query<Row>(`SELECT ${ROW_COLS} FROM qb_order_pipeline WHERE id=$1`, [id])).rows[0]!;
}
async function claim(client: Client, id: string): Promise<Row> {
  return (
    await client.query<Row>(
      `UPDATE qb_order_pipeline SET status='processing', updated_at=NOW(), error=NULL WHERE id=$1 RETURNING ${ROW_COLS}`,
      [id]
    )
  ).rows[0]!;
}
async function application(client: Client, id: string) {
  return (
    await client.query<{ voided_at: Date | null; qb_applied_at: Date | null; qb_bill_txn_id: string | null; qb_credit_txn_id: string | null; qb_payment_txn_id: string | null }>(
      `SELECT voided_at, qb_applied_at, qb_bill_txn_id, qb_credit_txn_id, qb_payment_txn_id FROM vendor_credit_application WHERE id=$1`,
      [id]
    )
  ).rows[0]!;
}

/** Dispatch + confirm de UNA fila con las funciones reales del consolidator. */
async function dispatchAndConfirm(client: Client, rowId: string): Promise<Row> {
  const { resubmitByStep } = await import("../../lib/quickbooks/consolidator/resubmit-by-step");
  const { pollSubmittedRows } = await import("../../lib/quickbooks/consolidator/poll-submitted-rows");
  await client.query(`UPDATE qb_order_pipeline SET status='pending' WHERE id=$1 AND status='waiting'`, [rowId]);
  const claimed = await claim(client, rowId);
  await resubmitByStep(claimed, stubContainer, logger);
  let after = await rowById(client, rowId);
  if (after.status === "submitted" && after.bridge_op_id) {
    await pollSubmittedRows([{ ...after, bridge_op_id: after.bridge_op_id }], stubContainer, logger);
    after = await rowById(client, rowId);
  }
  return after;
}

async function voidCode(client: Client, appId: string): Promise<string> {
  const { voidVendorCreditApplication } = await import("../../lib/vendor-credits/void-application");
  try {
    await voidVendorCreditApplication(client as never, appId, ACTOR);
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code ?? "error";
  }
}

const created: string[] = [];
async function cleanup(client: Client): Promise<void> {
  await client.query(`DELETE FROM qb_order_pipeline WHERE step='vendor_credit_apply' AND reference_id = ANY($1::text[])`, [created]);
  await client.query(`DELETE FROM qb_purchase_dependency_chain WHERE purchase_order_id = ANY($1::text[])`, [created]).catch(() => undefined);
  await client.query(`DELETE FROM vendor_credit_application WHERE id = ANY($1::text[])`, [created]);
  await client.query(`UPDATE vendor_credit SET applied_cents=0 WHERE id = ANY($1::text[])`, [Object.values(PAIRS).map((p) => p.credit)]);
  await client.query(`UPDATE vendor_bill SET qb_txn_id=$2 WHERE id=$1 AND qb_txn_id IS NULL`, [PAIRS.waiting.bill, "1CB73B-1785290435"]);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  if (!connectionString.includes(":5499/") || /:5499\/medusa($|\?)/.test(connectionString)) {
    throw new Error("Refusing to run: DATABASE_URL must be a sandbox (:5499) CLONE, never :5499/medusa itself");
  }
  process.env.QB_API_KEY = process.env.QB_API_KEY ?? "e2e-stub";
  delete process.env.QB_SYNC_ENABLED;
  process.env.ECOPOWERTECH_ENV = "sandbox";

  const client = new Client({ connectionString });
  await client.connect();
  const knex = knexOf(client);
  let server: Server | undefined;
  let state: StubState | undefined;
  try {
    ({ server, state } = await startStubBridge(STUB_PORT, JOURNAL));
    process.env.QB_BRIDGE_URL = `http://127.0.0.1:${STUB_PORT}`;
    const { applyVendorCreditToBill } = await import("../../lib/vendor-credits/apply");
    const { enqueueVendorCreditApply, loadVendorCreditApplyFacts } = await import("../../lib/purchase-orders/qb-vendor-credit-apply-enqueue");

    const applyAndEnqueue = async (p: { credit: string; bill: string; cents: number }) => {
      const app = await applyVendorCreditToBill(client as never, { creditId: p.credit, vendorBillId: p.bill, amountCents: p.cents, actorId: ACTOR });
      created.push(app.id);
      const qb = await enqueueVendorCreditApply(knex, app.id);
      return { appId: app.id, qb };
    };

    // ── 1 · apply → enqueue ────────────────────────────────────────────────
    console.log("\n── 1. apply → fila vendor_credit_apply");
    const one = await applyAndEnqueue(PAIRS.ok);
    assert(one.qb.queued === true, "enqueue devuelve queued:true", JSON.stringify(one.qb));
    const [row1] = await rowsFor(client, one.appId);
    assert(row1?.status === "pending", "fila pending (bill y crédito ya tienen TxnID)", row1?.status);
    const qbxml1 = String(row1?.payload?.qbxml ?? "");
    assert(qbxml1.includes("<PaymentAmount>0.00</PaymentAmount>"), "qbxml: PaymentAmount 0.00");
    assert(qbxml1.includes("<SetCredit><CreditTxnID>1CF4FC-1788790462</CreditTxnID><AppliedAmount>197.16</AppliedAmount>"), "qbxml: SetCredit con el TxnID y monto del crédito");
    assert(qbxml1.includes(`<CreditCardAccountRef><ListID>${VISA_2084}</ListID>`), "qbxml: cuenta = la tarjeta que acredita el crédito (Visa 2084)");
    assert(row1?.payload?.bill_txn_id === "1CB72E-1785290311" && row1?.payload?.credit_txn_id === "1CF4FC-1788790462", "payload lleva bill_txn_id y credit_txn_id");
    const again = await enqueueVendorCreditApply(knex, one.appId);
    assert((await rowsFor(client, one.appId)).length === 1, "re-encolar la misma aplicación NO crea otra fila (key idempotente)", JSON.stringify(again));

    // ── 2 · dispatch + readback → confirmed + estampa ──────────────────────
    console.log("\n── 2. dispatch → statusCode 0 sin TxnID → readback → confirmed");
    const after1 = await dispatchAndConfirm(client, row1!.id);
    assert(after1.status === "confirmed", "fila confirmed por readback", `${after1.status} ${after1.error ?? ""}`);
    assert(after1.qb_txn_id === null, "qb_txn_id null (QB no creó documento)", String(after1.qb_txn_id));
    const app1 = await application(client, one.appId);
    assert(app1.qb_applied_at !== null && app1.qb_bill_txn_id === "1CB72E-1785290311" && app1.qb_credit_txn_id === "1CF4FC-1788790462" && app1.qb_payment_txn_id === null, "aplicación estampada (qb_applied_at, bill/credit txn, payment null)", JSON.stringify(app1));
    const journal = require("node:fs").readFileSync(JOURNAL, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
    assert(journal.filter((j: { event: string }) => j.event === "bill_credit_apply").length === 1, "el stub recibió exactamente UN $0 SetCredit");
    assert(journal.filter((j: { event: string }) => j.event === "bill_query").length === 1, "y exactamente UN readback bills/query");

    // ── 3 · des-aplicar lo que ya viajó → 409 ──────────────────────────────
    console.log("\n── 3. void de una aplicación ya enlazada en QB → 409");
    assert((await voidCode(client, one.appId)) === "applied_in_quickbooks", "void → applied_in_quickbooks");
    assert((await application(client, one.appId)).voided_at === null, "la aplicación sigue viva");

    // ── 4 · CONTROL NEGATIVO: readback sin LinkedTxn → failed ──────────────
    console.log("\n── 4. control negativo: readback sin LinkedTxn → failed terminal");
    const two = await applyAndEnqueue(PAIRS.noLinks);
    const [row2] = await rowsFor(client, two.appId);
    state.billQueryMode = "no_links";
    const after2 = await dispatchAndConfirm(client, row2!.id);
    assert(after2.status === "failed" && after2.next_retry_at === null, "fila failed sin next_retry_at", `${after2.status} retry=${String(after2.next_retry_at)}`);
    assert(/no LinkedTxn/.test(after2.error ?? ""), "error nombra el readback", after2.error ?? "");
    assert((await application(client, two.appId)).qb_applied_at === null, "la aplicación NO se estampó");
    assert((await voidCode(client, two.appId)) === "ok", "void permitido (fila failed no bloquea)");

    // ── 5 · bill sin TxnID → waiting → defer ───────────────────────────────
    console.log("\n── 5. bill sin qb_txn_id → waiting; al despachar, defer (nunca failed)");
    await client.query(`UPDATE vendor_bill SET qb_txn_id=NULL WHERE id=$1`, [PAIRS.waiting.bill]);
    const three = await applyAndEnqueue(PAIRS.waiting);
    const [row3] = await rowsFor(client, three.appId);
    assert(row3?.status === "waiting", "fila waiting", row3?.status);
    assert(Array.isArray(row3?.payload?.blocking_reference_ids) && (row3!.payload!.blocking_reference_ids as string[]).includes(PAIRS.waiting.bill), "blocking_reference_ids lleva el bill");
    const facts3 = await loadVendorCreditApplyFacts(knex, three.appId);
    assert(facts3.ready === false, "facts: no ready mientras el bill no tenga TxnID");
    const after3 = await dispatchAndConfirm(client, row3!.id);
    assert(after3.status === "pending" && after3.next_retry_at !== null, "despachar difiere: pending + next_retry_at", `${after3.status} ${String(after3.next_retry_at)}`);
    // ── 6 · fila viva → void 409 ───────────────────────────────────────────
    console.log("\n── 6. fila viva (pending diferida) → void 409 applying_in_quickbooks");
    assert((await voidCode(client, three.appId)) === "applying_in_quickbooks", "void → applying_in_quickbooks");
    await client.query(`UPDATE vendor_bill SET qb_txn_id=$2 WHERE id=$1`, [PAIRS.waiting.bill, "1CB73B-1785290435"]);
    const after3b = await dispatchAndConfirm(client, row3!.id);
    assert(after3b.status === "confirmed", "con el TxnID del bill de vuelta, confirma", `${after3b.status} ${after3b.error ?? ""}`);

    // ── 7 · rechazo de QB → failed terminal ────────────────────────────────
    console.log("\n── 7. QB rechaza (3140) → failed terminal");
    const four = await applyAndEnqueue(PAIRS.reject);
    const [row4] = await rowsFor(client, four.appId);
    state.directQueryMode = "reject";
    const after4 = await dispatchAndConfirm(client, row4!.id);
    assert(after4.status === "failed" && after4.next_retry_at === null, "fila failed terminal", `${after4.status} ${after4.error ?? ""}`);
    assert((await application(client, four.appId)).qb_applied_at === null, "aplicación sin estampar");

    // ── 8 · feed del Purchase pipeline ─────────────────────────────────────
    console.log("\n── 8. feed-sql: lane apply_vendor_credit");
    const { PURCHASE_PIPELINE_FEED_SQL } = await import("../../api/admin/purchase-orders/qb-pipeline/_lib/feed-sql");
    const feed = await client.query<{ id: string; step: string; status: string; qb_list_id: string | null }>(
      `SELECT f.id, f.step, f.status, f.qb_list_id FROM (${PURCHASE_PIPELINE_FEED_SQL}) f WHERE f.id = ANY($1::text[])`,
      [[row1!.id, row2!.id, row3!.id, row4!.id].map((id) => `${id}__vendor_credit_apply`)]
    );
    assert(feed.rows.length === 4 && feed.rows.every((r) => r.step === "apply_vendor_credit"), "4 filas visibles con lane apply_vendor_credit", JSON.stringify(feed.rows));
    assert(feed.rows.some((r) => r.status === "synced" && r.qb_list_id === "1CB72E-1785290311"), "la confirmada muestra el TxnID del bill enlazado", JSON.stringify(feed.rows));
  } finally {
    await cleanup(client);
    server?.close();
    await client.end();
  }
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
