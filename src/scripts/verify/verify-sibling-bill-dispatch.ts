/**
 * verify-sibling-bill-dispatch.ts — READ-ONLY.
 *
 * THE INVARIANT
 * -------------
 *   No secondary bill (service / freight / tariff / expense) may have its pair
 *   COMPLETE — itself confirmed, and its regular bill confirmed too, or no
 *   purchase order at all — while having neither a QuickBooks TxnID nor a live
 *   pipeline row.
 *
 * That state means QuickBooks was never told about a finished document, and
 * worse, the regular bill's NEGATIVE clearing line has already subtracted it
 * from A/P. Measured 2026-08-31 before the fix: 8 bills, $8,731.35.
 *
 * WHY THIS CHECK AND NOT "count the confirmed bills with no TxnID"
 * ---------------------------------------------------------------
 * Because that number is 18, and 10 of them are FINE — their regular bill is
 * still a draft, so they are correctly waiting. A check that cannot tell
 * "waiting" from "lost" is the exact blindness that let this run for a month:
 * the screen said `confirmed` in both cases and so would a naive verifier.
 * The distinction comes from `decideSecondaryDispatch`, and this script calls
 * THAT function rather than restating the rule — a verifier holding its own
 * copy of the rule can only drift away from the code it is verifying.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-sibling-bill-dispatch.ts
 */

import fs from "node:fs";
import path from "node:path";
import Knex from "knex";
import { scanLostSiblingBills } from "../../lib/purchase-orders/vendor-bill-invariant-scans";

const SRC = path.resolve(__dirname, "../..");

let failures = 0;
let checks = 0;

