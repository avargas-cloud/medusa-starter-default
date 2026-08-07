/**
 * Remediates ReceivePayments whose applications were clobbered by the
 * merge-apply bug (ReceivePaymentQuery without IncludeLineItems → every apply
 * sent a single-application REPLACE-ALL Mod, silently unapplying the rest).
 *
 * Source of truth: payment_application (active rows) in the POS DB.
 * For each non-credit-memo payment with ≥2 active applications on distinct
 * invoices, compares the live QB applied list against the DB expectation and
 * (in APPLY mode) issues ONE ReceivePaymentMod per payment with the FULL list.
 *
 * READ-ONLY by default. APPLY=true enables writes to QuickBooks (Mods only —
 * never ADD/DELETE; header fields TotalAmount/TxnDate/Memo/Method untouched).
 * ONLY=cpay_xxx limits the run to one payment.
 *
 * Run:  DRY:   ./node_modules/.bin/tsx src/scripts/fix/remediate-clobbered-payment-applications.ts
 *       APPLY: APPLY=true ./node_modules/.bin/tsx src/scripts/fix/remediate-clobbered-payment-applications.ts
 * Env: DATABASE_URL, QB_BRIDGE_URL, QB_API_KEY (source from backend/.env).
 *
 * Abort rules:
 *  - Live query returns 0 AppliedToTxnRet while the header shows applied money
 *    → the bridge fix is NOT live → abort the whole run (proceeding would clobber).
 *  - Transport error against the bridge → abort (per the 2026-07-28 rule).
 *  - QB op failure on one payment → record, continue with the next.
 *  - Extra applications in QB that the DB doesn't know → HOLD (skipped in APPLY).
 */
import { Pool } from "pg";
import * as fs from "fs";

const APPLY = process.env.APPLY === "true";
const ONLY = process.env.ONLY || null;
const BRIDGE = (process.env.QB_BRIDGE_URL || "").replace(/\/$/, "");
const KEY = process.env.QB_API_KEY || "";
const OUT =
  process.env.OUT_FILE ||
  `/tmp/qb-apply-remediation-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const POLL_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 5_000;

type AppLine = { invoiceTxnId: string; cents: number; invoiceNumber?: string };
type LiveState = {
  editSequence: string;
  customerListId: string | null;
  totalAmount: number;
  unusedPayment: number;
  applied: { invoiceTxnId: string; cents: number }[];
};

function fail(msg: string): never {
  console.error(`\n⛔ ABORT: ${msg}`);
  process.exit(1);
}

async function bridge(path: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE}${path}`, {
      headers: { "x-api-key": KEY, "bypass-tunnel-reminder": "true" },
    });
  } catch (e: any) {
    fail(`transport error on GET ${path}: ${e?.message} — not retrying blindly`);
  }
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

