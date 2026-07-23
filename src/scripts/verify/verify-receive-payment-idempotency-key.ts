/**
 * scripts/verify/verify-receive-payment-idempotency-key.ts
 *
 * Proves the Idempotency-Key wiring on the ReceivePayment ADD path, without
 * touching QuickBooks: stands up a throwaway local HTTP server, points
 * QB_BRIDGE_URL at it, and inspects the headers receivePaymentInQb actually
 * sends.
 *
 * Why this matters: ReceivePaymentAdd is an ADD. Without a key, a retry after
 * a lost bridge response mints a DUPLICATE ReceivePayment in QB. With a key,
 * the bridge returns the existing op instead. The key is opt-in per caller
 * because a key that is NOT 1:1 with the intended document is worse than none
 * — the bridge would swallow a second, legitimately distinct payment.
 *
 * Asserts:
 *   1. No key passed  → NO Idempotency-Key header (unchanged legacy behavior).
 *   2. Key passed     → Idempotency-Key header carries it verbatim.
 *   3. The POS convention `payment:<cpay_id>` survives the round trip.
 *
 * Read-only w.r.t. every database and QuickBooks. Exits 1 on any failure.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-receive-payment-idempotency-key.ts
 */

import * as http from "http";
import type { AddressInfo } from "net";

async function main() {
  const seen: { path: string; idempotencyKey: string | undefined }[] = [];

  const server = http.createServer((req, res) => {
    seen.push({
      path: req.url ?? "",
      idempotencyKey: req.headers["idempotency-key"] as string | undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ operationId: `op_${seen.length}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // Must be set BEFORE the client module is imported — core.ts reads
  // QB_BRIDGE_URL at module-eval time.
  process.env.QB_BRIDGE_URL = `http://127.0.0.1:${port}`;
  process.env.QB_DRY_RUN = "false";

  const { receivePaymentInQb } = await import("../../lib/quickbooks/client/payments");

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failures++;
  };

  try {
    const basePayload = {
      customerId: "80000001-1234567890",
      amount: 123.45,
      memo: "verify-idempotency",
    };

    // ── 1. No key ────────────────────────────────────────────────────────────
    const r1 = await receivePaymentInQb(basePayload);
    check(
      "Check 1: no key passed → no Idempotency-Key header",
      r1.success === true && seen[0]?.idempotencyKey === undefined,
      `success=${r1.success} header=${JSON.stringify(seen[0]?.idempotencyKey)}`
    );

    // ── 2 & 3. Key passed, POS convention ────────────────────────────────────
    const CPAY = "cpay_01KY82V5R541124TQ6D7HXWNKG";
    const KEY = `payment:${CPAY}`;
    const r2 = await receivePaymentInQb(basePayload, { idempotencyKey: KEY });
    check(
      "Check 2: key passed → Idempotency-Key header sent",
      r2.success === true && seen[1]?.idempotencyKey !== undefined,
      `success=${r2.success} header=${JSON.stringify(seen[1]?.idempotencyKey)}`
    );
    check(
      "Check 3: key arrives verbatim as `payment:<cpay_id>`",
      seen[1]?.idempotencyKey === KEY,
      `expected=${KEY} got=${JSON.stringify(seen[1]?.idempotencyKey)}`
    );

    // ── 4. Same payment retried → same key (dedupe would catch it) ───────────
    await receivePaymentInQb(basePayload, { idempotencyKey: KEY });
    check(
      "Check 4: a retry of the same payment re-sends the SAME key",
      seen[2]?.idempotencyKey === seen[1]?.idempotencyKey,
      `first=${seen[1]?.idempotencyKey} retry=${seen[2]?.idempotencyKey}`
    );

    // ── 5. A different payment → a different key (no false dedupe) ───────────
    const OTHER = "payment:cpay_01OTHERPAYMENTID000000000";
    await receivePaymentInQb(basePayload, { idempotencyKey: OTHER });
    check(
      "Check 5: a distinct payment sends a DISTINCT key (no false dedupe)",
      seen[3]?.idempotencyKey === OTHER &&
        seen[3]?.idempotencyKey !== seen[1]?.idempotencyKey,
      `p1=${seen[1]?.idempotencyKey} p2=${seen[3]?.idempotencyKey}`
    );

    console.log(
      failures === 0
        ? "\n✅ ALL CHECKS PASSED — Idempotency-Key wiring is correct."
        : `\n❌ ${failures} CHECK(S) FAILED.`
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
