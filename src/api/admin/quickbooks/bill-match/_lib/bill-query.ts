/**
 * QB Bill Match — bridge query layer.
 *
 * Submits a bounded `BillQuery` to the QuickBooks bridge, polls it to
 * completion, and parses the returned `BillRet[]` into a normalized shape the
 * routes can reason about. There is NO server-side vendor filter in the bridge
 * BillQuery builder, so we sweep by TxnDate window and filter by
 * `VendorRef.ListID` here (client-side, per the reconciliation precedent).
 *
 * Iterators never span bridge ops (QB 3391), so bulk reads are self-contained
 * date windows: if a window returns exactly `max_returned` we split it in half
 * and recurse rather than paging with a cursor.
 */

import { bridgeFetch, pollBridgeStatus } from "../../../../../lib/quickbooks/bridge-fetch";

const MAX_RETURNED = 500;
const POLL_INTERVAL_MS = 6_000;
const MAX_POLL_ATTEMPTS = 25;

/** QBXML collapses a single child to an object; normalize to an array. */
function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Money/decimal fields arrive as strings from QBXML; coerce safely. */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Dollars string → integer cents, rounded (avoids IEEE-754 noise). */
function toCents(v: unknown): number {
  return Math.round(num(v) * 100);
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

export interface QbBillLinkedTxn {
  txn_type: string;
  txn_id: string;
}

export interface QbBillItemLine {
  txn_line_id: string;
  item_list_id: string;
  item_full_name: string;
  quantity: number;
  cost_cents: number;
  amount_cents: number;
  /** LinkToTxn present on the line → the PO/receipt TxnID+TxnLineID it links to. */
  linked_txn_id: string;
  linked_txn_line_id: string;
}

export interface QbBillExpenseLine {
  txn_line_id: string;
  account_list_id: string;
  account_full_name: string;
  amount_cents: number;
  memo: string;
}

export interface QbBill {
  txn_id: string;
  edit_sequence: string;
  ref_number: string;
  txn_date: string;
  memo: string;
  vendor_list_id: string;
  vendor_full_name: string;
  amount_due_cents: number;
  /** Sum of item + expense line amounts (the bill's own total, not AmountDue). */
  total_cents: number;
  item_lines: QbBillItemLine[];
  expense_lines: QbBillExpenseLine[];
  linked_txns: QbBillLinkedTxn[];
}

type BridgeMsgs = Record<string, unknown> | undefined;

function extractMsgs(data: { operation?: { result?: unknown } }): BridgeMsgs {
  const result = data.operation?.result as
    | { QBXML?: { QBXMLMsgsRs?: Record<string, unknown> }; QBXMLMsgsRs?: Record<string, unknown> }
    | undefined;
  return result?.QBXML?.QBXMLMsgsRs ?? result?.QBXMLMsgsRs;
}

function parseItemLine(raw: Record<string, unknown>): QbBillItemLine {
  const itemRef = (raw.ItemRef ?? {}) as Record<string, unknown>;
  const linkToTxn = (raw.LinkToTxn ?? {}) as Record<string, unknown>;
  return {
    txn_line_id: str(raw.TxnLineID),
    item_list_id: str(itemRef.ListID),
    item_full_name: str(itemRef.FullName),
    quantity: num(raw.Quantity),
    cost_cents: toCents(raw.Cost),
    amount_cents: toCents(raw.Amount),
    linked_txn_id: str(linkToTxn.TxnID),
    linked_txn_line_id: str(linkToTxn.TxnLineID),
  };
}

function parseExpenseLine(raw: Record<string, unknown>): QbBillExpenseLine {
  const accountRef = (raw.AccountRef ?? {}) as Record<string, unknown>;
  return {
    txn_line_id: str(raw.TxnLineID),
    account_list_id: str(accountRef.ListID),
    account_full_name: str(accountRef.FullName),
    amount_cents: toCents(raw.Amount),
    memo: str(raw.Memo),
  };
}

export function parseBillRet(raw: Record<string, unknown>): QbBill {
  const vendorRef = (raw.VendorRef ?? {}) as Record<string, unknown>;
  const itemLines = toArray(raw.ItemLineRet as Record<string, unknown> | Record<string, unknown>[]).map(
    parseItemLine
  );
  const expenseLines = toArray(
    raw.ExpenseLineRet as Record<string, unknown> | Record<string, unknown>[]
  ).map(parseExpenseLine);
  const linkedTxns = toArray(raw.LinkedTxn as Record<string, unknown> | Record<string, unknown>[]).map(
    (lt) => ({ txn_type: str(lt.TxnType), txn_id: str(lt.TxnID) })
  );
  const totalCents =
    itemLines.reduce((s, l) => s + l.amount_cents, 0) +
    expenseLines.reduce((s, l) => s + l.amount_cents, 0);
  return {
    txn_id: str(raw.TxnID),
    edit_sequence: str(raw.EditSequence),
    ref_number: str(raw.RefNumber),
    txn_date: str(raw.TxnDate),
    memo: str(raw.Memo),
    vendor_list_id: str(vendorRef.ListID),
    vendor_full_name: str(vendorRef.FullName),
    amount_due_cents: toCents(raw.AmountDue),
    total_cents: totalCents,
    item_lines: itemLines,
    expense_lines: expenseLines,
    linked_txns: linkedTxns,
  };
}

async function submitBillQuery(fromDate: string, toDate: string): Promise<string> {
  const res = await bridgeFetch<{ operationId?: string; operation_id?: string; error?: string }>(
    "/api/bills/query",
    {
      method: "POST",
      body: { from_date: fromDate, to_date: toDate, max_returned: MAX_RETURNED },
      timeoutMs: 30_000,
    }
  );
  const opId = res.operationId ?? res.operation_id;
  if (!opId) throw new Error(res.error ?? "Bridge returned no operationId for BillQuery");
  return opId;
}

async function pollForBillRets(operationId: string): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const result = await pollBridgeStatus(operationId);
    if (result.status === "expired") throw new Error("Bridge operation expired (QuickBooks may be offline)");
    if (result.status === "completed") {
      const msgs = extractMsgs(result.data as { operation?: { result?: unknown } });
      const billQueryRs = (msgs?.BillQueryRs ?? {}) as Record<string, unknown>;
      const statusCode = str(billQueryRs.statusCode);
      // statusCode "1" = "no matching records" — a valid empty result, not an error.
      if (statusCode && statusCode !== "0" && statusCode !== "1") {
        throw new Error(`QuickBooks rejected BillQuery (status ${statusCode}: ${str(billQueryRs.statusMessage)})`);
      }
      return toArray(billQueryRs.BillRet as Record<string, unknown> | Record<string, unknown>[]);
    }
    if (result.status === "failed") {
      const opErr = (result.data as { operation?: { error?: string } }).operation?.error ?? "";
      // Early "failed" with no error can be a transient pre-processing blip; keep polling.
      if (opErr && opErr !== "None") throw new Error(`Bridge BillQuery failed: ${opErr}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("BillQuery timed out (QuickBooks Desktop may be offline or busy)");
}

/**
 * Sweep QB bills in [fromDate, toDate] (YYYY-MM-DD), filtered to one vendor by
 * ListID. Splits the window in half if a sweep hits the MAX_RETURNED cap
 * (iterators can't span bridge ops). De-dupes by TxnID across split windows.
 */
export async function queryVendorBills(args: {
  vendorListId: string;
  fromDate: string;
  toDate: string;
}): Promise<QbBill[]> {
  const { vendorListId, fromDate, toDate } = args;
  const seen = new Map<string, QbBill>();

  async function sweep(from: string, to: string, depth: number): Promise<void> {
    const opId = await submitBillQuery(from, to);
    const rets = await pollForBillRets(opId);
    if (rets.length >= MAX_RETURNED && depth < 6 && from < to) {
      // Window is capped — split by date midpoint and recurse for completeness.
      const mid = midpointDate(from, to);
      if (mid && mid !== from && mid !== to) {
        await sweep(from, mid, depth + 1);
        await sweep(nextDay(mid), to, depth + 1);
        return;
      }
    }
    for (const ret of rets) {
      const bill = parseBillRet(ret);
      if (vendorListId && bill.vendor_list_id !== vendorListId) continue;
      if (bill.txn_id) seen.set(bill.txn_id, bill);
    }
  }

  await sweep(fromDate, toDate, 0);
  return [...seen.values()].sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1));
}

/** Fetch a single bill by its QB TxnID (authoritative re-query at adopt time). */
export async function queryBillByTxnId(txnId: string): Promise<QbBill | null> {
  const res = await bridgeFetch<{ operationId?: string; operation_id?: string; error?: string }>(
    "/api/bills/query",
    { method: "POST", body: { txn_id: txnId }, timeoutMs: 30_000 }
  );
  const opId = res.operationId ?? res.operation_id;
  if (!opId) throw new Error(res.error ?? "Bridge returned no operationId for BillQuery(txn_id)");
  const rets = await pollForBillRets(opId);
  const match = rets.map(parseBillRet).find((b) => b.txn_id === txnId);
  return match ?? null;
}

// --- date helpers (UTC-safe, no Date.now / no local-tz day shift) ---

function parseYmd(d: string): { y: number; m: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), day: Number(m[3]) };
}

function midpointDate(from: string, to: string): string | null {
  const a = parseYmd(from);
  const b = parseYmd(to);
  if (!a || !b) return null;
  const ta = Date.UTC(a.y, a.m - 1, a.day);
  const tb = Date.UTC(b.y, b.m - 1, b.day);
  const tm = ta + Math.floor((tb - ta) / 2);
  return fmtUtc(tm);
}

function nextDay(d: string): string {
  const a = parseYmd(d);
  if (!a) return d;
  return fmtUtc(Date.UTC(a.y, a.m - 1, a.day) + 86_400_000);
}

function fmtUtc(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
