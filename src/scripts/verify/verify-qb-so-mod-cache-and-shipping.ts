/**
 * verify-qb-so-mod-cache-and-shipping.ts
 *
 * Regression guard for the two defects that killed POS Invoice 21592 (order
 * 3231 / S11614) on 2026-08-26 and kept it dead for 33 h:
 *
 *   BUG 1 — qb_edit_sequence_cache was keyed by pipeline STEP, not by document.
 *     poll-submitted-rows wrote `cacheEditSequence(row.step, ...)`, so a
 *     confirmed `sales_order_mod` stored its fresh EditSequence + TxnLineID map
 *     under entity_type "sales_order_mod", while every reader
 *     (getSalesOrderDetailsFromQb) asks for "sales_order". The base row kept
 *     the PRE-mod line map forever and no reader ever saw the orphan.
 *     Consequence: the invoice ADD read a cache HIT (so it never re-queried
 *     QuickBooks), stamped LinkToTxnLineID of a line the mod had deleted, and
 *     got QB Error 3210 on every single retry. A stale cache made the failure
 *     structurally unable to self-heal.
 *
 *   BUG 2 — handle-order-updated built the SalesOrderMod payload from
 *     order.items alone. A MOD is a full snapshot, so the omitted freight line
 *     was DELETED from the Sales Order: SO 6492 silently dropped from $63.46
 *     to $38.46 while the POS still said $63.46.
 *
 * All four sections assert BEHAVIOR, not source text, except §2 which is
 * explicitly a callsite check (see its comment for why it is needed and what
 * it cannot prove).
 *
 * Read-only against real data: §1 uses a synthetic TxnID that cannot collide
 * with a QuickBooks id and deletes its own rows on the way out.
 *
 * Run: env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *        ./node_modules/.bin/tsx src/scripts/verify/verify-qb-so-mod-cache-and-shipping.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { getDbPool } from "../../api/utils/db-pool";
import {
  cacheEditSequence,
  getCachedEditSequence,
} from "../../lib/quickbooks/pipeline/edit-sequence";
import { stepToCacheEntityType } from "../../lib/quickbooks/consolidator/refresh-edit-sequence";
import { buildSalesOrderModQbItems } from "../../lib/quickbooks/build-sales-order-mod-items";

const SYNTH_TXN = `9C9999-${Date.now()}`;
const SHIPPING_ITEM_ID = "800006A3-1395258131";
const PRODUCT_LIST_ID = "80000A44-1447264371";

let failures = 0;
const log = (msg: string) => console.log(msg);
const ok = (msg: string) => log(`✅ ${msg}`);
const bad = (msg: string) => {
  failures++;
  log(`❌ ${msg}`);
};
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : bad(msg));

/** Minimal order line shaped the way buildQbItems reads it. */
function line(id: string, qty: number, unitPrice: number) {
  return {
    id,
    title: "LED Square Downlight",
    quantity: qty,
    unit_price: unitPrice,
    variant: { metadata: { quickbooks_id: PRODUCT_LIST_ID } },
  };
}

