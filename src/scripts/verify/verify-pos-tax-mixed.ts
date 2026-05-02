/**
 * Verifies the pos-tax provider's per-line tax exemption logic against
 * synthetic mixed-taxability orders. No DB writes — pure in-process call
 * to PosTaxProvider.getTaxLines(itemLines, shippingLines, context).
 *
 * Each scenario:
 *   • Builds a synthetic itemLines payload with `line_item.taxable` flags
 *   • Calls the provider
 *   • Asserts each returned rate matches expected (FL 7% vs EXEMPT 0%)
 *   • Asserts total tax (sum of line totals × rate) matches the expected cents
 *
 * Run: cd backend && yarn medusa exec ./src/scripts/verify/verify-pos-tax-mixed.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import PosTaxProvider from "../../modules/pos-tax/service";

type SynthLine = {
  id: string;
  total: number; // cents
  taxable?: boolean; // undefined treated as true
  metadataTaxable?: boolean | undefined; // override path: line_item.metadata.taxable === false
};

type Scenario = {
  name: string;
  customerExempt?: boolean;
  lines: SynthLine[];
  // Expected per-line: 'FL' (taxable 7%) or 'EXEMPT' (0%)
  expectedCodes: Array<"FL" | "EXEMPT">;
  // Expected total tax in cents (sum of (taxable_line_total * 7%)) — provider only
  // emits rate lines, totals are computed by Medusa's tax service. We compute the
  // expected here to assert the verifier's intent matches the expected business outcome.
  expectedTaxCents: number;
};

const SCENARIOS: Scenario[] = [
  {
    name: "all-taxable (regression)",
    lines: [
      { id: "l1", total: 6999, taxable: true },
      { id: "l2", total: 75000, taxable: true },
    ],
    expectedCodes: ["FL", "FL"],
    expectedTaxCents: Math.round((6999 + 75000) * 0.07),
  },
  {
    name: "single non-taxable line (INSTALL pattern)",
    lines: [
      { id: "l1", total: 6999, taxable: true },
      { id: "l2", total: 130000, taxable: false }, // INSTALL
    ],
    expectedCodes: ["FL", "EXEMPT"],
    expectedTaxCents: Math.round(6999 * 0.07),
  },
  {
    name: "Invoice 19473 layout (items + materials + services taxable, INSTALL exempt)",
    lines: [
      { id: "items_subtotal", total: 269157, taxable: true }, // items+materials post-discount
      { id: "services", total: 75000, taxable: true },
      { id: "install", total: 130000, taxable: false },
    ],
    expectedCodes: ["FL", "FL", "EXEMPT"],
    expectedTaxCents: Math.round((269157 + 75000) * 0.07), // 24091
  },
  {
    name: "all non-taxable",
    lines: [
      { id: "l1", total: 50000, taxable: false },
      { id: "l2", total: 25000, taxable: false },
    ],
    expectedCodes: ["EXEMPT", "EXEMPT"],
    expectedTaxCents: 0,
  },
  {
    name: "tax-exempt customer (all 0%)",
    customerExempt: true,
    lines: [
      { id: "l1", total: 6999, taxable: true },
      { id: "l2", total: 130000, taxable: false },
    ],
    expectedCodes: ["EXEMPT", "EXEMPT"],
    expectedTaxCents: 0,
  },
  {
    name: "tax-exempt customer + non-taxable mix",
    customerExempt: true,
    lines: [
      { id: "l1", total: 75000, taxable: true },
      { id: "l2", total: 130000, taxable: false },
    ],
    expectedCodes: ["EXEMPT", "EXEMPT"],
    expectedTaxCents: 0,
  },
  {
    name: "metadata.taxable=false override (custom item path)",
    lines: [
      { id: "l1", total: 5000, taxable: true },
      { id: "l2", total: 30000, taxable: true, metadataTaxable: false },
    ],
    expectedCodes: ["FL", "EXEMPT"],
    expectedTaxCents: Math.round(5000 * 0.07),
  },
  {
    name: "default (taxable undefined) treated as taxable",
    lines: [
      { id: "l1", total: 10000 }, // no flag → default true
      { id: "l2", total: 5000, taxable: false },
    ],
    expectedCodes: ["FL", "EXEMPT"],
    expectedTaxCents: Math.round(10000 * 0.07),
  },
];

function buildItemLines(lines: SynthLine[]): any[] {
  return lines.map((l) => ({
    line_item: {
      id: l.id,
      taxable: l.taxable,
      metadata: l.metadataTaxable === false ? { taxable: false } : {},
    },
  }));
}

function summarize(rateLines: any[]): {
  codesByLine: Record<string, "FL" | "EXEMPT">;
  taxCents: (linesById: Record<string, number>) => number;
} {
  const codesByLine: Record<string, "FL" | "EXEMPT"> = {};
  for (const r of rateLines) {
    if (!r.line_item_id) continue;
    codesByLine[r.line_item_id] = r.code === "EXEMPT" ? "EXEMPT" : "FL";
  }
  return {
    codesByLine,
    taxCents: (linesById) => {
      let cents = 0;
      for (const r of rateLines) {
        if (!r.line_item_id) continue;
        const lineTotal = linesById[r.line_item_id] ?? 0;
        cents += Math.round((lineTotal * r.rate) / 100);
      }
      return cents;
    },
  };
}

export default async function verifyPosTaxMixed({ container: _container }: ExecArgs) {
  console.log("\n" + "=".repeat(70));
  console.log("Verifier: pos-tax per-item exemption — synthetic scenarios");
  console.log("=".repeat(70));

  const provider = new PosTaxProvider();

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const sc of SCENARIOS) {
    const itemLines = buildItemLines(sc.lines);
    const ctx: any = sc.customerExempt
      ? { customer: { customer_groups: [{ name: "tax-exempt" }] } }
      : { customer: { customer_groups: [] } };

    let rateLines: any[];
    try {
      rateLines = (await provider.getTaxLines(itemLines, [], ctx)) as any[];
    } catch (err: any) {
      failed++;
      failures.push(`${sc.name}: provider threw ${err?.message ?? err}`);
      continue;
    }

    const { codesByLine, taxCents } = summarize(rateLines);
    const linesById = Object.fromEntries(sc.lines.map((l) => [l.id, l.total]));
    const observed = sc.lines.map(
      (l) => codesByLine[l.id] ?? ("MISSING" as any)
    );
    const expected = sc.expectedCodes;

    const codesMatch =
      observed.length === expected.length &&
      observed.every((c, i) => c === expected[i]);

    const observedTax = taxCents(linesById);
    const taxMatch = observedTax === sc.expectedTaxCents;

    if (codesMatch && taxMatch) {
      passed++;
      console.log(
        `✅ ${sc.name}\n   codes=[${observed.join(", ")}] tax=${(observedTax / 100).toFixed(2)}`
      );
    } else {
      failed++;
      const detail = [
        `   expected codes: [${expected.join(", ")}]`,
        `   observed codes: [${observed.join(", ")}]`,
        `   expected tax:   $${(sc.expectedTaxCents / 100).toFixed(2)}`,
        `   observed tax:   $${(observedTax / 100).toFixed(2)}`,
      ].join("\n");
      const msg = `❌ ${sc.name}\n${detail}`;
      console.log(msg);
      failures.push(msg);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Results: ${passed} passed / ${failed} failed (of ${SCENARIOS.length})`);
  console.log("=".repeat(70));

  if (failed > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(f + "\n"));
    process.exitCode = 1;
  }
}
