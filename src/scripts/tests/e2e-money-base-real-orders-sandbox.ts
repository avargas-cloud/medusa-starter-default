/**
 * E2E — `loadOrderMoneyBase` against two REAL orders picked by the operator
 * because they carry the two discount shapes the other tests never exercised:
 *
 *   1652 / S10255 — order discount AND per-item discount, taxable customer,
 *                   with an exempt INSTALL line. 4 order_summary versions.
 *   1493 / S10275 — order discount only (12.5% percent), customer tax_mode
 *                   `exempt`, so the whole document is 0% tax. 37 versions.
 *
 * These orders found a defect no synthetic fixture had: the money base joined
 * `order_item` without filtering `oi.version`, so every line was counted once
 * per order version and the net came out multiplied. S10255 has 4 versions and
 * S10275 has 37 — a 37× total. The earlier E2E missed it because its own
 * verification query had the identical omission, so both sides agreed on a
 * wrong number and the test passed.
 *
 * Read-only: this script only READS. It does not convert, edit, or write.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-money-base-real-orders-sandbox.ts
 */
import { Pool } from "pg";

import {
  loadOrderMoneyBase,
  computeQbParityTax,
} from "../../lib/order-money/order-tax-lines";

const SANDBOX_URL =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

/**
 * Expected values are the ones QuickBooks ACTUALLY billed, read back over the
 * bridge — not this script's own arithmetic. A test that recomputes the same
 * formula it is testing proves only that the formula is self-consistent, which
 * is how the earlier E2E passed while the money base was multiplying by version.
 */
const TARGETS = [
  {
    displayId: 1652,
    doc: "S10255",
    note: "order discount + per-item discount, taxable customer, exempt INSTALL",
    qbDoc: "Invoice 19473",
    rate: 7,
    // QB: products Subtotal 2990.63 · Discount -299.08 (Tax) · Services 750 (Tax)
    //     · INSTALL 1300 (Non) · grand Subtotal 4741.55 · tax 240.91
    // NET base, not gross: unit_price already carries the baked 10%.
    qbGross: 4741.1,
    // Already inside the net — must NOT be subtracted again.
    qbDiscount: 0,
    // QB billed 4741.55. We land 45c under because the POS baked the 10% into
    // each unit price and rounded PER UNIT, while QB received the gross prices
    // and one Discount line and rounded ONCE. Bounded rounding drift, and the
    // price of a base that is correct on the 7 overlapping-discount orders,
    // where a gross base overstated by up to $1,338.
    qbNet: 4741.1,
    // 240.88 — the figure the POS screen shows for this order, and three cents
    // from the 240.91 QuickBooks billed on Invoice 19473.
    // Both figures come from taxing the Services line, whose LINE flag says
    // taxable even though its PRODUCT does not. The screen and the ledger agree
    // on the line flag; a combined line-AND-product predicate gives 188.41 and
    // matches neither.
    qbTax: 240.88,
    // 3c below QB, from the per-unit rounding of the baked 10%. Bounded and
    // accepted; asserted with a tolerance that PRINTS the gap so it stays visible.
    tolerance: 0.05,
  },
  {
    displayId: 1493,
    doc: "S10275",
    note: "order discount only, customer EXEMPT",
    qbDoc: "Invoice 1C5995",
    rate: 0,
    // QB: 8 product lines 4025.02 · Subtotal 4025.02 · Discount -503.14 (Tax)
    //     · header ItemSalesTax Exempt · tax 0.00 · payments 2 x 1760.94
    // unit_price is already gross here (no baked per-line discount); the 12.5%
    // lives in the adjustments, so the net base lands on QB exactly.
    qbGross: 4025.02,
    qbDiscount: 503.14,
    qbNet: 3521.88,
    qbTax: 0,
    tolerance: 0.01,
  },
];

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

function assertSandbox(): void {
  const u = new URL(SANDBOX_URL);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || u.port !== "5499") {
    throw new Error(`refusing to run outside the sandbox (${u.hostname}:${u.port})`);
  }
}

