/**
 * Verifies the Subtotal/Discount TxnLineID reuse on CreditMemoMod (QB 3290
 * post-mortem, case #5).
 *
 * Those two lines have no pos_credit_memo_item row, so every Mod used to send
 * them without a TxnLineID and QB deleted + recreated them (CM-1087:
 * 1CAF78/1CAF79 → 1CB0D0/1CB0D1 in a single mod). They now live in
 * pos_credit_memo.metadata.qb_synthetic_line_ids, written by the pipeline
 * poller from the real CreditMemoRet.
 *
 * The assertions that matter are the ones about when reuse is REFUSED: a QB
 * Subtotal totals the lines above it, and QB appends new lines at the end, so
 * reusing the pair on a mod that also adds a product line would silently stop
 * the Subtotal from covering that product.
 *
 * Optionally checks live prod data when given a credit memo id / number.
 *
 * Run:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-qb-cm-synthetic-lines.ts
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-qb-cm-synthetic-lines.ts CM-1087
 */

import { Client } from "pg";

import {
  CM_SYNTHETIC_LINE_IDS_META_KEY,
  applyQbSyntheticLineIds,
  extractQbSyntheticLineIds,
  readQbSyntheticLineIds,
} from "../../lib/quickbooks/credit-memo-synthetic-lines";
import { buildQbOrderDiscountLines } from "../../lib/quickbooks/order-flow-core";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The real pair CM-1087 ended up with after the 3290 heal landed. */
const SUBTOTAL_ID = "1CB0D0-1783534817";
const DISCOUNT_ID = "1CB0D1-1783534817";
const STORED = { subtotal: SUBTOTAL_ID, discount: DISCOUNT_ID };

function pair(): ReturnType<typeof buildQbOrderDiscountLines> {
  return buildQbOrderDiscountLines(124.24);
}

