/**
 * Verifies B2 fix: vendor poller now uses STANDARD_BACKOFF_MINUTES = [2,4,10,30,60]
 * and the shared computeNextRetryDate helper produces correct timestamps.
 *
 * Run: yarn dev (in another terminal) or just: tsx src/scripts/verify/verify-retry-config.ts
 */
import {
  STANDARD_BACKOFF_MINUTES,
  MAX_RETRIES,
  computeNextRetryDate,
  isRetryExhausted,
} from "../../lib/quickbooks/retry-config";

function assert(cond: boolean, label: string) {
  if (!cond) {
    console.error(`❌ ${label}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}

console.log("Schedule:", STANDARD_BACKOFF_MINUTES);

assert(
  STANDARD_BACKOFF_MINUTES.length === 5,
  `STANDARD_BACKOFF_MINUTES has 5 entries (got ${STANDARD_BACKOFF_MINUTES.length})`
);
assert(
  JSON.stringify(STANDARD_BACKOFF_MINUTES) === "[2,4,10,30,60]",
  "STANDARD_BACKOFF_MINUTES = [2,4,10,30,60]"
);
assert(MAX_RETRIES === 5, `MAX_RETRIES === 5 (got ${MAX_RETRIES})`);

const t0 = Date.now();
const r0 = computeNextRetryDate(0);
const r1 = computeNextRetryDate(1);
const r2 = computeNextRetryDate(2);
const r3 = computeNextRetryDate(3);
const r4 = computeNextRetryDate(4);
const r10 = computeNextRetryDate(10); // beyond schedule, should cap

assert(
  Math.abs(r0.getTime() - t0 - 2 * 60_000) < 1000,
  "retry 0 → +2 min"
);
assert(
  Math.abs(r1.getTime() - t0 - 4 * 60_000) < 1000,
  "retry 1 → +4 min"
);
assert(
  Math.abs(r2.getTime() - t0 - 10 * 60_000) < 1000,
  "retry 2 → +10 min"
);
assert(
  Math.abs(r3.getTime() - t0 - 30 * 60_000) < 1000,
  "retry 3 → +30 min"
);
assert(
  Math.abs(r4.getTime() - t0 - 60 * 60_000) < 1000,
  "retry 4 → +60 min"
);
assert(
  Math.abs(r10.getTime() - t0 - 60 * 60_000) < 1000,
  "retry 10 → caps at 60 min"
);

assert(!isRetryExhausted(0), "isRetryExhausted(0) === false");
assert(!isRetryExhausted(4), "isRetryExhausted(4) === false");
assert(isRetryExhausted(5), "isRetryExhausted(5) === true (== max)");
assert(isRetryExhausted(10), "isRetryExhausted(10) === true");

console.log("\n🎉 B2 verification PASSED — Vendor backoff unified to standard.");
