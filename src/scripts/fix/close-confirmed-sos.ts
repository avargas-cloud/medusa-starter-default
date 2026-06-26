/**
 * close-confirmed-sos.ts — ONE-OFF.
 *
 * Closes the EXACT, pre-confirmed list of orphan-open Sales Orders in QB
 * (full-invoiced orders whose SO stayed open due to the LinkToTxnID bug —
 * see docs/SO_INVOICE_LINK_FIX_PLAN.md). The list below was confirmed by the
 * audit (audit-open-so-invoiced) AND the controlled-close DRY-RUN: all 15 are
 * 100%-invoiced and verified open (IsFullyInvoiced=false, IsManuallyClosed=false).
 * The $0 order S10578/6350 is intentionally EXCLUDED.
 *
 * Calls closeSalesOrderInQb() directly (marks IsManuallyClosed). Idempotent
 * enough: if QB already closed one, that op just no-ops/errors harmlessly.
 *
 * Usage (REAL close — writes to QB):
 *   CONFIRM=yes node ./node_modules/.bin/ts-node -r tsconfig-paths/register src/scripts/fix/close-confirmed-sos.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { closeSalesOrderInQb } from "../../lib/quickbooks/client/sales-orders";

const CONFIRM = process.env.CONFIRM === "yes";

// ref → { txnId, doc } — confirmed by audit + dry-run (2026-06-26).
const TARGETS: Array<{ ref: string; txnId: string; doc: string }> = [
  { ref: "6338", txnId: "1C4F70-1779481010", doc: "S10366" },
  { ref: "6334", txnId: "1C493C-1779222743", doc: "S10440" },
  { ref: "6344", txnId: "1C5BF1-1780006711", doc: "S10532" },
  { ref: "6351", txnId: "1C64ED-1780414257", doc: "S10582" },
  { ref: "6360", txnId: "1C6E12-1780945212", doc: "S10671" },
  { ref: "6364", txnId: "1C7180-1781191140", doc: "S10717" },
  { ref: "6367", txnId: "1C71F6-1781195417", doc: "S10718" },
  { ref: "6366", txnId: "1C71C0-1781194072", doc: "S10723" },
  { ref: "6371", txnId: "1C734C-1781278253", doc: "S10735" },
  { ref: "6369", txnId: "1C7328-1781278249", doc: "S10736" },
  { ref: "6375", txnId: "1C7589-1781375421", doc: "S10757" },
  { ref: "6376", txnId: "1C7699-1781537411", doc: "S10767" },
  { ref: "6382", txnId: "1C7A9C-1781703025", doc: "S10791" },
  { ref: "6387", txnId: "1C8120-1782145849", doc: "S10854" },
  { ref: "6389", txnId: "1C82A0-1782230434", doc: "S10871" },
];

async function main(): Promise<void> {
  console.log(`=== Close ${TARGETS.length} confirmed orphan-open Sales Orders ===`);
  console.log(`MODE: ${CONFIRM ? "LIVE (writing to QB)" : "PREVIEW (set CONFIRM=yes to close)"}`);
  console.log(`Bridge: ${process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"}\n`);

  let closed = 0;
  let errors = 0;

  for (const t of TARGETS) {
    const label = `${t.doc} / SO ${t.ref} (${t.txnId})`;
    if (!CONFIRM) {
      console.log(`PREVIEW  would close ${label}`);
      continue;
    }
    try {
      const res = await closeSalesOrderInQb(t.txnId, () => {});
      if (res.success) {
        console.log(`CLOSED   ${label}  (op: ${res.data?.operationId})`);
        closed++;
      } else {
        console.log(`ERROR    ${label} — ${res.error}`);
        errors++;
      }
    } catch (e: any) {
      console.log(`ERROR    ${label} — ${e.message}`);
      errors++;
    }
  }

  console.log(
    `\n=== Done. ${CONFIRM ? `closed=${closed} errors=${errors}` : "PREVIEW only"} of ${TARGETS.length} target(s). ===`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
