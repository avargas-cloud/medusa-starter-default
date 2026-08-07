/**
 * Reverse void audit — the direction the database cannot see.
 *
 * `qb-void-reconciler` audits "voided in POS, still alive in QB" from the DB
 * alone. The inverse ("alive/paid in POS, voided or deleted in QB") has no DB
 * signal at all — which is how POS Invoice 21281 stayed invisible for ~24h
 * after a buggy sibling void killed its QB doc. This module asks QuickBooks.
 *
 * Two signals, neither inferred from absence (absence in a windowed scan is
 * never evidence — a doc's TxnDate can sit outside any window we pick):
 *
 *  - DELETED: `TxnDeletedQueryRq`, QB's authoritative list of deletions, by
 *    deleted-date window. Response carries TxnDelType/TxnID/TimeDeleted and
 *    NO RefNumber (probed live 2026-08-07) — matching is by TxnID only.
 *  - VOIDED: header-only scans by `ModifiedDateRangeFilter` (voiding bumps
 *    TimeModified; probed live: both known voided docs surfaced with
 *    Subtotal 0.00 and memo "VOID: ..."). Flagged only when the POS side
 *    still expects money (pos_total_cents > 0), so an honestly-$0 document
 *    never fires.
 *
 * Batched: 4 bridge ops per run (1 deleted query covering 4 txn types + 3
 * header scans), never one query per document, no iterators (QB 3391 —
 * iterators are session-scoped and die across bridge ops).
 *
 * REPORTS, never repairs: findings are upserted into
 * `qb_reverse_void_finding` and the daily digest repeats them until a human
 * stamps `resolved_at`. Same decision as the direct reconciler — the DB
 * cannot distinguish "QB diverged" from "someone resolved it out-of-band",
 * so remediation of accounting documents is always a human call.
 */
import type { Pool } from "pg";

import { bridgeFetch, pollBridgeStatus } from "./bridge-fetch";

export const REVERSE_VOID_LOOKBACK_DAYS = Number(
  process.env.QB_REVERSE_VOID_LOOKBACK_DAYS || "7"
);

/** One window truncation guard — if a scan returns exactly this many rows we
 * log the truncation loudly instead of pretending we covered the window. */
export const SCAN_MAX_RETURNED = 500;

const QBXML_HEADER =
  '<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>' +
  '<QBXML><QBXMLMsgsRq onError="stopOnError">';
const QBXML_FOOTER = "</QBXMLMsgsRq></QBXML>";

export type QbScanType = "Invoice" | "SalesReceipt" | "CreditMemo";

/** Which header field carries "this document's money" per doc type. The
 * probe showed InvoiceRet has no TotalAmount — Subtotal is its amount. */
const AMOUNT_FIELD: Record<QbScanType, string[]> = {
  Invoice: ["Subtotal"],
  SalesReceipt: ["TotalAmount", "Subtotal"],
  CreditMemo: ["TotalAmount"],
};

export interface DeletedTxn {
  qb_txn_id: string;
  qb_del_type: string;
  time_deleted: string | null;
}

export interface ZeroDoc {
  qb_txn_id: string;
  qb_ref_number: string | null;
  memo: string | null;
  time_modified: string | null;
  scan_type: QbScanType;
}

export interface AliveCandidate {
  entity: "pos_invoice" | "pos_credit_memo" | "customer_payment";
  reference_id: string;
  order_id: string | null;
  medusa_ref: string | null;
  qb_txn_id: string;
  qb_ref_number: string | null;
  pos_total_cents: number;
}

export interface ReverseVoidFinding {
  doc_type: AliveCandidate["entity"];
  reference_id: string;
  order_id: string | null;
  medusa_ref: string | null;
  qb_txn_id: string;
  qb_ref_number: string | null;
  kind: "deleted" | "voided";
  qb_time_event: string | null;
  pos_total_cents: number;
}

export function buildTxnDeletedQueryQbxml(fromDate: string, toDate: string) {
  return (
    QBXML_HEADER +
    "<TxnDeletedQueryRq>" +
    "<TxnDelType>Invoice</TxnDelType>" +
    "<TxnDelType>SalesReceipt</TxnDelType>" +
    "<TxnDelType>CreditMemo</TxnDelType>" +
    "<TxnDelType>ReceivePayment</TxnDelType>" +
    "<DeletedDateRangeFilter>" +
    `<FromDeletedDate>${fromDate}</FromDeletedDate>` +
    `<ToDeletedDate>${toDate}</ToDeletedDate>` +
    "</DeletedDateRangeFilter>" +
    "</TxnDeletedQueryRq>" +
    QBXML_FOOTER
  );
}