function check(ok: boolean, label: string, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Reads a file with its `import` lines stripped.
 *
 * A "does this file call X" check that scans the whole text is satisfied by the
 * IMPORT alone — the defect this repo already documented for §4a and then
 * reintroduced in §4b of the PIN verifier. Dropping the import block is what
 * makes the assertion mean what it says.
 */
function bodyWithoutImports(rel: string): string {
  const text = fs.readFileSync(path.join(SRC, rel), "utf8");
  return text
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+"/.test(l))
    .join("\n");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  console.log("\n§1 — the wiring exists (static)\n");

  const regularConfirm = bodyWithoutImports(
    "api/admin/purchase-orders/[id]/receipts/[receiptId]/vendor-bill/confirm/route.ts"
  );
  check(
    /dispatchConfirmedSiblings\s*\(/.test(regularConfirm),
    "the REGULAR confirm dispatches its siblings"
  );
  check(
    /fatalSiblingOutcomes\s*\(/.test(regularConfirm) && /throw new Error/.test(regularConfirm),
    "a sibling it meant to send and could not takes the confirm down",
    "fail-loud, not a 200 with a reason nobody reads"
  );
  // Order is not cosmetic: the chain is serial per purchase order, so enqueue
  // order is the order QuickBooks receives them. Siblings AFTER the regular
  // would leave A/P short for the length of that window.
  // Positions of the CALLS, not of any mention. Searching for the bare name
  // matched the prose in a comment, so this check stayed green with the call
  // deleted — a vacuous assert, caught by mutation-testing it rather than by
  // reading it.
  const idxSiblings = regularConfirm.search(/dispatchConfirmedSiblings\s*\(/);
  const idxOwnAdd = regularConfirm.search(/enqueueQbVendorBillAdd\s*\(\s*trx\s*,/);
  check(
    idxSiblings > -1 && idxOwnAdd > -1 && idxSiblings < idxOwnAdd,
    "siblings are enqueued BEFORE the regular's own BillAdd",
    `sibling@${idxSiblings} < regular@${idxOwnAdd}`
  );

  const standaloneConfirm = bodyWithoutImports(
    "api/admin/vendor-bills/[id]/confirm/route.ts"
  );
  check(
    /decideSecondaryDispatch\s*\(/.test(standaloneConfirm),
    "the STANDALONE confirm asks the shared rule instead of always sending"
  );
  check(
    /knex\.transaction\s*\(/.test(standaloneConfirm) && /trx\.rollback/.test(standaloneConfirm),
    "the standalone confirm and its QB intent are ONE transaction"
  );
  check(
    /enqueueVendorBillModSingle\s*\(/.test(standaloneConfirm),
    "a bill already in QuickBooks still sends its Mod immediately",
    "deferring a correction is the VB-1061 failure"
  );

  const detailRoute = bodyWithoutImports("api/admin/vendor-bills/[id]/route.ts");
  check(
    /decideSecondaryDispatch\s*\(/.test(detailRoute),
    "the screen derives its banner from the SAME rule as the dispatcher"
  );

  // THE OTHER HALF OF THE SAME TRANSACTION (2026-09-03).
  //
  // `dispatchConfirmedSiblings` runs first and queues a BillAdd for each
  // sibling that is not in QuickBooks. One statement later the group Mod runs,
  // and those siblings STILL have no TxnID — the Add is only queued. A Mod
  // built for them throws, rolling back the very transaction that queued the
  // Adds, so the regular's confirm can never succeed. That is what returned
  // 422 `VB-1129: missing QB TxnID/EditSequence` on VB-1128 for days.
  //
  // Asserted on the FILTER, not on the absence of a throw: the throw in
  // buildPayload is correct and must stay for the regular.
  const modEnqueue = bodyWithoutImports(
    "lib/purchase-orders/qb-vendor-bill-mod-enqueue.ts"
  );
  check(
    /const\s+modBills\s*=\s*bills\.filter\s*\(/.test(modEnqueue) &&
      /bill\.id\s*===\s*regular\.id\s*\|\|\s*Boolean\(bill\.qb_txn_id\)/.test(
        modEnqueue
      ),
    "the group Mod skips members that do not live in QuickBooks yet",
    "a BillMod names a document by TxnID — one that is not there is not modifiable"
  );
  check(
    /for\s*\(\s*const\s+bill\s+of\s+modBills\s*\)/.test(modEnqueue),
    "…and it is the FILTERED list the group actually enqueues",
    "computing modBills and then looping `bills` would be a filter that does nothing"
  );

  // THE ADD AND THE MOD MUST AGREE ON WHO NEEDS A PURCHASE ORDER (2026-09-03).
  //
  // `bdfbecaf` (2026-08-31) replaced "only an expense bill may lack a PO" with
  // the structural rule "only a REGULAR bill requires one" — and wrote it in
  // the Add alone. The Mod kept the old carve-out, so a sales-commission or
  // outsourced-services bill went INTO QuickBooks through the generalised Add
  // and then could never be corrected: every edit 500'd with "bill has no
  // purchase order". VB-1146/1147/1148/1149 sat uneditable for three days.
  //
  // Asserted as a PAIR because that is the actual failure mode. A check on the
  // Mod alone would have gone green the moment someone fixed the Mod and
  // regressed the Add — the two guards are one rule living in two files, and
  // this is the only place that says so.
  const codeOnly = (s: string) =>
    s
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  const addCode = codeOnly(
    bodyWithoutImports("lib/purchase-orders/qb-vendor-bill-enqueue.ts")
  );
  const modCode = codeOnly(modEnqueue);
  const PO_RULE = /!\w+\.purchase_order_id\s*&&\s*\w+\.bill_type\s*===\s*"regular"/;
  check(
    PO_RULE.test(addCode),
    "the ADD refuses a missing PO only for a REGULAR bill"
  );
  check(
    PO_RULE.test(modCode),
    "the MOD applies the SAME rule — no PO is a document shape, not damage",
    "this is the guard that made VB-1146 uneditable"
  );
  const CARVE_OUT = /bill_type\s*!==\s*"expense"/;
  check(
    !CARVE_OUT.test(addCode) && !CARVE_OUT.test(modCode),
    "neither path still carves out `expense` by name",
    "the carve-out is what the structural rule replaced"
  );
  // The other half of "no PO is a shape": without a purchase order there is no
  // chain to serialize against, so the operation keys off the bill's OWN id.
  // Drop this fallback and the enqueue writes a NULL key.
  const OWN_ID_CHAIN = /purchase_order_id\s*\?\?\s*\w+\.id/;
  check(
    OWN_ID_CHAIN.test(addCode) && OWN_ID_CHAIN.test(modCode),
    "both key a PO-less bill's dependency chain by its own id",
    "Add → Mod on the same document has to stay serial"
  );

  console.log("\n§2 — the invariant, against live data\n");

  const knex = Knex({ client: "pg", connection: url, pool: { min: 0, max: 3 } });
  try {
    // EL BARRIDO NO VIVE ACÁ (2026-09-03). Vive en
    // `lib/purchase-orders/vendor-bill-invariant-scans.ts` y lo comparte con la
    // sección 12 del digest diario, que es la que le llega a una persona por
    // mail. Cuando en este repo la misma comparación existió en dos copias, ya
    // habían divergido en tres campos: el barrido y el reporte dejaron de
    // coincidir en qué era deriva. Este script quedó como IMPRESOR.
    const scan = await scanLostSiblingBills(knex as never);
    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    const label = (b: { number: string | null; vendor_bill_id: string; bill_type: string; total_cents: number; reason: string }) =>
      `${b.number ?? b.vendor_bill_id} (${b.bill_type}, ${money(b.total_cents)}) — ${b.reason}`;
    const lost = scan.lost.map(label);
    const waiting = scan.waiting.map(label);
    const lostCents = scan.lost_cents;

    check(
      lost.length === 0,
      "no secondary bill has a COMPLETE pair and no QuickBooks document",
      lost.length === 0
        ? "none"
        : `${lost.length} bills, $${(lostCents / 100).toFixed(2)}`
    );
    for (const l of lost) console.log(`         LOST    ${l}`);

    // Reported, never failed: this is the healthy state the whole design
    // creates. Printing it is what makes the check readable — a silent verifier
    // that only ever says "ok" teaches nobody what it is watching.
    console.log(
      `\n         ${waiting.length} secondary bill(s) correctly WAITING on their regular bill:`
    );
    for (const w of waiting) console.log(`         waiting ${w}`);
  } finally {
    await knex.destroy();
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-sibling-bill-dispatch crashed:", err);
  process.exit(2);
});
