/**
 * close-orphan-invoiced-sos.ts
 *
 * Repair for the "Full SO→Invoice drops LinkToTxnID → SO stays Open" bug
 * (see docs/SO_INVOICE_LINK_FIX_PLAN.md). For every order that went through
 * the estimate/SO→invoice conversion AND whose Sales Order is still OPEN in QB
 * (not fully-invoiced, not manually-closed), marks the SO closed in QuickBooks
 * via closeSalesOrderInQb() (sets IsManuallyClosed). The invoices already exist
 * and are financially correct — the SO link cannot be retrofit via InvoiceMod,
 * so a controlled close is the safe repair (cosmetic loss of the SO↔Invoice
 * link only; chosen over void+recreate for posted/paid invoices).
 *
 * Re-queries each SO's live status immediately before closing (idempotent —
 * skips anything already closed / not found), so it is safe to re-run and does
 * NOT depend on a stale audit snapshot.
 *
 * Usage:
 *   # DRY-RUN (default — lists what WOULD be closed, no writes):
 *   npx ts-node -r tsconfig-paths/register src/scripts/fix/close-orphan-invoiced-sos.ts
 *   # APPLY (actually closes the orphan-open SOs in QB):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/fix/close-orphan-invoiced-sos.ts
 *   # Limit to specific SO refs (comma-separated), e.g. exclude one you closed by hand:
 *   APPLY=true ONLY=6285,6287 npx ts-node ...
 */

import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const APPLY = process.env.APPLY === "true";
const ONLY = (process.env.ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

import {
  bridgeFetch,
  pollRawOperationResult,
} from "../../lib/quickbooks/client/core";
import { closeSalesOrderInQb } from "../../lib/quickbooks/client/sales-orders";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

type Row = {
  display_id: number;
  so_txn_id: string;
  so_ref: string | null;
  doc_number: string | null;
  order_total: string | null;
  invoiced: string | null;
};

async function soStatus(soTxnId: string): Promise<{
  found: boolean;
  open: boolean;
  detail: string;
}> {
  const queryResp = await bridgeFetch("GET", `/api/sales-orders/${soTxnId}`);
  const opId = queryResp?.operationId;
  if (!opId) return { found: false, open: false, detail: "no operationId" };
  const raw = await pollRawOperationResult(opId);
  const soRet =
    raw?.QBXML?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
    raw?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
    raw?.SalesOrderRet ??
    raw?.SalesOrderQueryRs?.SalesOrderRet;
  if (!soRet) return { found: false, open: false, detail: "no SalesOrderRet (not found)" };
  const truthy = (v: unknown) => v === true || v === "true" || v === 1 || v === "1";
  const fully = truthy(soRet.IsFullyInvoiced);
  const closed = truthy(soRet.IsManuallyClosed);
  return {
    found: true,
    open: !fully && !closed,
    detail: `IsFullyInvoiced=${fully} IsManuallyClosed=${closed}`,
  };
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log("=== Close orphan-open Sales Orders (controlled close) ===");
  console.log(`MODE: ${APPLY ? "APPLY (will close SOs in QB)" : "DRY-RUN (no writes)"}`);
  if (ONLY.length) console.log(`ONLY: ${ONLY.join(", ")}`);
  console.log(`Bridge: ${requireBridgeUrl()}\n`);

  const { rows } = await db.query<Row>(
    `WITH inv AS (
       SELECT order_id,
              ROUND(COALESCE(SUM(total) FILTER (WHERE voided_at IS NULL), 0) / 100.0, 2) AS invoiced
         FROM pos_invoice
        GROUP BY order_id
     )
     SELECT o.display_id,
            o.metadata->'qb_sales_order'->>'txn_id'     AS so_txn_id,
            o.metadata->'qb_sales_order'->>'ref_number' AS so_ref,
            o.metadata->>'document_number'              AS doc_number,
            ROUND((os.totals->>'current_order_total')::numeric, 2)::text AS order_total,
            COALESCE(inv.invoiced, 0)::text             AS invoiced
       FROM "order" o
       JOIN order_summary os ON os.order_id = o.id AND os.version = o.version
       LEFT JOIN inv ON inv.order_id = o.id
      WHERE o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL
        AND jsonb_array_length(COALESCE(o.metadata->'qb_invoices','[]'::jsonb)) > 0
      ORDER BY o.display_id`
  );
  await db.end();

  const targets = ONLY.length
    ? rows.filter((r) => r.so_ref && ONLY.includes(r.so_ref))
    : rows;

  let closed = 0;
  let skipped = 0;
  let errors = 0;

  for (const r of targets) {
    const label = `${r.doc_number ?? r.display_id} / SO ${r.so_ref ?? "?"} (${r.so_txn_id})`;
    try {
      // Coverage guard: ONLY close SOs whose order is FULLY invoiced. A
      // partially-invoiced order must keep its SO open so the remaining
      // balance can still be invoiced against it. invoiced >= total - 1¢.
      const total = Number(r.order_total ?? 0);
      const invoiced = Number(r.invoiced ?? 0);
      const fullyInvoiced = total > 0 && invoiced >= total - 0.01;
      if (!fullyInvoiced) {
        console.log(
          `SKIP  ${label} — only PARTIALLY invoiced ($${invoiced.toFixed(2)} / $${total.toFixed(2)}) → SO must stay open`
        );
        skipped++;
        continue;
      }

      const st = await soStatus(r.so_txn_id);
      if (!st.found) {
        console.log(`SKIP  ${label} — not found in QB`);
        skipped++;
        continue;
      }
      if (!st.open) {
        console.log(`SKIP  ${label} — already closed (${st.detail})`);
        skipped++;
        continue;
      }
      console.log(
        `  → ${label} fully invoiced ($${invoiced.toFixed(2)}/$${total.toFixed(2)}), SO open (${st.detail})`
      );
      if (!APPLY) {
        console.log(`WOULD CLOSE  ${label} — ${st.detail}`);
        continue;
      }
      const res = await closeSalesOrderInQb(r.so_txn_id, () => {});
      if (res.success) {
        console.log(`CLOSED  ${label}`);
        closed++;
      } else {
        console.log(`ERROR  ${label} — ${res.error}`);
        errors++;
      }
    } catch (e: any) {
      console.log(`ERROR  ${label} — ${e.message}`);
      errors++;
    }
  }

  console.log(
    `\n=== Done. ${APPLY ? `closed=${closed} ` : ""}skipped=${skipped} errors=${errors} of ${targets.length} target(s). ===`
  );
  if (!APPLY) console.log("(DRY-RUN — pass APPLY=true to close.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