/** Header-only on purpose: no <IncludeLineItems>. We only need TxnID, the
 * amount field and the memo, and headers keep the response small enough to
 * skip iterators entirely. */
export function buildZeroScanQbxml(
  scanType: QbScanType,
  fromDate: string,
  toDate: string
) {
  return (
    QBXML_HEADER +
    `<${scanType}QueryRq>` +
    `<MaxReturned>${SCAN_MAX_RETURNED}</MaxReturned>` +
    "<ModifiedDateRangeFilter>" +
    `<FromModifiedDate>${fromDate}</FromModifiedDate>` +
    `<ToModifiedDate>${toDate}</ToModifiedDate>` +
    "</ModifiedDateRangeFilter>" +
    `</${scanType}QueryRq>` +
    QBXML_FOOTER
  );
}

const asArray = (raw: unknown): Record<string, any>[] => {
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]) as Record<string, any>[];
};

/** Unwraps `<X>QueryRs`, enforcing QB's own statusCode — a `completed` bridge
 * op with statusCode != 0 is QB rejecting the query, not data. */
function unwrapRs(polled: unknown, rsKey: string): Record<string, any> {
  const rs = (polled as Record<string, any>)?.operation?.result?.QBXML
    ?.QBXMLMsgsRs?.[rsKey];
  if (!rs) throw new Error(`bridge response has no ${rsKey}`);
  const code = rs?.$?.statusCode;
  if (code !== "0" && code !== 0) {
    throw new Error(
      `${rsKey} statusCode=${code}: ${rs?.$?.statusMessage ?? "unknown"}`
    );
  }
  return rs;
}

export function parseTxnDeleted(polled: unknown): DeletedTxn[] {
  const rs = unwrapRs(polled, "TxnDeletedQueryRs");
  return asArray(rs.TxnDeletedRet)
    .filter((r) => typeof r.TxnID === "string" && r.TxnID)
    .map((r) => ({
      qb_txn_id: r.TxnID as string,
      qb_del_type: String(r.TxnDelType ?? ""),
      time_deleted: typeof r.TimeDeleted === "string" ? r.TimeDeleted : null,
    }));
}

export function parseZeroScan(
  polled: unknown,
  scanType: QbScanType
): { zeroDocs: ZeroDoc[]; scanned: number; truncated: boolean } {
  const rs = unwrapRs(polled, `${scanType}QueryRs`);
  const rets = asArray(rs[`${scanType}Ret`]);
  const zeroDocs: ZeroDoc[] = [];
  for (const r of rets) {
    if (typeof r.TxnID !== "string" || !r.TxnID) continue;
    const field = AMOUNT_FIELD[scanType].find((f) => r[f] !== undefined);
    const amount = field ? Number(r[field]) : NaN;
    if (!Number.isFinite(amount) || amount !== 0) continue;
    zeroDocs.push({
      qb_txn_id: r.TxnID,
      qb_ref_number: typeof r.RefNumber === "string" ? r.RefNumber : null,
      memo: typeof r.Memo === "string" ? r.Memo : null,
      time_modified: typeof r.TimeModified === "string" ? r.TimeModified : null,
      scan_type: scanType,
    });
  }
  return {
    zeroDocs,
    scanned: rets.length,
    truncated: rets.length >= SCAN_MAX_RETURNED,
  };
}

/**
 * TxnIDs currently claimed by ALIVE POS documents. "Currently claimed" is the
 * load-bearing part: a doc that went through void+recreate references its NEW
 * TxnID, so the old doc's deletion/void never fires (probed: 19659, the 21281
 * incident doc, is voided in QB and correctly unreferenced now). Likewise our
 * own pipeline's TxnDel churn (transfer/remediation) deletes docs whose
 * TxnIDs no POS document references anymore.
 *
 * First writer wins on TxnID collision, in this order: invoices, credit
 * memos, payments — so a CM-refund payment whose `qb.txn_id` mirrors the CM's
 * doc reports under the credit memo, not the payment.
 */
