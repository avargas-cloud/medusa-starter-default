/**
 * match-unbilled-pos-to-unlinked-bills.ts (read-only, prod)
 *
 * Owner challenge (2026-07-24): "are we SURE the billed=NO POs have no bill in
 * QB?" The reconciliation matched bills via LinkedTxn (bill→PO / bill→receipt),
 * so a bill the accountant entered WITHOUT linking the PO was ignored and its
 * PO reads a false "No". This sweeps QB bills again (same date-window chunking)
 * and fuzzy-matches the unlinked ones against unbilled POs by:
 *   vendor name (ILIKE-normalized) + amount (±1% or ±$1) [+ date proximity].
 * Report-only — never writes anywhere.
 */
import type { ExecArgs } from "@medusajs/framework/types";

type Knex = { raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };

const PAGE_MAX = 500;
const WINDOW_DAYS = 14;

function bridgeEnv(): { url: string; key: string } {
  const url = process.env.QB_BRIDGE_URL;
  const key = process.env.QB_API_KEY;
  if (!url || !key) throw new Error("QB_BRIDGE_URL / QB_API_KEY required");
  return { url, key };
}

async function bridgePost(path: string, body: unknown): Promise<{ operationId?: string }> {
  const { url, key } = bridgeEnv();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "bypass-tunnel-reminder": "true" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
  return (await res.json()) as { operationId?: string };
}

async function pollOp(opId: string): Promise<unknown> {
  const { url, key } = bridgeEnv();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${url}/api/sync/status/${opId}`, {
      headers: { "x-api-key": key, "bypass-tunnel-reminder": "true" },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { operation?: { status?: string; error?: string; result?: unknown } };
    const st = data.operation?.status;
    if (st === "completed") return data.operation?.result;
    if (st === "failed") throw new Error(`op failed: ${data.operation?.error}`);
  }
  throw new Error("poll timeout");
}

const asArray = <T,>(v: T | T[] | undefined | null): T[] =>
  v == null ? [] : Array.isArray(v) ? v : [v];

interface QbBill {
  txnId: string;
  refNumber: string | null;
  txnDate: string | null;
  vendor: string | null;
  amount: number | null;
  hasPoLink: boolean;
  hasReceiptLink: boolean;
}

async function sweep(from: string): Promise<QbBill[]> {
  const out: QbBill[] = [];
  const seen = new Set<string>();
  let cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date();
  while (cursor <= end) {
    const winEnd = new Date(Math.min(cursor.getTime() + (WINDOW_DAYS - 1) * 86400e3, end.getTime()));
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const { operationId } = await bridgePost("/api/bills/query", {
      from_date: fmt(cursor), to_date: fmt(winEnd), max_returned: PAGE_MAX,
    });
    if (!operationId) throw new Error("no operationId");
    const result = (await pollOp(operationId)) as Record<string, any>;
    const rs = result?.QBXML?.QBXMLMsgsRs?.BillQueryRs;
    for (const raw of asArray<Record<string, any>>(rs?.BillRet)) {
      const txnId = String(raw?.TxnID ?? "");
      if (!txnId || seen.has(txnId)) continue;
      seen.add(txnId);
      const links = asArray<Record<string, any>>(raw?.LinkedTxn);
      out.push({
        txnId,
        refNumber: raw?.RefNumber ?? null,
        txnDate: raw?.TxnDate ?? null,
        vendor: raw?.VendorRef?.FullName ?? null,
        amount: raw?.AmountDue != null && Number.isFinite(Number(raw.AmountDue)) ? Number(raw.AmountDue) : null,
        hasPoLink: links.some((l) => l?.TxnType === "PurchaseOrder"),
        hasReceiptLink: links.some((l) => l?.TxnType === "ItemReceipt"),
      });
    }
    cursor = new Date(winEnd.getTime() + 86400e3);
  }
  return out;
}

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);

export default async function matchUnbilledPos({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as unknown as Knex;

  const unbilled = (await knex.raw(`
    SELECT po.id, po.number, po.vendor_name_snapshot AS vendor,
           po.total_cents / 100.0 AS total, po.status,
           to_char(po.submitted_at, 'YYYY-MM-DD') AS submitted
      FROM purchase_order po
     WHERE po.deleted_at IS NULL
       AND po.status IN ('submitted','partially_received','received')
       AND NOT EXISTS (
         SELECT 1 FROM vendor_bill vb
          WHERE vb.purchase_order_id = po.id AND vb.deleted_at IS NULL
            AND vb.bill_type = 'regular' AND vb.status IN ('confirmed','synced'))
     ORDER BY po.number`)).rows as Array<{
    id: string; number: string; vendor: string | null; total: number; status: string; submitted: string | null;
  }>;

  console.log(`${unbilled.length} unbilled PO(s). Sweeping QB bills...`);
  const bills = await sweep("2026-03-01");
  const unlinked = bills.filter((b) => !b.hasPoLink && !b.hasReceiptLink);
  console.log(`${bills.length} bills swept — ${unlinked.length} with NO PO/receipt link\n`);

  for (const po of unbilled) {
    const vkey = norm(po.vendor);
    const candidates = unlinked.filter((b) => {
      if (norm(b.vendor) !== vkey) return false;
      if (b.amount == null) return false;
      const diff = Math.abs(b.amount - Number(po.total));
      return diff <= Math.max(1, Number(po.total) * 0.01);
    });
    const flag = candidates.length > 0 ? "🔎 POSSIBLE MATCH" : "   no candidate";
    console.log(
      `${po.number.padEnd(9)} ${String(po.vendor ?? "").slice(0, 22).padEnd(22)} $${Number(po.total).toFixed(2).padStart(9)} ${po.status.padEnd(20)} ${flag}` +
        (candidates.length
          ? " → " + candidates.map((c) => `${c.refNumber ?? "?"} $${c.amount?.toFixed(2)} ${c.txnDate} @${c.txnId.slice(0, 10)}`).join(" | ")
          : "")
    );
  }
}