async function bridgePost(path: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE}${path}`, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "content-type": "application/json",
        "bypass-tunnel-reminder": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    fail(`transport error on POST ${path}: ${e?.message} — outcome of prior ops is recorded in ${OUT}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function pollOp(opId: string): Promise<any> {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > POLL_TIMEOUT_MS)
      throw new Error(`op ${opId} not completed after ${POLL_TIMEOUT_MS / 1000}s`);
    const d = await bridge(`/api/sync/status/${opId}`);
    const st = d?.operation?.status;
    if (st === "completed") return d.operation;
    if (st === "failed")
      throw new Error(`op ${opId} FAILED: ${JSON.stringify(d.operation?.error ?? d.operation?.result ?? {}).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function fetchLive(paymentTxnId: string): Promise<LiveState> {
  const q = await bridge(`/api/payments/${paymentTxnId}`);
  const opId = q?.operationId;
  if (!opId) throw new Error("no operationId for payment query");
  const op = await pollOp(opId);
  const msgs = op?.result?.QBXML?.QBXMLMsgsRs ?? op?.result ?? {};
  let ret = msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet;
  if (Array.isArray(ret)) ret = ret[0];
  if (!ret) throw new Error(`no ReceivePaymentRet for ${paymentTxnId}`);
  let applied = ret.AppliedToTxnRet ?? [];
  if (!Array.isArray(applied)) applied = [applied];
  const total = parseFloat(String(ret.TotalAmount ?? "0"));
  const unused = parseFloat(String(ret.UnusedPayment ?? "0"));
  const lines = applied
    .map((a: any) => ({
      invoiceTxnId: String(a?.TxnID || ""),
      cents: Math.round(Math.abs(parseFloat(String(a?.Amount ?? a?.PaymentAmount ?? "0"))) * 100),
    }))
    .filter((a: any) => a.invoiceTxnId && a.cents > 0);
  if (lines.length === 0 && total - unused > 0.005)
    fail(
      `payment ${paymentTxnId}: header shows $${(total - unused).toFixed(2)} applied but query returned NO AppliedToTxnRet — the bridge IncludeLineItems fix is NOT live. Running APPLY now would clobber.`
    );
  return {
    editSequence: String(ret.EditSequence ?? ""),
    customerListId: ret?.CustomerRef?.ListID ? String(ret.CustomerRef.ListID) : null,
    totalAmount: total,
    unusedPayment: unused,
    applied: lines,
  };
}

async function main() {
  if (!process.env.DATABASE_URL || !BRIDGE || !KEY)
    fail("DATABASE_URL, QB_BRIDGE_URL and QB_API_KEY are required (source backend/.env)");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const report: any[] = [];

  const { rows: payments } = await pool.query(
    `SELECT cp.id, cp.display_id, cp.amount::numeric AS amount,
            cp.metadata->>'qb_txn_id' AS qb_txn_id
       FROM customer_payment cp
      WHERE cp.type != 'credit_memo'
        AND ($1::text IS NULL OR cp.id = $1)
        AND (SELECT count(DISTINCT pa.invoice_id) FROM payment_application pa
              WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL) > 1
      ORDER BY cp.display_id`,
    [ONLY]
  );
  console.log(`${APPLY ? "🔧 APPLY" : "🔎 DRY-RUN"} — ${payments.length} multi-invoice payment(s) in scope\n`);

  for (const p of payments) {
    const tag = `PAY-${p.display_id} (${p.id})`;
    const entry: any = { payment: tag, qb_txn_id: p.qb_txn_id, verdict: "?", detail: {} };
    report.push(entry);
    try {
      if (!p.qb_txn_id) {
        entry.verdict = "SKIP_NO_PAYMENT_TXN";
        console.log(`⏭️  ${tag}: no qb_txn_id in metadata — skipped`);
        continue;
      }
      const { rows: apps } = await pool.query(
        `SELECT pa.invoice_id, pa.invoice_number,
                SUM(pa.amount_applied)::bigint AS cents,
                COALESCE(pi.metadata->>'qb_txn_id',
                  (SELECT q.qb_txn_id FROM qb_order_pipeline q
                    WHERE q.reference_id = pa.invoice_id
                      AND q.step IN ('invoice','sales_receipt')
                      AND q.status = 'confirmed' AND q.qb_txn_id IS NOT NULL
                    ORDER BY q.confirmed_at DESC LIMIT 1)) AS invoice_txn_id
           FROM payment_application pa
           LEFT JOIN pos_invoice pi ON pi.id = pa.invoice_id
          WHERE pa.payment_id = $1 AND pa.voided_at IS NULL
          GROUP BY pa.invoice_id, pa.invoice_number, pi.metadata
         HAVING SUM(pa.amount_applied) > 0`,
        [p.id]
      );
      const unresolved = apps.filter((a) => !a.invoice_txn_id);
      if (unresolved.length > 0) {
        entry.verdict = "SKIP_UNRESOLVED_INVOICE_TXN";
        entry.detail.unresolved = unresolved.map((u) => u.invoice_number);
        console.log(`⏭️  ${tag}: unresolved invoice TxnID for ${unresolved.map((u) => u.invoice_number).join(", ")} — skipped`);
        continue;
      }
      const expected: AppLine[] = apps.map((a) => ({
        invoiceTxnId: String(a.invoice_txn_id),
        cents: Number(a.cents),
        invoiceNumber: a.invoice_number,
      }));
      const expectedTotal = expected.reduce((s, a) => s + a.cents, 0);
      const paymentCents = Math.round(Number(p.amount));
      if (expectedTotal > paymentCents + 1) {
        entry.verdict = "SKIP_OVERAPPLIED_IN_DB";
        entry.detail = { expectedTotal, paymentCents };
        console.log(`⏭️  ${tag}: DB expects ${expectedTotal}¢ > payment ${paymentCents}¢ — data problem, skipped`);
        continue;
      }

      const live = await fetchLive(p.qb_txn_id);
      entry.detail.pre = live;
      const liveMap = new Map(live.applied.map((a) => [a.invoiceTxnId, a.cents]));
      const expMap = new Map(expected.map((a) => [a.invoiceTxnId, a.cents]));
      const missing = expected.filter((a) => !liveMap.has(a.invoiceTxnId));
      const diff = expected.filter((a) => liveMap.has(a.invoiceTxnId) && liveMap.get(a.invoiceTxnId) !== a.cents);
      const extra = live.applied.filter((a) => !expMap.has(a.invoiceTxnId));
      entry.detail.compare = { missing, diff, extra };

      if (extra.length > 0) {
        entry.verdict = "HOLD_EXTRA_IN_QB";
        console.log(`✋ ${tag}: QB has ${extra.length} application(s) the DB doesn't know (${extra.map((e) => e.invoiceTxnId).join(", ")}) — human review, NOT touched`);
        continue;
      }
      if (missing.length === 0 && diff.length === 0) {
        entry.verdict = "OK";
        console.log(`✅ ${tag}: QB matches DB (${expected.length} application(s))`);
        continue;
      }
      entry.verdict = "NEEDS_FIX";
      console.log(
        `🩹 ${tag}: needs fix — missing ${missing.length} (${missing.map((m) => m.invoiceNumber).join(", ") || "-"}), amount-diff ${diff.length}; ` +
          `QB unused $${live.unusedPayment.toFixed(2)} → should be $${((paymentCents - expectedTotal) / 100).toFixed(2)}`
      );

      if (!APPLY) continue;
      if (!live.customerListId) throw new Error("live payment has no CustomerRef.ListID");
      const applications = expected.map((a) => ({ invoiceId: a.invoiceTxnId, amount: a.cents / 100 }));
      const enq = await bridgePost(`/api/payments/${p.qb_txn_id}/merge-apply`, {
        customerId: live.customerListId,
        editSequence: live.editSequence,
        applications,
      });
      if (!enq?.operationId) throw new Error("merge-apply returned no operationId");
      await pollOp(enq.operationId);
      const post = await fetchLive(p.qb_txn_id);
      entry.detail.post = post;
      const wantUnused = (paymentCents - expectedTotal) / 100;
      const okUnused = Math.abs(post.unusedPayment - wantUnused) <= 0.01 * expected.length;
      const okCount = post.applied.length === expected.length;
      entry.verdict = okUnused && okCount ? "FIXED_VERIFIED" : "FIXED_BUT_VERIFY_MISMATCH";
      console.log(
        `${okUnused && okCount ? "✅" : "⚠️"} ${tag}: mod applied — QB now ${post.applied.length} application(s), unused $${post.unusedPayment.toFixed(2)} (expected $${wantUnused.toFixed(2)})`
      );
    } catch (e: any) {
      entry.verdict = "ERROR";
      entry.detail.error = e?.message;
      console.log(`❌ ${tag}: ${e?.message} — continuing with next payment`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ apply: APPLY, at: new Date().toISOString(), report }, null, 2));
  const counts: Record<string, number> = {};
  for (const r of report) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  console.log(`\n📄 Snapshot: ${OUT}`);
  console.log(`Summary: ${JSON.stringify(counts)}`);
  await pool.end();
}

main().catch((e) => fail(e?.message || String(e)));