export async function loadAliveCandidates(
  pool: Pool
): Promise<Map<string, AliveCandidate>> {
  const map = new Map<string, AliveCandidate>();
  const add = (rows: any[], entity: AliveCandidate["entity"]) => {
    for (const r of rows) {
      if (!r.qb_txn_id || map.has(r.qb_txn_id)) continue;
      map.set(r.qb_txn_id, {
        entity,
        reference_id: r.reference_id,
        order_id: r.order_id ?? null,
        medusa_ref: r.medusa_ref ?? null,
        qb_txn_id: r.qb_txn_id,
        qb_ref_number: r.qb_ref_number ?? null,
        pos_total_cents: Number(r.pos_total_cents ?? 0),
      });
    }
  };

  const invoices = await pool.query(
    `SELECT d.id AS reference_id, d.invoice_number AS medusa_ref, d.order_id,
            ROUND(d.total * 100)::bigint AS pos_total_cents,
            COALESCE(NULLIF(d.metadata->>'qb_txn_id', ''), p.qb_txn_id) AS qb_txn_id,
            COALESCE(NULLIF(d.metadata->>'qb_ref_number', ''), p.qb_ref_number) AS qb_ref_number
       FROM pos_invoice d
       LEFT JOIN LATERAL (
         SELECT qb_txn_id, qb_ref_number
           FROM qb_order_pipeline
          WHERE reference_id = d.id
            AND step IN ('invoice', 'sales_receipt')
            AND status IN ('confirmed', 'fixed')
            AND qb_txn_id IS NOT NULL
          ORDER BY confirmed_at DESC NULLS LAST, seq DESC
          LIMIT 1
       ) p ON true
      WHERE d.status <> 'voided'
        AND d.voided_at IS NULL
        AND d.deleted_at IS NULL
        AND COALESCE(NULLIF(d.metadata->>'qb_txn_id', ''), p.qb_txn_id) IS NOT NULL`
  );
  add(invoices.rows, "pos_invoice");

  const creditMemos = await pool.query(
    `SELECT d.id AS reference_id, d.credit_memo_number AS medusa_ref, d.order_id,
            ROUND(d.total * 100)::bigint AS pos_total_cents,
            d.qb_txn_id, NULL::text AS qb_ref_number
       FROM pos_credit_memo d
      WHERE d.status <> 'voided'
        AND d.voided_at IS NULL
        AND d.deleted_at IS NULL
        AND d.qb_txn_id IS NOT NULL`
  );
  add(creditMemos.rows, "pos_credit_memo");

  // Payments: only rows with their own confirmed ReceivePayment. SR-embedded
  // payments (qb.source = 'sales_receipt') have no ReceivePayment of their
  // own — their doc is the SR, already covered by the invoice candidates.
  // `refunded` is excluded: its refund flow legitimately TxnDels $0 applies.
  const payments = await pool.query(
    `SELECT cp.id AS reference_id,
            'PAY-' || cp.display_id AS medusa_ref,
            cp.locked_order_id AS order_id,
            ROUND(cp.amount * 100)::bigint AS pos_total_cents,
            COALESCE(NULLIF(cp.qb->>'txn_id', ''), p.qb_txn_id) AS qb_txn_id,
            p.qb_ref_number
       FROM customer_payment cp
       LEFT JOIN LATERAL (
         SELECT qb_txn_id, qb_ref_number
           FROM qb_order_pipeline
          WHERE reference_id = cp.id
            AND step = 'payment'
            AND status IN ('confirmed', 'fixed')
            AND qb_txn_id IS NOT NULL
          ORDER BY confirmed_at DESC NULLS LAST, seq DESC
          LIMIT 1
       ) p ON true
      WHERE cp.deleted_at IS NULL
        AND cp.status IN ('applied', 'partially_applied', 'available')
        AND COALESCE(cp.qb->>'source', '') <> 'sales_receipt'
        AND COALESCE(NULLIF(cp.qb->>'txn_id', ''), p.qb_txn_id) IS NOT NULL`
  );
  add(payments.rows, "customer_payment");

  return map;
}

/** Pure comparison — the piece unit tests and the sandbox E2E exercise. */
export function compareScanToCandidates(input: {
  candidates: Map<string, AliveCandidate>;
  deleted: DeletedTxn[];
  zeroDocs: ZeroDoc[];
}): ReverseVoidFinding[] {
  const findings: ReverseVoidFinding[] = [];

  for (const d of input.deleted) {
    const c = input.candidates.get(d.qb_txn_id);
    if (!c) continue;
    findings.push({
      doc_type: c.entity,
      reference_id: c.reference_id,
      order_id: c.order_id,
      medusa_ref: c.medusa_ref,
      qb_txn_id: c.qb_txn_id,
      qb_ref_number: c.qb_ref_number,
      kind: "deleted",
      qb_time_event: d.time_deleted,
      pos_total_cents: c.pos_total_cents,
    });
  }

  for (const z of input.zeroDocs) {
    const c = input.candidates.get(z.qb_txn_id);
    // pos_total_cents > 0 is the guard against honestly-$0 documents.
    if (!c || c.pos_total_cents <= 0) continue;
    findings.push({
      doc_type: c.entity,
      reference_id: c.reference_id,
      order_id: c.order_id,
      medusa_ref: c.medusa_ref,
      qb_txn_id: c.qb_txn_id,
      qb_ref_number: c.qb_ref_number ?? z.qb_ref_number,
      kind: "voided",
      qb_time_event: z.time_modified,
      pos_total_cents: c.pos_total_cents,
    });
  }

  return findings;
}