function main(): void {
  console.log("\n1. buildQbOrderDiscountLines still emits the pair we key off");
  const lines = pair();
  check("two lines", lines.length === 2, `got ${lines.length}`);
  check("first is Subtotal", lines[0]?.productName === "Subtotal");
  check("second is Discount", lines[1]?.productName === "Discount");
  check(
    "neither carries a TxnLineID by itself",
    lines[0]?.TxnLineID === undefined && lines[1]?.TxnLineID === undefined
  );

  console.log("\n2. extractor — reads the pair out of a CreditMemoRet");
  // Shape mirrors CM-1087's response: products by ListID, synthetic pair by name.
  const lineRet = [
    { TxnLineID: "1C9686-1783534817", ItemRef: { ListID: "8000A1-1", FullName: "EMSH4V160D15W60" } },
    { TxnLineID: "1C9687-1783534817", ItemRef: { ListID: "8000A2-1", FullName: "ECTSK-TWRC1C5A" } },
    { TxnLineID: SUBTOTAL_ID, ItemRef: { ListID: "8000B1-1", FullName: "Subtotal" } },
    { TxnLineID: DISCOUNT_ID, ItemRef: { ListID: "8000B2-1", FullName: "Discount" } },
  ];
  const extracted = extractQbSyntheticLineIds(lineRet);
  check("subtotal id", extracted.subtotal === SUBTOTAL_ID, String(extracted.subtotal));
  check("discount id", extracted.discount === DISCOUNT_ID, String(extracted.discount));

  const noDiscount = extractQbSyntheticLineIds([lineRet[0], lineRet[1]]);
  check(
    "pair QB no longer has → nulls (so the map cannot outlive the document)",
    noDiscount.subtotal === null && noDiscount.discount === null
  );
  check(
    "single-line (non-array) response is handled",
    extractQbSyntheticLineIds(lineRet[2]).subtotal === SUBTOTAL_ID
  );
  check("no line array → nulls", extractQbSyntheticLineIds(null).subtotal === null);
  check(
    "a product SKU literally named Discount cannot steal the id",
    extractQbSyntheticLineIds([
      { TxnLineID: "1C9600-1783534817", ItemRef: { ListID: "8000C1-1", FullName: "Discount" } },
      ...lineRet,
    ]).discount === DISCOUNT_ID
  );

  console.log("\n3. metadata reader");
  check(
    "round-trips what the poller writes",
    readQbSyntheticLineIds({ [CM_SYNTHETIC_LINE_IDS_META_KEY]: STORED }).subtotal ===
      SUBTOTAL_ID
  );
  check(
    "sentinels are not usable ids",
    readQbSyntheticLineIds({
      [CM_SYNTHETIC_LINE_IDS_META_KEY]: { subtotal: "-1", discount: "" },
    }).subtotal === null
  );
  check("missing metadata → nulls", readQbSyntheticLineIds(null).discount === null);
  check(
    "garbage metadata shape → nulls (degrades to today's behaviour)",
    readQbSyntheticLineIds({ [CM_SYNTHETIC_LINE_IDS_META_KEY]: "nope" }).subtotal ===
      null
  );

  console.log("\n4. reuse gate — the part that protects document meaning");
  const reused = applyQbSyntheticLineIds(pair(), STORED, {
    isMod: true,
    hasNewProductLines: false,
  });
  check(
    "mod, all product lines already in QB → pair is UPDATED, not recreated",
    reused[0]?.TxnLineID === SUBTOTAL_ID && reused[1]?.TxnLineID === DISCOUNT_ID
  );

  const withNewLine = applyQbSyntheticLineIds(pair(), STORED, {
    isMod: true,
    hasNewProductLines: true,
  });
  check(
    "mod that ADDS a product line → no reuse (Subtotal must stay after it)",
    withNewLine[0]?.TxnLineID === undefined &&
      withNewLine[1]?.TxnLineID === undefined
  );

  const asAdd = applyQbSyntheticLineIds(pair(), STORED, {
    isMod: false,
    hasNewProductLines: false,
  });
  check(
    "CreditMemoAdd → never stamps a TxnLineID",
    asAdd[0]?.TxnLineID === undefined && asAdd[1]?.TxnLineID === undefined
  );

  const halfPair = applyQbSyntheticLineIds(
    pair(),
    { subtotal: SUBTOTAL_ID, discount: null },
    { isMod: true, hasNewProductLines: false }
  );
  check(
    "half a stored pair → no reuse (they are born and die together)",
    halfPair[0]?.TxnLineID === undefined
  );

  check(
    "no discount on the CM → nothing to stamp",
    applyQbSyntheticLineIds([], STORED, {
      isMod: true,
      hasNewProductLines: false,
    }).length === 0
  );

  const input = pair();
  applyQbSyntheticLineIds(input, STORED, {
    isMod: true,
    hasNewProductLines: false,
  });
  check(
    "input lines are not mutated",
    input[0]?.TxnLineID === undefined && input[1]?.TxnLineID === undefined
  );
}

async function inspectLive(ref: string): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("\n5. live check — skipped (no DATABASE_URL)");
    return;
  }
  console.log(`\n5. live check — ${ref}`);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, credit_memo_number, qb_txn_id, discount,
              metadata -> $2 AS synthetic
         FROM pos_credit_memo
        WHERE id = $1 OR credit_memo_number = $1
        LIMIT 1`,
      [ref, CM_SYNTHETIC_LINE_IDS_META_KEY]
    );
    if (rows.length === 0) {
      check("credit memo found", false, ref);
      return;
    }
    const cm = rows[0];
    console.log(
      `     ${cm.credit_memo_number} (${cm.id}) qb_txn_id=${cm.qb_txn_id ?? "none"} discount=${cm.discount}`
    );
    console.log(`     ${CM_SYNTHETIC_LINE_IDS_META_KEY} = ${JSON.stringify(cm.synthetic)}`);
    const stored = readQbSyntheticLineIds({
      [CM_SYNTHETIC_LINE_IDS_META_KEY]: cm.synthetic,
    });
    if (Number(cm.discount) > 0 && cm.qb_txn_id) {
      check(
        "synced CM with a discount has both ids persisted",
        !!stored.subtotal && !!stored.discount,
        "if empty, the CM has not been re-synced since this shipped"
      );
    } else {
      console.log("     (no discount or not synced — nothing to persist)");
    }
  } finally {
    await client.end();
  }
}

async function run(): Promise<void> {
  main();
  const ref = process.argv[2];
  if (ref) await inspectLive(ref);
  console.log(
    failures === 0
      ? "\n✅ All checks passed\n"
      : `\n❌ ${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
