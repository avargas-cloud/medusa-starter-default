/**
 * Read-only probe: does the SERVER-SIDE derivation reproduce the POS figures on
 * the orders that carry BOTH a per-line discount (baked into `unit_price`) and a
 * separate order-level discount (in the adjustments)?
 *
 * Those 7 orders / 147 lines are where a GROSS-based base overstated the total
 * by up to $1,338. The data distinguishes the two layers perfectly — the line
 * carries `metadata.line_discount {type,value}` and the adjustment carries a
 * code like `ORDER-DISCOUNT-25%` — so the NET already has the per-line layer
 * applied and the adjustments are the order layer.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/debug/probe-overlap-discount.ts
 */
import { Pool } from "pg";

import {
  loadOrderMoneyBase,
  resolvePatchedOrderTotal,
} from "../../lib/order-money/order-tax-lines";

const DOCS = ["E2606", "E2607", "E1344", "E1497", "E2146"];

/**
 * Subtotals read back FROM QUICKBOOKS over the bridge, in cents.
 *
 * `metadata.computed_subtotal` is a POS snapshot and on these documents it is
 * the value that disagrees with the issued document: E1497's estimate in QB
 * carries 30097.89 while the snapshot says 30097.30. The customer holds QB's
 * copy, so QB is the reference and the snapshot is not.
 *
 * Only documents whose QB figure was actually read belong here — an entry is a
 * measurement, never an expectation someone typed.
 */
const QB_SUBTOTAL_CENTS: Record<string, number> = {
  E1497: 3009789, // TxnID 1C171D-1776951056
};
const P = new Pool({
  connectionString: "postgresql://postgres:sandbox@localhost:5499/medusa",
});

async function main() {
  let bad = 0;
  for (const doc of DOCS) {
    const r = await P.query(
      `SELECT id,
              metadata->>'computed_total'      AS total,
              metadata->>'computed_discount'   AS disc,
              metadata->>'computed_tax_amount' AS tax,
              metadata->>'computed_subtotal'   AS sub
         FROM "order" WHERE metadata->>'document_number' = $1`,
      [doc]
    );
    const o = r.rows[0];
    if (!o) {
      console.log(`  --   ${doc}: no esta en el sandbox`);
      continue;
    }
    if (o.total == null) {
      console.log(`  --   ${doc}: sin metadata computed_* (anterior a esos campos)`);
      continue;
    }

    const base = await loadOrderMoneyBase(P, o.id);
    const tax = Number(o.tax ?? 0);
    const res = resolvePatchedOrderTotal({
      base,
      posTaxAmount: tax,
      discount: Number(o.disc ?? 0),
    });
    const got = res.ok ? res.total : NaN;
    const want = Number(o.total);

    // Where QuickBooks has been read, IT is the reference: the gross line sum
    // we derive must equal QB's Subtotal, because that is the number printed on
    // the document the customer received. Comparing to `computed_total` instead
    // would grade the derivation against a POS snapshot that is itself out of
    // step with QB on exactly the orders where rounding matters.
    const qbCents = QB_SUBTOTAL_CENTS[doc];
    let ok: boolean;
    if (qbCents !== undefined) {
      const grossCents = Math.round(
        (base.netDollars + base.adjustmentsDollars) * 100
      );
      ok = grossCents === qbCents;
      console.log(
        `  ${ok ? "OK  " : "DIFF"} ${doc}  contra QB: gross $${(grossCents / 100).toFixed(2)} ` +
          `vs QB Subtotal $${(qbCents / 100).toFixed(2)}` +
          `   (snapshot POS $${o.sub}, que difiere de QB a proposito)`
      );
      if (!ok) bad++;
      continue;
    }

    ok = Math.abs(got - want) < 0.02;
    if (!ok) bad++;

    console.log(
      `  ${ok ? "OK  " : "DIFF"} ${doc}  base $${base.netDollars.toFixed(2)} (POS subtotal $${o.sub}) | ` +
        `adj $${base.adjustmentsDollars.toFixed(2)} (POS disc $${o.disc}) | tax $${tax.toFixed(2)}`
    );
    console.log(
      `         backend $${Number.isFinite(got) ? got.toFixed(2) : "REFUSED"}   POS $${want.toFixed(2)}`
    );
  }
  console.log(
    bad === 0
      ? "\n  OK - la derivacion del backend coincide con el POS en todas\n"
      : `\n  FALLA - ${bad} orden(es) difieren\n`
  );
  await P.end();
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
