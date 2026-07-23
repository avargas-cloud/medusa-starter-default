/**
 * Verifies the QB error 3290 line-order self-heal against LIVE QuickBooks data.
 *
 * 1. classifier — does isLineOrderError() recognise the exact error string that
 *    wedged CM-1087 for two weeks?
 * 2. extractor  — does extractLineOrder() pull the document's REAL line order
 *    out of a live CreditMemoQuery response (not a hand-written fixture)?
 * 3. contrast   — is that real order actually different from ascending-by-
 *    TxnLineID? If it were not, the whole heal would be pointless.
 *
 * Read-only: the only QB traffic is a CreditMemoQuery.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-qb-line-order-heal.ts [TxnID]
 */

import {
  isLineOrderError,
  extractLineOrder,
} from "../../lib/quickbooks/consolidator/heal-line-order";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

// CM-1087 — the document the bug was found on.
const TXN_ID = process.argv[2] || "1C9684-1783534817";

const CM_SPEC = {
  endpoint: "/api/credit-memos",
  rsKey: "CreditMemoQueryRs",
  retKey: "CreditMemoRet",
  lineKeys: ["CreditMemoLineRet", "CreditMemoLineGroupRet"],
};

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function bridge(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
      "bypass-tunnel-reminder": "true",
      ...(init?.headers ?? {}),
    },
  });
  return res.json();
}

async function main(): Promise<void> {
  console.log("\n1. Error classifier");
  const realError =
    'QuickBooks Error 3290: The item "1CAF77-1783534817" is placed in the request in incorrect order.';
  check("recognises the live CM-1087 error", isLineOrderError(realError));
  check("recognises a bare 3290 code", isLineOrderError("QB 3290"));
  check(
    "does NOT claim a stale-EditSequence error",
    !isLineOrderError("QuickBooks Error 3200: The provided edit sequence is out-of-date")
  );
  check("empty message is not a line-order error", !isLineOrderError(""));

  console.log(`\n2. Live CreditMemoQuery for ${TXN_ID}`);
  // Sent as a direct query so this script verifies the extractor even before
  // the bridge (which now sets IncludeLineItems on its own CM query) is deployed.
  const qbxml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="10.0"?>',
    '<QBXML><QBXMLMsgsRq onError="stopOnError">',
    `<CreditMemoQueryRq><TxnID>${TXN_ID}</TxnID><IncludeLineItems>true</IncludeLineItems></CreditMemoQueryRq>`,
    "</QBXMLMsgsRq></QBXML>",
  ].join("\n");

  const queued = await bridge("/api/sync/direct-query", {
    method: "POST",
    body: JSON.stringify({ qbxml }),
  });
  if (!queued?.operationId) {
    console.log(`  ❌ bridge did not queue the query: ${JSON.stringify(queued)}`);
    process.exit(1);
  }

  let op: any = null;
  for (let attempt = 1; attempt <= 12; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const status = await bridge(`/api/sync/status/${queued.operationId}`);
    op = status?.operation;
    if (op?.status === "completed" || op?.status === "failed") break;
    console.log(`     ⏳ poll ${attempt}: ${op?.status ?? "unknown"}`);
  }
  if (op?.status !== "completed") {
    console.log(`  ❌ query did not complete: ${op?.status} ${op?.error ?? ""}`);
    process.exit(1);
  }

  const order = extractLineOrder(op.result, CM_SPEC);
  check("extractor returned lines", order.length > 0, `${order.length} lines`);
  order.forEach((id, i) => console.log(`     ${String(i + 1).padStart(2)}. ${id}`));

  console.log("\n3. Real order vs the ascending-TxnLineID assumption");
  const ascending = [...order].sort((a, b) => {
    const ha = parseInt(a.split("-")[0], 16);
    const hb = parseInt(b.split("-")[0], 16);
    return ha - hb;
  });
  const differs = JSON.stringify(order) !== JSON.stringify(ascending);
  check(
    "QB's real order differs from ascending-by-id (this is why 3290 was unfixable by sorting)",
    differs,
    differs ? `ascending would start with ${ascending[0]}, QB has ${order[0]}` : "orders match"
  );

  console.log(
    failures === 0
      ? "\n✅ line-order heal verified against live QB\n"
      : `\n❌ ${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
