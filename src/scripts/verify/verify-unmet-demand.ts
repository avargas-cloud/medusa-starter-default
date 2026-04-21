/**
 * src/scripts/verify/verify-unmet-demand.ts
 *
 * Synthetic verifier for the unmet-demand totals math — no live DB calls.
 * Run via `npx medusa exec ./src/scripts/verify/verify-unmet-demand.ts`.
 *
 * Covers:
 *   - Empty record                 → all totals 0
 *   - Only requested lines         → requested=X, purchased=0, unmet=X
 *   - Only purchased lines         → requested=0, purchased=Y, unmet=-Y
 *   - Mixed: requested > purchased → positive unmet
 *   - Mixed: requested < purchased → negative unmet (over-fulfilled edge)
 *   - Quantity × unit_price subtotals match
 *   - Multi-line aggregation
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import {
  computeTotals,
  normalizeItem,
  type NormalizedItem,
} from "../../api/admin/unmet-demand/_lib/totals";
import type { ItemInput } from "../../api/admin/unmet-demand/_lib/validators";

interface Scenario {
  name: string;
  items: ItemInput[];
  expected: {
    requested_total_cents: number;
    purchased_total_cents: number;
    unmet_value_cents: number;
    subtotals: number[];
  };
}

const line = (
  kind: "requested" | "purchased",
  sku: string,
  qty: number,
  cents: number
): ItemInput => ({
  kind,
  product_id: null,
  variant_id: null,
  sku,
  title: `Item ${sku}`,
  quantity: qty,
  unit_price_cents: cents,
});

const scenarios: Scenario[] = [
  {
    name: "empty record",
    items: [],
    expected: {
      requested_total_cents: 0,
      purchased_total_cents: 0,
      unmet_value_cents: 0,
      subtotals: [],
    },
  },
  {
    name: "single requested line",
    items: [line("requested", "SKU-A", 2, 1500)],
    expected: {
      requested_total_cents: 3000,
      purchased_total_cents: 0,
      unmet_value_cents: 3000,
      subtotals: [3000],
    },
  },
  {
    name: "single purchased line (over-fulfilled)",
    items: [line("purchased", "SKU-B", 1, 999)],
    expected: {
      requested_total_cents: 0,
      purchased_total_cents: 999,
      unmet_value_cents: -999,
      subtotals: [999],
    },
  },
  {
    name: "mixed requested > purchased",
    items: [
      line("requested", "SKU-A", 3, 1000), // 3000
      line("requested", "SKU-C", 1, 2500), // 2500
      line("purchased", "SKU-B", 2, 800),  // 1600
    ],
    expected: {
      requested_total_cents: 5500,
      purchased_total_cents: 1600,
      unmet_value_cents: 3900,
      subtotals: [3000, 2500, 1600],
    },
  },
  {
    name: "mixed requested < purchased (negative unmet)",
    items: [
      line("requested", "SKU-A", 1, 100),  // 100
      line("purchased", "SKU-Z", 5, 500),  // 2500
    ],
    expected: {
      requested_total_cents: 100,
      purchased_total_cents: 2500,
      unmet_value_cents: -2400,
      subtotals: [100, 2500],
    },
  },
  {
    name: "large quantities + multi-line aggregation",
    items: [
      line("requested", "SKU-1", 10, 19999),
      line("requested", "SKU-2", 50, 125),
      line("requested", "SKU-3", 1, 50000),
      line("purchased", "SKU-1", 5, 19999),
      line("purchased", "SKU-4", 20, 299),
    ],
    expected: {
      requested_total_cents: 10 * 19999 + 50 * 125 + 1 * 50000,
      purchased_total_cents: 5 * 19999 + 20 * 299,
      unmet_value_cents:
        10 * 19999 + 50 * 125 + 1 * 50000 - (5 * 19999 + 20 * 299),
      subtotals: [10 * 19999, 50 * 125, 50000, 5 * 19999, 20 * 299],
    },
  },
];

function assertEqual<T>(
  label: string,
  actual: T,
  expected: T,
  failures: string[]
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `  ✗ ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(
        expected
      )}`
    );
  }
}

export default async function verify({
  container: _c,
}: {
  container: MedusaContainer;
}): Promise<void> {
  let passed = 0;
  let failed = 0;
  const failuresByScenario: Array<{ name: string; failures: string[] }> = [];

  for (const s of scenarios) {
    const failures: string[] = [];
    const normalized: NormalizedItem[] = s.items.map(normalizeItem);

    assertEqual(
      "subtotals",
      normalized.map((n) => n.subtotal_cents),
      s.expected.subtotals,
      failures
    );

    const totals = computeTotals(normalized);
    assertEqual(
      "requested_total_cents",
      totals.requested_total_cents,
      s.expected.requested_total_cents,
      failures
    );
    assertEqual(
      "purchased_total_cents",
      totals.purchased_total_cents,
      s.expected.purchased_total_cents,
      failures
    );
    assertEqual(
      "unmet_value_cents",
      totals.unmet_value_cents,
      s.expected.unmet_value_cents,
      failures
    );

    if (failures.length === 0) {
      passed += 1;
      console.log(`✓ ${s.name}`);
    } else {
      failed += 1;
      failuresByScenario.push({ name: s.name, failures });
      console.log(`✗ ${s.name}`);
    }
  }

  console.log("");
  console.log(
    `Unmet-demand totals verifier: ${passed} passed, ${failed} failed`
  );

  if (failed > 0) {
    console.log("");
    for (const f of failuresByScenario) {
      console.log(`Scenario: ${f.name}`);
      for (const line of f.failures) console.log(line);
    }
    process.exitCode = 1;
  }
}
