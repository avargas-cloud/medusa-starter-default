/**
 * verify-shipping-line-nontaxable.ts
 *
 * Cross-repo gate for the freight-taxed-in-QuickBooks bug.
 *
 * The POS never puts shipping in the tax base (`store-pos/lib/pos-totals.ts`
 * computes tax over the taxable line subset and adds shipping AFTER), so the
 * QB line has to say so explicitly. It did not: `buildShippingQbItem()` emitted
 * no `taxable` flag, and the bridge's invoice builder falls through to
 *
 *     data.salesTaxCode && item.productId  ->  <SalesTaxCodeRef>Tax</...>
 *
 * for every line carrying a productId. The freight line carries one (the
 * SHIPPING & HANDLING ListID), so QuickBooks taxed it — QB 19733 came out
 * $3.85 above POS invoice 21481 and the payment stopped matching.
 *
 * A unit test on `buildShippingQbItem` only proves the flag is set on OUR side.
 * What actually decides the tax is the XML the BRIDGE emits, in another repo,
 * from its own compiled builder. So this gate feeds the real shipping item
 * through the real bridge builder and reads the resulting QBXML.
 *
 * Both branches are asserted, plus a negative control: strip `taxable` and the
 * same builder must go back to emitting `Tax`. Without that control a builder
 * that emitted `Non` unconditionally would pass and prove nothing.
 *
 * Run:  ./node_modules/.bin/tsx src/scripts/verify/verify-shipping-line-nontaxable.ts
 */
import * as os from "os";

import { buildShippingQbItem } from "../../lib/quickbooks/order-flow-core";

/* eslint-disable @typescript-eslint/no-var-requires */
const BRIDGE_BUILDER =
  "../../../../quickbooks-bridge/dist/qbxml/builders/invoice.js";

type Line = { taxCode: "Tax" | "Non" | null; isShipping: boolean };

/** Pulls one entry per InvoiceLineAdd: its tax code and whether it is the freight line. */
function readLines(xml: string, shippingListId: string): Line[] {
  return (xml.match(/<InvoiceLineAdd>[\s\S]*?<\/InvoiceLineAdd>/g) ?? []).map(
    (block) => {
      const m = block.match(
        /<SalesTaxCodeRef><FullName>(Tax|Non)<\/FullName><\/SalesTaxCodeRef>/
      );
      return {
        taxCode: (m?.[1] as "Tax" | "Non" | undefined) ?? null,
        isShipping: block.includes(shippingListId),
      };
    }
  );
}

function main(): void {
  // The bridge builder debug-writes `last_invoice.xml` into the CURRENT working
  // directory on every call. Run from the repo root that drops an untracked
  // file into the working tree on every run, which is how it ends up staged by
  // accident. Move the cwd out of the repo first — `require` below resolves
  // relative to this module, not to the cwd, so nothing else is affected.
  process.chdir(os.tmpdir());

  let buildInvoiceRequest: (op: any) => string;
  try {
    ({ buildInvoiceRequest } = require(BRIDGE_BUILDER));
  } catch (e: any) {
    console.error(
      `❌ Could not load the bridge builder at ${BRIDGE_BUILDER}.\n` +
        `   The bridge clone must be present and built (yarn build in quickbooks-bridge/).\n` +
        `   ${e?.message ?? e}`
    );
    process.exit(1);
  }

  const shipping = buildShippingQbItem([{ name: "UPS Ground", amount: 55 }]);
  if (!shipping) {
    console.error("❌ buildShippingQbItem returned null for a $55 UPS Ground method");
    process.exit(1);
  }
  const shippingListId = String(shipping.productId);

  const product = {
    productId: "800019F7-1716324696",
    quantity: 1,
    price: 40.75,
    amount: 40.75,
    desc: "a taxable product line",
  };

  const buildXml = (shippingItem: Record<string, unknown>): string =>
    buildInvoiceRequest({
      action: "add",
      data: {
        customerId: "80000001-1111111111",
        // Present exactly as in production for a taxed order — this is the
        // input that arms the builder's `Tax` branch.
        salesTaxCode: "Sale Tax 7%",
        items: [product, shippingItem],
      },
    });

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failures++;
  };

  // ── 1. The real item, through the real builder ──────────────────────────
  const lines = readLines(buildXml(shipping as any), shippingListId);
  const ship = lines.find((l) => l.isShipping);
  const goods = lines.filter((l) => !l.isShipping);

  check(
    "the builder emitted one line per item",
    lines.length === 2,
    `got ${lines.length} InvoiceLineAdd blocks`
  );
  check(
    "the shipping line is coded Non",
    ship?.taxCode === "Non",
    `shipping line came out as ${ship?.taxCode ?? "(no SalesTaxCodeRef)"}`
  );
  check(
    "product lines are still coded Tax",
    goods.length > 0 && goods.every((l) => l.taxCode === "Tax"),
    `product lines came out as ${goods.map((l) => l.taxCode).join(", ")}`
  );

  // ── 2. Negative control: without the flag the bug must come back ─────────
  // If this passes as "Non" too, the builder is not reading the flag at all and
  // assertion 1 above proves nothing.
  const { taxable: _dropped, ...withoutFlag } = shipping as any;
  const controlShip = readLines(buildXml(withoutFlag), shippingListId).find(
    (l) => l.isShipping
  );
  check(
    "negative control: dropping `taxable` brings the Tax branch back",
    controlShip?.taxCode === "Tax",
    `expected Tax without the flag, got ${controlShip?.taxCode ?? "(none)"} — ` +
      `the builder is not reading the flag, so this gate is not measuring anything`
  );

  console.log(
    failures === 0
      ? "\n✅ PASS — the freight line reaches QuickBooks non-taxable."
      : `\n❌ FAIL — ${failures} assertion(s) failed.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
