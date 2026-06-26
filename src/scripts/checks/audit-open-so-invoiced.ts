/**
 * audit-open-so-invoiced.ts
 *
 * READ-ONLY audit for the "Full SO→Invoice drops LinkToTxnID → SO stays Open"
 * bug (see docs/SO_INVOICE_LINK_FIX_PLAN.md). Finds every order that went
 * through the estimate/SO→invoice conversion flow (has both
 * metadata.qb_sales_order.txn_id and metadata.qb_invoices[]) and asks the QB
 * bridge whether its Sales Order is still OPEN in QuickBooks.
 *
 * Classifies each SO:
 *   OPEN_INVOICED  → SO not fully-invoiced / not manually-closed, but the order
 *                    HAS invoice(s) → orphan candidate for a controlled close.
 *   CLOSED         → IsFullyInvoiced=true OR IsManuallyClosed=true → already fine.
 *   NOT_FOUND      → bridge could not find the SO (voided/deleted in QB).
 *   ERROR          → bridge/query error (transient — re-run).
 *
 * Writes NOTHING. Only queries QB (read). Safe against prod, but it shares the
 * single QBWC pipe with live sync — prefer running off-hours.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/checks/audit-open-so-invoiced.ts
 *   # JSON output (for the repair script to consume):
 *   JSON=true npx ts-node -r tsconfig-paths/register src/scripts/checks/audit-open-so-invoiced.ts > /tmp/so-audit.json
 */

import * as dotenv from "dotenv";
import * as fs from "fs";
import { Client } from "pg";

dotenv.config();

const JSON_OUT = process.env.JSON === "true";
// Synchronous live-progress file — survives stdout buffering through
// npx/npm-exec pipe chains (Node buffers stdout when it's a pipe, so
// `> log` shows nothing until the process exits). Tail this to watch live.
const PROGRESS_FILE = process.env.PROGRESS_FILE || "";
function progress(line: string): void {
  if (!PROGRESS_FILE) return;
  try {
    fs.appendFileSync(PROGRESS_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}

// Pull the bridge client lazily so dotenv runs first (BRIDGE_URL/API_KEY read at
// module load in client/core.ts).
import {
  bridgeFetch,
  pollRawOperationResult,
} from "../../lib/quickbooks/client/core";

type Row = {
  display_id: number;
  order_id: string;
  so_txn_id: string;
  so_ref: string | null;
  doc_number: string | null;
  n_inv: number;
};

type Verdict =
  | "OPEN_INVOICED"
  | "CLOSED"
  | "NOT_FOUND"
  | "ERROR";

type Result = Row & {
  verdict: Verdict;
  isFullyInvoiced: boolean | null;
  isManuallyClosed: boolean | null;
  detail: string;
};

function log(msg: string): void {
  if (!JSON_OUT) console.log(msg);
}

async function querySoStatus(soTxnId: string): Promise<{
  found: boolean;
  isFullyInvoiced: boolean | null;
  isManuallyClosed: boolean | null;
  error?: string;
}> {
  try {
    const queryResp = await bridgeFetch("GET", `/api/sales-orders/${soTxnId}`);
    const opId = queryResp?.operationId;
    if (!opId) return { found: false, isFullyInvoiced: null, isManuallyClosed: null, error: "no operationId" };

    const raw = await pollRawOperationResult(opId);
    const soRet =
      raw?.QBXML?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
      raw?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet ??
      raw?.SalesOrderRet ??
      raw?.SalesOrderQueryRs?.SalesOrderRet;

    if (!soRet) {
      // statusCode 500 / "not found" comes back as an empty Rs.
      return { found: false, isFullyInvoiced: null, isManuallyClosed: null, error: "no SalesOrderRet" };
    }

    const truthy = (v: unknown) =>
      v === true || v === "true" || v === 1 || v === "1";
    return {
      found: true,
      isFullyInvoiced: truthy(soRet.IsFullyInvoiced),
      isManuallyClosed: truthy(soRet.IsManuallyClosed),
    };
  } catch (err: any) {
    return { found: false, isFullyInvoiced: null, isManuallyClosed: null, error: err.message };
  }
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  log("=== Audit: orphan-open Sales Orders for fully-invoiced orders ===");
  log(`Bridge: ${process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"}\n`);

  const { rows } = await db.query<Row>(
    `SELECT display_id,
            id                                              AS order_id,
            metadata->'qb_sales_order'->>'txn_id'           AS so_txn_id,
            metadata->'qb_sales_order'->>'ref_number'       AS so_ref,
            metadata->>'document_number'                    AS doc_number,
            jsonb_array_length(COALESCE(metadata->'qb_invoices','[]'::jsonb)) AS n_inv
       FROM "order"
      WHERE metadata->'qb_sales_order'->>'txn_id' IS NOT NULL
        AND jsonb_array_length(COALESCE(metadata->'qb_invoices','[]'::jsonb)) > 0
      ORDER BY display_id`
  );

  log(`Found ${rows.length} SO→invoice conversion order(s). Querying QB...\n`);
  progress(`START — ${rows.length} SO(s) to query`);

  const results: Result[] = [];
  let idx = 0;
  for (const r of rows) {
    idx++;
    progress(
      `[${idx}/${rows.length}] querying ${r.doc_number ?? r.display_id} SO ${r.so_ref ?? "?"} (${r.so_txn_id})...`
    );
    const s = await querySoStatus(r.so_txn_id);
    let verdict: Verdict;
    let detail: string;
    if (s.error) {
      verdict = s.error.includes("SalesOrderRet") || s.error.includes("not found")
        ? "NOT_FOUND"
        : "ERROR";
      detail = s.error;
    } else if (!s.found) {
      verdict = "NOT_FOUND";
      detail = "SO not found in QB (voided/deleted?)";
    } else if (s.isFullyInvoiced || s.isManuallyClosed) {
      verdict = "CLOSED";
      detail = `IsFullyInvoiced=${s.isFullyInvoiced} IsManuallyClosed=${s.isManuallyClosed}`;
    } else {
      verdict = "OPEN_INVOICED";
      detail = "SO open but order invoiced → orphan candidate";
    }

    const result: Result = {
      ...r,
      verdict,
      isFullyInvoiced: s.isFullyInvoiced,
      isManuallyClosed: s.isManuallyClosed,
      detail,
    };
    results.push(result);
    log(
      `${r.doc_number ?? r.display_id}\tSO ${r.so_ref ?? "?"} (${r.so_txn_id})\tinv×${r.n_inv}\t${verdict}\t${detail}`
    );
    progress(
      `[${idx}/${rows.length}] ${r.doc_number ?? r.display_id} → ${verdict} (${detail})`
    );
  }

  progress("DONE — all SOs queried");
  await db.end();

  const summary = {
    total: results.length,
    OPEN_INVOICED: results.filter((x) => x.verdict === "OPEN_INVOICED").length,
    CLOSED: results.filter((x) => x.verdict === "CLOSED").length,
    NOT_FOUND: results.filter((x) => x.verdict === "NOT_FOUND").length,
    ERROR: results.filter((x) => x.verdict === "ERROR").length,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    log("\n=== Summary ===");
    log(JSON.stringify(summary, null, 2));
    log(
      `\n→ ${summary.OPEN_INVOICED} SO(s) are orphan-open and can be closed by the repair script.`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
