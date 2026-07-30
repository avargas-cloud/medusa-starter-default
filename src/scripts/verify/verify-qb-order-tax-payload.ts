/**
 * Verifies that the tax flag actually REACHES the QuickBooks payload for both
 * the NEW (SalesOrderAdd) and MOD (SalesOrderMod) paths of an order.
 *
 * Why this gate exists
 * --------------------
 * The flag was being computed correctly and then dropped one layer later: the
 * `modItems` mapper in client/sales-orders.ts rebuilt each line by hand and
 * forwarded `noSite` and `qbItemType` but not `taxable`. Nothing failed loudly,
 * because the bridge answers a blank flag in one of two ways depending on the
 * caller:
 *
 *   • no `salesTaxCode` in the payload  → emits no <SalesTaxCodeRef> at all and
 *     QuickBooks keeps the tax status stored on its own item. Correct-looking,
 *     but it can only express "this product is never taxed" — never "this one
 *     line, on this one order, is exempt".
 *   • `salesTaxCode` present (the manual force-sync route) → the bridge takes
 *     its `Tax` branch for every line with a productId, REWRITING an exempt
 *     line as taxable in QuickBooks.
 *
 * So a type-check can't catch it, and neither can a QB read while the per-line
 * and product-level flags happen to agree — which they do on all 40 exempt
 * lines in production today. That agreement is luck, not a guarantee.
 *
 * Run: cd backend && yarn medusa exec ./src/scripts/verify/verify-qb-order-tax-payload.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import type { ExecArgs } from "@medusajs/framework/types";

import { buildQbItems } from "../../lib/quickbooks/order-flow-core";

type Case = {
  name: string;
  /** product.taxable — the catalog default, the only thing QB knows by itself */
  productTaxable: boolean;
  /** order_line_item.taxable — the snapshot the trigger seeds from the product */
  lineTaxable: boolean;
  /** Expected `taxable` field on the emitted QB line. undefined = field absent. */
  expected: boolean | undefined;
  why: string;
};

const CASES: Case[] = [
  {
    name: "both taxable",
    productTaxable: true,
    lineTaxable: true,
    expected: undefined,
    why: "no flag emitted — bridge/QB apply the normal taxable path",
  },
  {
    name: "product exempt (catalog service item)",
    productTaxable: false,
    lineTaxable: true,
    expected: false,
    why: "product-level exemption must still reach QB",
  },
  {
    name: "snapshot exempt, product now taxable  ← a pre-trigger line, or a catalog edit after the sale",
    productTaxable: true,
    lineTaxable: false,
    expected: false,
    why: "the document was written when the item was exempt; QB's current item default would say Tax",
  },
  {
    name: "both exempt",
    productTaxable: false,
    lineTaxable: false,
    expected: false,
    why: "agreement — the only shape production has today",
  },
];

const PRODUCT_ID = "prod_verify_tax";
const LINE_ID = "ordli_verify_tax";

function buildOneLine(productTaxable: boolean, lineTaxable: boolean) {
  const items = [
    {
      id: LINE_ID,
      title: "Expedite",
      quantity: 1,
      unit_price: 5100,
      product_id: PRODUCT_ID,
      variant: {
        product_id: PRODUCT_ID,
        sku: "VERIFY-TAX",
        metadata: { quickbooks_id: "80000000-1111111111" },
      },
      metadata: {},
    },
  ] as any;

  return buildQbItems(
    items,
    {},
    { [PRODUCT_ID]: { taxable: productTaxable, metadata: {} } },
    { [LINE_ID]: lineTaxable }
  );
}

export default async function verifyQbOrderTaxPayload({ logger }: ExecArgs) {
  const log = (m: string) => (logger ? logger.info(m) : console.log(m));
  let failures = 0;

  log("\n── 1. buildQbItems: does the flag survive into the payload? ──");
  for (const c of CASES) {
    const [line] = buildOneLine(c.productTaxable, c.lineTaxable);
    const got = line?.taxable;
    const ok = got === c.expected;
    if (!ok) failures++;
    log(
      `  ${ok ? "PASS" : "FAIL"}  ${c.name}\n` +
        `        product=${c.productTaxable} line=${c.lineTaxable} → taxable=${String(got)} (expected ${String(c.expected)})\n` +
        `        ${c.why}`
    );
  }

  // A line-level `true` must never be able to re-tax a product QB holds as
  // non-taxable. If it could, a *Mod would silently turn an existing `Non`
  // into `Tax` — the exact regression this whole change is meant to prevent.
  log("\n── 2. monotonicity: the per-line flag may only REMOVE tax ──");
  const [reTaxAttempt] = buildOneLine(false, true);
  const monotonic = reTaxAttempt?.taxable === false;
  if (!monotonic) failures++;
  log(
    `  ${monotonic ? "PASS" : "FAIL"}  product exempt + line taxable stays exempt ` +
      `(taxable=${String(reTaxAttempt?.taxable)})`
  );

  // Static gate. The functional cases above all run through buildQbItems, which
  // is only HALF the path: the SO *Mod* payload is assembled separately by
  // `modItems`, and that mapper is where the flag was being lost. It rebuilds
  // each line field by field, so a future edit can drop `taxable` again without
  // breaking a single test above.
  log("\n── 3. static: every *Mod* mapper forwards the flag ──");
  // Both Sales Orders and Estimates rebuild each line field by field before
  // sending it, and BOTH were dropping `taxable` on the floor. The bridge reads
  // `item.taxable === false` in all five of its builders, so any mapper that
  // omits the field hands QuickBooks a taxable line where an exempt one belongs.
  // A functional test cannot see this — the flag is correct right up until this
  // mapper discards it — so the mappers are checked by name.
  const MOD_MAPPERS: Array<{ file: string; from: string; to: string }> = [
    { file: "sales-orders.ts", from: "const modItems", to: "const modResp" },
    { file: "estimates.ts", from: "const modItems", to: "const modResp" },
  ];
  for (const m of MOD_MAPPERS) {
    const p = join(__dirname, "..", "..", "lib", "quickbooks", "client", m.file);
    let block = "";
    try {
      const src = readFileSync(p, "utf8");
      const a = src.indexOf(m.from);
      const b = src.indexOf(m.to, a);
      block = a >= 0 && b > a ? src.slice(a, b) : "";
    } catch {
      block = "";
    }
    if (block.length === 0) {
      failures++;
      log(`  FAIL  ${m.file}: could not locate the ${m.from} block`);
      continue;
    }
    // All three matter: taxable decides Tax/Non, and noSite/qbItemType keep a
    // non-inventory line from getting an <InventorySiteRef> (QB error 3140).
    const fields: Array<[string, RegExp]> = [
      ["taxable", /\btaxable\b\s*:\s*item\.taxable/],
      ["noSite", /\bnoSite\b\s*:\s*(true|item\.noSite)/],
      ["qbItemType", /\bqbItemType\b\s*:\s*item\.qbItemType/],
    ];
    const missing = fields.filter(([, re]) => !re.test(block)).map(([n]) => n);
    if (missing.length > 0) {
      failures++;
      log(`  FAIL  ${m.file} modItems drops: ${missing.join(", ")}`);
    } else {
      log(`  PASS  ${m.file} modItems forwards taxable + noSite + qbItemType`);
    }
  }

  log(
    failures === 0
      ? "\n✅ tax flag reaches the QB payload on both the NEW and MOD paths\n"
      : `\n❌ ${failures} check(s) failed — an order's tax info is not reaching QuickBooks\n`
  );
  if (failures > 0) process.exitCode = 1;
}
