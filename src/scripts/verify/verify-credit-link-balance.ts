/**
 * verify-credit-link-balance.ts
 *
 * Verifies the target-aware balance endpoint (Phase 1 of the Link/Unlink credit
 * feature). Invokes the REAL route handler with a mock req/res against live data
 * and asserts that a credit FULLY applied to a target invoice — which the legacy
 * logic dropped (remaining_amount = 0) — is now returned with its
 * target_application_id so it can be unlinked.
 *
 * Run (explicit env per workspace policy):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-credit-link-balance.ts \
 *     <customer_id> <invoice_id> [expected_application_id]
 */
import { GET } from "../../api/admin/finance/customers/[id]/balance/route";

export default async function ({ container, args }: any) {
  const [customerId, invoiceId, expectedAppId] = args as string[];
  if (!customerId || !invoiceId) {
    console.error(
      "Usage: medusa exec verify-credit-link-balance.ts <customer_id> <invoice_id> [expected_application_id]"
    );
    process.exit(1);
  }

  // --- Mock req/res capturing the handler's response ---
  let captured: { status: number; body: any } = { status: 200, body: null };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  };

  // 1) Legacy mode (no target params) — baseline.
  const legacyReq: any = {
    params: { id: customerId },
    query: {},
    scope: container,
  };
  await GET(legacyReq, res);
  const legacy = captured.body;
  const legacyHasCredit = (legacy?.details?.available_credits ?? []).some(
    (c: any) => (c.applications ?? []).some((a: any) => a.invoice_id === invoiceId)
  );

  // 2) Target-aware mode (?invoice_id=...).
  captured = { status: 200, body: null };
  const targetReq: any = {
    params: { id: customerId },
    query: { invoice_id: invoiceId },
    scope: container,
  };
  await GET(targetReq, res);
  if (captured.status !== 200) {
    console.error(`❌ Handler returned status ${captured.status}:`, captured.body);
    process.exit(1);
  }
  const credits = captured.body?.details?.available_credits ?? [];
  const linked = credits.find((c: any) => c.target_application_id);

  console.log("\n=== Target-aware balance verification ===");
  console.log(`customer=${customerId} invoice=${invoiceId}`);
  console.log(`legacy mode surfaced the linked credit: ${legacyHasCredit}`);
  console.log(`target mode credits returned: ${credits.length}`);

  if (!linked) {
    console.error(
      "❌ FAIL: no credit with a target_application_id was returned in target mode."
    );
    process.exit(1);
  }

  console.log("\n✅ Linked credit surfaced:");
  console.log({
    id: linked.id,
    method: linked.method,
    status: linked.status,
    remaining_amount: linked.remaining_amount,
    target_application_id: linked.target_application_id,
    target_application_ids: linked.target_application_ids,
    target_linked_amount_cents: linked.target_linked_amount_cents,
    target_relation: linked.target_relation,
    invoice_spendable_cents: linked.invoice_spendable_cents,
    order_reservable_cents: linked.order_reservable_cents,
    source: linked.source,
  });

  const checks: Array<[string, boolean]> = [
    ["target_relation === 'invoice'", linked.target_relation === "invoice"],
    ["target_application_id present", !!linked.target_application_id],
    ["target_linked_amount_cents > 0", linked.target_linked_amount_cents > 0],
  ];
  if (expectedAppId) {
    checks.push([
      `target_application_id === ${expectedAppId}`,
      linked.target_application_ids?.includes(expectedAppId),
    ]);
  }

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "✅" : "❌"} ${label}`);
    if (!pass) ok = false;
  }

  if (!ok) {
    console.error("\n❌ One or more assertions failed.");
    process.exit(1);
  }
  console.log("\n✅ PASS — Bug #1 fixed: consumed-but-linked credit is unlinkable.");
}
