/**
 * verify-treasury-daily-split.ts
 *
 * Synthetic-input verification of the pure split helper. Runs without a
 * database — exercises the rounding, edge cases, and the delta=0 invariant
 * directly. Run with:
 *
 *     npx tsx src/scripts/verify/verify-treasury-daily-split.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

import {
  computeSplits,
  type SplitInputs,
  type TreasuryBucketCode,
} from "../../api/admin/accounting/treasury/_lib/compute-splits";

const ACTIVE_ALL: ReadonlyArray<TreasuryBucketCode> = [
  "china_cogs",
  "local_cogs",
  "tax_holding",
  "operating",
  "reserve",
];

interface Scenario {
  name: string;
  inputs: SplitInputs;
  expect: {
    delta_cents: 0;
    /** Optional bucket-level expectations (subset OK). */
    splits?: Partial<Record<TreasuryBucketCode, number>>;
  };
}

const SCENARIOS: Scenario[] = [
  {
    name: "A. Mixed china/local day — clean ratios",
    inputs: {
      gross_revenue_pre_tax_cents: 100_000,
      tax_collected_cents: 8_000,
      cogs_china_cents: 40_000,
      cogs_local_cents: 20_000,
      net_cash_received_cents: 108_000,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: {
      delta_cents: 0,
      splits: {
        tax_holding: 8_000,
      },
    },
  },
  {
    name: "B. Service-only day — no COGS",
    inputs: {
      gross_revenue_pre_tax_cents: 50_000,
      tax_collected_cents: 0,
      cogs_china_cents: 0,
      cogs_local_cents: 0,
      net_cash_received_cents: 50_000,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: {
      delta_cents: 0,
      splits: {
        china_cogs: 0,
        local_cogs: 0,
        tax_holding: 0,
        operating: 50_000,
      },
    },
  },
  {
    name: "C. Refund-heavy day — net cash negative",
    inputs: {
      gross_revenue_pre_tax_cents: 10_000,
      tax_collected_cents: 800,
      cogs_china_cents: 4_000,
      cogs_local_cents: 2_000,
      net_cash_received_cents: -5_000, // refunds > today's sales
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "D. Net cash below tax — operating absorbs shortfall",
    inputs: {
      gross_revenue_pre_tax_cents: 1_000,
      tax_collected_cents: 5_000,
      cogs_china_cents: 0,
      cogs_local_cents: 600,
      net_cash_received_cents: 2_000,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "E. Rounding remainder routed to operating",
    inputs: {
      gross_revenue_pre_tax_cents: 333,
      tax_collected_cents: 0,
      cogs_china_cents: 100,
      cogs_local_cents: 200,
      net_cash_received_cents: 333,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "F. Reserve inactive — splits still reconcile",
    inputs: {
      gross_revenue_pre_tax_cents: 80_000,
      tax_collected_cents: 6_000,
      cogs_china_cents: 30_000,
      cogs_local_cents: 10_000,
      net_cash_received_cents: 86_000,
      active_bucket_codes: ["china_cogs", "local_cogs", "tax_holding", "operating"],
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "G. Only china bucket active among COGS buckets",
    inputs: {
      gross_revenue_pre_tax_cents: 50_000,
      tax_collected_cents: 0,
      cogs_china_cents: 30_000,
      cogs_local_cents: 0,
      net_cash_received_cents: 50_000,
      active_bucket_codes: ["china_cogs", "tax_holding", "operating"],
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "H. Zero day — all zeros",
    inputs: {
      gross_revenue_pre_tax_cents: 0,
      tax_collected_cents: 0,
      cogs_china_cents: 0,
      cogs_local_cents: 0,
      net_cash_received_cents: 0,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: { delta_cents: 0 },
  },
  {
    name: "I. COGS exceeds revenue — recovery share clamped at 1",
    inputs: {
      gross_revenue_pre_tax_cents: 1_000,
      tax_collected_cents: 0,
      cogs_china_cents: 800,
      cogs_local_cents: 800, // total cogs (1600) > revenue (1000)
      net_cash_received_cents: 1_000,
      active_bucket_codes: ACTIVE_ALL,
    },
    expect: { delta_cents: 0 },
  },
];

let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`  ✗ ${msg}`);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

for (const sc of SCENARIOS) {
  console.log(`\nScenario ${sc.name}`);
  const r = computeSplits(sc.inputs);
  const delta = r.reconciliation.delta_cents;
  if (delta !== sc.expect.delta_cents) {
    fail(`delta_cents expected ${sc.expect.delta_cents}, got ${delta}`);
  } else {
    pass(`delta_cents = 0`);
  }

  const sum = r.splits.reduce((a, s) => a + s.amount_cents, 0);
  if (sum !== sc.inputs.net_cash_received_cents) {
    fail(`sum_of_splits ${sum} ≠ net_cash ${sc.inputs.net_cash_received_cents}`);
  } else {
    pass(`sum_of_splits = net_cash_received`);
  }

  if (sc.expect.splits) {
    for (const [code, expected] of Object.entries(sc.expect.splits)) {
      const got = r.splits.find((s) => s.code === code)?.amount_cents;
      if (got !== expected) {
        fail(`${code} expected ${expected}, got ${got}`);
      } else {
        pass(`${code} = ${expected}`);
      }
    }
  }

  // Inactive buckets must not appear in result.
  const activeSet = new Set(sc.inputs.active_bucket_codes);
  for (const s of r.splits) {
    if (!activeSet.has(s.code) && s.code !== "operating") {
      // operating is auto-forced as the sink even if absent from active list
      fail(`inactive bucket "${s.code}" appears in splits`);
    }
  }
}

console.log(`\n${failures === 0 ? "✅ All scenarios passed" : `❌ ${failures} assertion failure(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