/** Upsert keyed by (qb_txn_id, kind): re-detection refreshes last_seen_at and
 * never resets first_seen_at nor un-resolves a human-resolved finding. */
export async function persistFindings(
  pool: Pool,
  findings: ReverseVoidFinding[]
): Promise<{ inserted: number; refreshed: number }> {
  let inserted = 0;
  let refreshed = 0;
  for (const f of findings) {
    const res = await pool.query(
      `INSERT INTO qb_reverse_void_finding
         (doc_type, reference_id, order_id, medusa_ref, qb_txn_id,
          qb_ref_number, kind, qb_time_event, pos_total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ON CONSTRAINT "UQ_qb_reverse_void_finding_txn_kind"
       DO UPDATE SET last_seen_at = now()
       RETURNING (xmax = 0) AS was_inserted`,
      [
        f.doc_type,
        f.reference_id,
        f.order_id,
        f.medusa_ref,
        f.qb_txn_id,
        f.qb_ref_number,
        f.kind,
        f.qb_time_event,
        f.pos_total_cents,
      ]
    );
    if (res.rows[0]?.was_inserted) inserted += 1;
    else refreshed += 1;
  }
  return { inserted, refreshed };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submit one raw query and poll it to completion. The bridge processes ops
 * serially and the QBWC cycle takes 20-60s, so patience here is normal. */
async function runBridgeQuery(qbxml: string): Promise<unknown> {
  const submit = await bridgeFetch<{ operationId?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 }
  );
  if (!submit?.operationId) {
    throw new Error("bridge returned no operationId for reverse-void query");
  }
  for (let i = 0; i < 30; i++) {
    await sleep(6_000);
    const polled = await pollBridgeStatus(submit.operationId);
    if (polled.status === "expired") {
      throw new Error(`bridge op ${submit.operationId} expired`);
    }
    if (polled.status === "completed") return polled.data;
    if (polled.status === "failed") {
      const err = (polled.data as any)?.operation?.error;
      // An early poll can transiently report "failed" with no error attached.
      if (err) {
        throw new Error(
          `bridge op ${submit.operationId} failed: ${String(err).slice(0, 200)}`
        );
      }
    }
  }
  throw new Error(`bridge op ${submit.operationId} did not complete in time`);
}

export interface SweepSummary {
  candidates: number;
  deleted_in_window: number;
  zero_docs_in_window: number;
  findings: number;
  inserted: number;
  truncated_scans: string[];
}

export async function runReverseVoidSweep(
  pool: Pool,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  opts?: { lookbackDays?: number }
): Promise<SweepSummary> {
  const lookback = opts?.lookbackDays ?? REVERSE_VOID_LOOKBACK_DAYS;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - lookback * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const candidates = await loadAliveCandidates(pool);

  const deleted = parseTxnDeleted(
    await runBridgeQuery(buildTxnDeletedQueryQbxml(from, to))
  );

  const zeroDocs: ZeroDoc[] = [];
  const truncated: string[] = [];
  for (const scanType of ["Invoice", "SalesReceipt", "CreditMemo"] as const) {
    const scan = parseZeroScan(
      await runBridgeQuery(buildZeroScanQbxml(scanType, from, to)),
      scanType
    );
    zeroDocs.push(...scan.zeroDocs);
    if (scan.truncated) {
      truncated.push(scanType);
      logger.warn(
        `[reverse-void-sweep] ${scanType} scan hit MaxReturned=${SCAN_MAX_RETURNED} — ` +
          `window ${from}→${to} NOT fully covered; shrink the window or split it`
      );
    }
  }

  const findings = compareScanToCandidates({ candidates, deleted, zeroDocs });
  const persisted = await persistFindings(pool, findings);

  logger.info(
    `[reverse-void-sweep] window ${from}→${to}: ${candidates.size} alive candidates, ` +
      `${deleted.length} deletions and ${zeroDocs.length} zeroed docs in QB, ` +
      `${findings.length} finding(s) (${persisted.inserted} new)`
  );

  return {
    candidates: candidates.size,
    deleted_in_window: deleted.length,
    zero_docs_in_window: zeroDocs.length,
    findings: findings.length,
    inserted: persisted.inserted,
    truncated_scans: truncated,
  };
}