// ── §1 · The cache round-trip, through the SAME expression the callsite uses ──
async function section1(): Promise<void> {
  log("\n§1 — cache key resolves to the DOCUMENT, not the step");

  const preModMap = {
    [PRODUCT_LIST_ID]: ["1CE39D-1787754304"],
    [SHIPPING_ITEM_ID]: ["1CE39E-1787754304"],
  };
  // The mod deleted the freight line; its confirmation carries only one line.
  const postModMap = { [PRODUCT_LIST_ID]: ["1CE39D-1787754304"] };

  // The ADD confirms first, under step 'sales_order'.
  await cacheEditSequence(
    stepToCacheEntityType("sales_order", null),
    SYNTH_TXN,
    "1787754304",
    preModMap
  );

  // Then the MOD confirms, under step 'sales_order_mod'. This is the exact
  // expression poll-submitted-rows now evaluates.
  await cacheEditSequence(
    stepToCacheEntityType("sales_order_mod", null),
    SYNTH_TXN,
    "1787756650",
    postModMap
  );

  const read = await getCachedEditSequence("sales_order", SYNTH_TXN);

  check(
    read?.editSeq === "1787756650",
    `reader sees the POST-mod EditSequence (got ${read?.editSeq ?? "null"}, want 1787756650)`
  );
  check(
    !!read?.lineIds && !(SHIPPING_ITEM_ID in read.lineIds),
    "reader does NOT see the deleted freight TxnLineID — this is the 3210 that killed INV-21592"
  );
  check(
    !!read?.lineIds?.[PRODUCT_LIST_ID]?.includes("1CE39D-1787754304"),
    "reader still sees the surviving product line"
  );

  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT entity_type FROM qb_edit_sequence_cache WHERE qb_id = $1`,
    [SYNTH_TXN]
  );
  const types = rows.map((r: any) => r.entity_type).sort();
  check(
    types.length === 1 && types[0] === "sales_order",
    `exactly one cache row, entity_type 'sales_order' (got ${JSON.stringify(types)}) — an orphan '*_mod' row is a map nobody reads`
  );

  // Every mod-ish step of a Sales Order / Estimate must land on the base key.
  for (const [step, want] of [
    ["sales_order_mod", "sales_order"],
    ["so_close", "sales_order"],
    ["so_reopen", "sales_order"],
    ["estimate_mod", "estimate"],
    ["credit_memo_mod", "credit_memo"],
  ] as const) {
    const got = stepToCacheEntityType(step, null);
    check(got === want, `stepToCacheEntityType("${step}") = "${got}" (want "${want}")`);
  }
}

// ── §2 · The callsite actually evaluates it ──────────────────────────────────
//
// §1 proves the CONTRACT. It cannot prove that poll-submitted-rows calls it —
// the success path there only runs against a live bridge confirmation, which no
// verifier can stage. So this is a source check, and it is scoped to the one
// `cacheEditSequence(` call in that file rather than the whole file: a check
// that greps the file entire would be satisfied by the import line, which is
// the exact defect §4b of the PIN verifier had documented since July.
function section2(): void {
  log("\n§2 — the consolidator's success path passes the resolved entity type");

  const path = join(
    process.cwd(),
    "src/lib/quickbooks/consolidator/poll-submitted-rows.ts"
  );
  const src = readFileSync(path, "utf8");

  const callsites = [...src.matchAll(/await cacheEditSequence\(([\s\S]{0,200}?)\)/g)];
  check(
    callsites.length === 1,
    `exactly one cacheEditSequence call in poll-submitted-rows (found ${callsites.length}) — a new one needs its own assertion here`
  );

  const args = callsites[0]?.[1] ?? "";
  check(
    args.includes("stepToCacheEntityType("),
    "its first argument is stepToCacheEntityType(...), not row.step"
  );
  check(
    !/^\s*row\.step\s*,/.test(args),
    "row.step is NOT passed raw as the cache key"
  );
}

// ── §3 · The SO mod carries its freight line ─────────────────────────────────
function section3(): void {
  log("\n§3 — buildSalesOrderModQbItems emits the freight line");

  const items = [line("oli_1", 6, 5.99)];

  const withUber = buildSalesOrderModQbItems({
    items: items as any,
    shippingMethods: [{ name: "Uber", amount: 25 }],
    shippingItemId: SHIPPING_ITEM_ID,
  });
  const ship = withUber.find((i) => i.productId === SHIPPING_ITEM_ID);
  check(!!ship, "an Uber $25 shipping method produces a freight line");
  check(ship?.amount === 25, `freight amount is 25 (got ${ship?.amount})`);
  check(
    ship?.taxable === false,
    "freight line is non-taxable — the POS never puts shipping in the tax base"
  );
  check(ship?.noSite === true, "freight line sets noSite (QB 3140 otherwise)");
  check(
    withUber.filter((i) => i.productId === PRODUCT_LIST_ID).length === 1,
    "the product line survives alongside it"
  );

  // BigNumber shape — query.graph hands money back like this, and a bare
  // Number() on it yields NaN, which buildShippingQbItem reads as free shipping.
  const bigNumber = buildSalesOrderModQbItems({
    items: items as any,
    shippingMethods: [
      { name: "Uber", amount: { numeric_: 25, raw_: { value: "25" } } },
    ],
    shippingItemId: SHIPPING_ITEM_ID,
  });
  check(
    bigNumber.find((i) => i.productId === SHIPPING_ITEM_ID)?.amount === 25,
    "a BigNumber-shaped amount is coerced, not dropped as free shipping"
  );

  check(
    !buildSalesOrderModQbItems({
      items: items as any,
      shippingMethods: [{ name: "Pick-up", amount: 0 }],
      shippingItemId: SHIPPING_ITEM_ID,
    }).some((i) => i.productId === SHIPPING_ITEM_ID),
    "store pickup produces NO freight line"
  );
  check(
    !buildSalesOrderModQbItems({
      items: items as any,
      shippingMethods: [{ name: "Free Delivery", amount: 0 }],
      shippingItemId: SHIPPING_ITEM_ID,
    }).some((i) => i.productId === SHIPPING_ITEM_ID),
    "$0 shipping produces NO freight line"
  );
  check(
    !buildSalesOrderModQbItems({
      items: items as any,
      shippingMethods: [],
      shippingItemId: SHIPPING_ITEM_ID,
    }).some((i) => i.productId === SHIPPING_ITEM_ID),
    "no shipping method produces NO freight line"
  );
}

// ── §4 · Negative assertions — what must NOT appear ──────────────────────────
function section4(): void {
  log("\n§4 — negative assertions");

  const built = buildSalesOrderModQbItems({
    items: [line("oli_1", 6, 5.99)] as any,
    metadata: { computed_discount: 50 },
    shippingMethods: [{ name: "Uber", amount: 25 }],
    shippingItemId: SHIPPING_ITEM_ID,
  });

  // These carry no productId, so updateSalesOrderInQb cannot match them to an
  // existing TxnLineID — every mod would APPEND a fresh pair. Stripping them is
  // wrong but bounded; duplicating them corrupts the document.
  check(
    !built.some((i) => i.productName === "Subtotal"),
    "no synthetic 'Subtotal' line (it would duplicate on every mod)"
  );
  check(
    !built.some((i) => i.productName === "Discount"),
    "no synthetic 'Discount' line (it would duplicate on every mod)"
  );
  check(
    built.every((i) => i.productId || i.productName),
    "every emitted line is addressable (productId or productName)"
  );

  // The ListID must come from config, never be baked into the mod builder.
  const overridden = buildSalesOrderModQbItems({
    items: [] as any,
    shippingMethods: [{ name: "Uber", amount: 25 }],
    shippingItemId: "DEADBEEF-1111111111",
  });
  check(
    overridden.some((i) => i.productId === "DEADBEEF-1111111111"),
    "the shipping ListID comes from the passed config, not a hardcoded constant"
  );

  const src = readFileSync(
    join(process.cwd(), "src/lib/quickbooks/handlers/handle-order-updated.ts"),
    "utf8"
  );
  check(
    !src.includes(SHIPPING_ITEM_ID),
    "handle-order-updated does not hardcode the shipping ListID"
  );
}

async function cleanup(): Promise<void> {
  try {
    await getDbPool().query(
      `DELETE FROM qb_edit_sequence_cache WHERE qb_id = $1`,
      [SYNTH_TXN]
    );
  } catch (err) {
    log(`⚠️  cleanup failed for ${SYNTH_TXN}: ${err}`);
  }
}

async function main(): Promise<void> {
  log("verify-qb-so-mod-cache-and-shipping — INV-21592 / QB 3210 regression guard");
  try {
    await section1();
    section2();
    section3();
    section4();
  } finally {
    await cleanup();
  }

  log(
    failures === 0
      ? "\n✅ ALL CHECKS PASSED"
      : `\n❌ ${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