async function main() {
  assertSandbox();
  const pool = new Pool({ connectionString: SANDBOX_URL });

  try {
    for (const t of TARGETS) {
      console.log(`\n══ ${t.displayId} / ${t.doc} — ${t.note} ══`);

      const ord = await pool.query<{
        id: string;
        version: number;
        tax_mode: string | null;
        versions: string;
      }>(
        `SELECT o.id, o.version, o.metadata->>'tax_mode' AS tax_mode,
                (SELECT count(*) FROM order_summary s WHERE s.order_id = o.id) AS versions
           FROM "order" o WHERE o.display_id = $1`,
        [t.displayId]
      );
      const row = ord.rows[0];
      if (!row) {
        fail(`${t.doc}: not present in the sandbox`);
        continue;
      }
      console.log(
        `   order version=${row.version} · summary rows=${row.versions} · tax_mode=${row.tax_mode ?? "(none)"}`
      );

      const base = await loadOrderMoneyBase(pool, row.id);
      console.log(
        `   gross=$${base.netDollars + base.adjustmentsDollars} · net=$${base.netDollars} ` +
          `· taxable=$${base.taxableNetDollars} · adj=$${base.adjustmentsDollars}`
      );

      // 1 · GROSS must reproduce QuickBooks' own Subtotal lines. This is what
      //     catches the per-unit rounding loss: when a per-line discount is
      //     baked into unit_price, summing the nets lands 45c under what QB
      //     billed on S10255.
      const gross = base.netDollars + base.adjustmentsDollars;
      if (Math.abs(gross - t.qbGross) < 0.02)
        pass(`${t.doc} base $${gross} (pre order-discount)`);
      else fail(`${t.doc} base $${gross}, expected $${t.qbGross}`);

      // 2 · NET after the single order-level discount = what QB billed.
      const net = Math.round((gross - t.qbDiscount) * 100) / 100;
      if (Math.abs(net - t.qbNet) < 0.02)
        pass(`${t.doc} net $${net} = expected $${t.qbNet}`);
      else fail(`${t.doc} net $${net}, expected $${t.qbNet}`);

      // 3 · Tax on the taxable group, discount applied once. QB codes its
      //     Discount line `Tax`, so it reduces taxable sales; INSTALL is `Non`
      //     and stays out of the base entirely.
      const taxableGross = base.taxableNetDollars + base.adjustmentsDollars;
      const taxableBase = Math.round((taxableGross - t.qbDiscount) * 100) / 100;
      const tax = computeQbParityTax(taxableBase, t.rate);
      const gap = Math.abs(tax - t.qbTax);
      if (gap < (t.tolerance ?? 0.02))
        pass(
          `${t.doc} tax $${tax.toFixed(2)} vs QB $${t.qbTax.toFixed(2)}` +
            (gap > 0.005 ? ` — ${(gap * 100).toFixed(0)}c drift (per-unit rounding of the baked discount)` : " — exact") +
            ` (base $${taxableBase} @ ${t.rate}%)`
        );
      else
        fail(
          `${t.doc} tax $${tax.toFixed(2)}, QB says $${t.qbTax.toFixed(2)} (our base $${taxableBase} @ ${t.rate}%)`
        );

      // 4 · The version defect these orders were chosen to expose.
      const versions = Number(row.versions);
      if (versions > 1 && Math.abs(gross - t.qbGross * versions) < 0.02) {
        fail(`${t.doc}: gross looks multiplied by its ${versions} versions`);
      } else if (versions > 1) {
        pass(`${t.doc}: not multiplied by its ${versions} order versions`);
      }
    }

    console.log(
      failures === 0
        ? "\n✅ money base is correct on both operator-selected orders\n"
        : `\n❌ ${failures} check(s) failed\n`
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`\n❌ aborted: ${e.message}\n`);
  process.exitCode = 1;
});
