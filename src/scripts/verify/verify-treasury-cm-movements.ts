/**
 * verify-treasury-cm-movements.ts
 *
 * Synthetic-input verification of the pure credit-memo movement derivation
 * (deriveCmMovement). Runs without a database — exercises the vector delta,
 * movement direction, backing-status gating, surplus/shortfall, the
 * needs_attention filter, and hash determinism/sensitivity. Run with:
 *
 *     npx tsx src/scripts/verify/verify-treasury-cm-movements.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

import {
  deriveCmMovement,
  type CmMovementInputs,
} from "../../api/admin/accounting/treasury/_lib/load-cm-movements";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

// Base with all backing lines costed → cash_backed unless overridden.
function base(over: Partial<CmMovementInputs> = {}): CmMovementInputs {
  return {
    payment_application_id: "papp_test",
    amount_applied_cents: 10000,
    backing_china_cents: 0,
    backing_local_cents: 0,
    consumption_china_cents: 0,
    consumption_local_cents: 0,
    backing_lines_total: 2,
    backing_lines_costed: 2,
    ...over,
  };
}

console.log("1) China backing → Local consumption → china→local");
{
  const d = deriveCmMovement(
    base({ backing_china_cents: 4000, consumption_local_cents: 4000 })
  );
  check("suggests china→local", d.suggested_movement?.from === "china_cogs" && d.suggested_movement?.to === "local_cogs");
  check("cents = min(4000,4000) = 4000", d.suggested_movement?.cents === 4000, d.suggested_movement);
  check("needs_attention", d.needs_attention);
  check("surplus/shortfall = 0", d.surplus_shortfall_cents === 0);
}

console.log("2) Local backing → China consumption → local→china (reverse)");
{
  const d = deriveCmMovement(
    base({ backing_local_cents: 3000, consumption_china_cents: 3000 })
  );
  check("suggests local→china", d.suggested_movement?.from === "local_cogs" && d.suggested_movement?.to === "china_cogs");
  check("cents = 3000", d.suggested_movement?.cents === 3000);
}

console.log("3) Mixed vector delta (CN30/LO10 → CN10/LO30) → $20 china→local");
{
  const d = deriveCmMovement(
    base({
      backing_china_cents: 3000,
      backing_local_cents: 1000,
      consumption_china_cents: 1000,
      consumption_local_cents: 3000,
    })
  );
  // ΔCN = -2000, ΔLO = +2000 → move min = 2000 china→local
  check("suggests china→local $2000", d.suggested_movement?.from === "china_cogs" && d.suggested_movement?.cents === 2000, d.suggested_movement);
  check("surplus/shortfall = 0 (totals equal)", d.surplus_shortfall_cents === 0);
}

console.log("4) Same category (CN40 backing → CN40 consumption) → no movement");
{
  const d = deriveCmMovement(
    base({ backing_china_cents: 4000, consumption_china_cents: 4000 })
  );
  check("no suggested movement", d.suggested_movement === null);
  check("needs_attention false (nothing to rebalance)", d.needs_attention === false);
}

console.log("5) Surplus/shortfall surfaced separately, not as inflated transfer");
{
  // backing CN$61.41, consumption LO$138.98 → move = min(6141, 13898) = 6141
  const d = deriveCmMovement(
    base({ backing_china_cents: 6141, consumption_local_cents: 13898 })
  );
  check("movement clamped to min = 6141", d.suggested_movement?.cents === 6141, d.suggested_movement);
  check("shortfall = 6141 - 13898 = -7757", d.surplus_shortfall_cents === -7757, d.surplus_shortfall_cents);
}

console.log("6) Backing status gating");
{
  const unbacked = deriveCmMovement(
    base({ backing_lines_total: 0, backing_lines_costed: 0, consumption_local_cents: 5000 })
  );
  check("unbacked → status unbacked", unbacked.backing_status === "unbacked");
  check("unbacked → no suggestion, hidden", unbacked.suggested_movement === null && unbacked.needs_attention === false);

  const unknown = deriveCmMovement(
    base({ backing_lines_total: 2, backing_lines_costed: 0, consumption_local_cents: 5000 })
  );
  check("unknown → status unknown", unknown.backing_status === "unknown");
  check("unknown + consumption → needs_attention, no auto-suggest", unknown.needs_attention === true && unknown.suggested_movement === null);

  const partial = deriveCmMovement(
    base({ backing_lines_total: 2, backing_lines_costed: 1, backing_china_cents: 2000, consumption_local_cents: 5000 })
  );
  check("partial → status partially_cash_backed", partial.backing_status === "partially_cash_backed");
  check("partial → needs_attention, no auto-suggest", partial.needs_attention === true && partial.suggested_movement === null);
}

console.log("7) Hash determinism + sensitivity");
{
  const a = deriveCmMovement(base({ backing_china_cents: 4000, consumption_local_cents: 4000 }));
  const b = deriveCmMovement(base({ backing_china_cents: 4000, consumption_local_cents: 4000 }));
  const c = deriveCmMovement(base({ backing_china_cents: 4001, consumption_local_cents: 4000 }));
  check("same inputs → same hash", a.derivation_hash === b.derivation_hash);
  check("changed input → different hash", a.derivation_hash !== c.derivation_hash);
  check("hash is 64 hex chars", /^[0-9a-f]{64}$/.test(a.derivation_hash));
}

console.log("8) Movement is a pure transfer (sum-zero on the two buckets)");
{
  const d = deriveCmMovement(
    base({ backing_china_cents: 5000, consumption_local_cents: 5000 })
  );
  // A confirmed movement moves `cents` from one bucket to the other; the net
  // change across china+local is zero by construction. Assert the magnitude
  // never exceeds either side's delta so it can't over-transfer.
  const m = d.suggested_movement!;
  check("movement never exceeds |ΔChina|", m.cents <= Math.abs(0 - 5000));
  check("movement never exceeds |ΔLocal|", m.cents <= Math.abs(5000 - 0));
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log("\nAll credit-memo movement derivation checks passed ✓");
process.exit(0);
