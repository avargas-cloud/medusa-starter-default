/**
 * src/scripts/tests/e2e-vendor-terms-sandbox.mjs
 *
 * E2E for the vendor payment-terms consolidation, over real HTTP against the
 * SANDBOX (backend :9099). Never point this at production — it PATCHes a real
 * vendor's payment term.
 *
 * The QB bridge is OFF in sandbox, and that is used as a test rather than
 * worked around: creating a term must refuse to write locally when QuickBooks
 * cannot confirm it, because a term QB lacks breaks every vendor assigned to it.
 *
 * Idempotent — it resets the vendor's term before exercising the change, so it
 * passes on the second run too. An E2E that only passes the first time is an
 * E2E that stops being run.
 *
 * Usage:
 *   VENDOR_ID=qbvnd_... node src/scripts/tests/e2e-vendor-terms-sandbox.mjs
 *
 * Prereq: seed-vendor-terms-catalog.ts has populated the catalog in sandbox.
 */
const BASE = "http://localhost:9099";
const VENDOR_ID = process.env.VENDOR_ID;
let pass = 0, fail = 0;

const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
};

const login = async () => {
  const r = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  return (await r.json()).token;
};

const api = async (token, path, opts = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

const main = async () => {
  const token = await login();

  console.log("\n1. Catalog");
  const cat = await api(token, "/admin/vendor-terms");
  ok("GET /admin/vendor-terms responds 200", cat.status === 200, `got ${cat.status}`);
  ok("20 terms seeded (19 derived + Net-21)", cat.body.counts?.total === 20, `got ${cat.body.counts?.total}`);
  ok("no broken rows", cat.body.counts?.rejected === 0);
  const dateDriven = cat.body.terms.filter((t) => t.day_of_month_due != null);
  ok("both date-driven terms are present", dateDriven.length === 2,
     dateDriven.map((t) => `${t.name}=day ${t.day_of_month_due}`).join(", "));
  const net30 = cat.body.terms.find((t) => t.name === "Net-30");
  const spaced = cat.body.terms.find((t) => t.name === "Net 30");
  ok("Net-30 and Net 30 are kept as DISTINCT terms", Boolean(net30 && spaced));
  ok("Net-30 resolves to 30 days, not the outlier 21", net30?.days === 30, String(net30?.days));

  console.log("\n2. qb_only narrows to what a VendorMod can safely reference");
  const qbOnly = await api(token, "/admin/vendor-terms?qb_only=true");
  ok("qb_only=true returns only terms QuickBooks has",
     qbOnly.body.terms.every((t) => t.exists_in_qb === true));
  console.log(`    (seeded from vendors, so exists_in_qb=false on all ${cat.body.counts.total} → ${qbOnly.body.terms.length} returned)`);

  // Reset so the run is repeatable. An E2E that only passes the first time is
  // an E2E that stops being run.
  await api(token, `/admin/qb-catalog/vendors/${VENDOR_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      terms_ref_name: "Net-30",
      metadata: { payment_terms: "Net-30", default_payment_terms_days: 30 },
    }),
  });

  console.log("\n3. Changing a vendor's term");
  const before = await api(token, `/admin/qb-catalog/vendors/${VENDOR_ID}`);
  const beforeTerm = before.body.vendor?.terms_ref_name ?? before.body.terms_ref_name;
  console.log(`    vendor starts on "${beforeTerm}"`);

  const target = cat.body.terms.find((t) => t.name === "Net-60");
  const patch = await api(token, `/admin/qb-catalog/vendors/${VENDOR_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      terms_ref_name: target.name,
      metadata: {
        payment_terms: target.name,
        default_payment_terms_days: target.days,
        default_payment_terms_day_of_month: target.day_of_month_due,
      },
    }),
  });
  ok("PATCH accepted", patch.status === 200, JSON.stringify(patch.body).slice(0, 160));
  ok("the response says a QuickBooks push was queued", patch.body.qb_push?.queued === true,
     JSON.stringify(patch.body.qb_push));
  ok("it reports the term as what changed", patch.body.qb_push?.term_changed === true);
  ok("terms_ref_name is among the changed fields",
     (patch.body.qb_push?.changed ?? []).includes("terms_ref_name"));

  console.log("\n4. All three fields moved together — the whole point");
  const after = await api(token, `/admin/qb-catalog/vendors/${VENDOR_ID}`);
  const v = after.body.vendor ?? after.body;
  ok("terms_ref_name updated", v.terms_ref_name === "Net-60", v.terms_ref_name);
  ok("metadata.payment_terms matches the name", v.metadata?.payment_terms === "Net-60",
     String(v.metadata?.payment_terms));
  ok("metadata.default_payment_terms_days matches the rule",
     Number(v.metadata?.default_payment_terms_days) === 60,
     String(v.metadata?.default_payment_terms_days));

  console.log("\n5. Re-saving the SAME term must NOT push again");
  const resave = await api(token, `/admin/qb-catalog/vendors/${VENDOR_ID}`, {
    method: "PATCH",
    body: JSON.stringify({ terms_ref_name: "Net-60" }),
  });
  ok("no push queued on a no-op save", resave.body.qb_push?.queued === false,
     JSON.stringify(resave.body.qb_push));
  ok("reason is no_qb_relevant_change",
     resave.body.qb_push?.reason === "no_qb_relevant_change",
     String(resave.body.qb_push?.reason));

  console.log("\n6. Creating a term with QuickBooks unreachable");
  const created = await api(token, "/admin/vendor-terms", {
    method: "POST",
    body: JSON.stringify({ name: "E2E-Net-45", days: 45 }),
  });
  ok("refuses to create locally when QuickBooks cannot CONFIRM (502)",
     created.status === 502, `got ${created.status}: ${JSON.stringify(created.body).slice(0, 140)}`);
  const recheck = await api(token, "/admin/vendor-terms");
  ok("and nothing was written locally", recheck.body.counts.total === 20,
     `total is now ${recheck.body.counts.total}`);

  console.log("\n7. Validation");
  const bothRules = await api(token, "/admin/vendor-terms", {
    method: "POST",
    body: JSON.stringify({ name: "E2E-Bad", days: 30, day_of_month_due: 20 }),
  });
  ok("a term with BOTH rules is rejected 400", bothRules.status === 400);
  const noRule = await api(token, "/admin/vendor-terms", {
    method: "POST",
    body: JSON.stringify({ name: "E2E-Bad2" }),
  });
  ok("a term with NO rule is rejected 400", noRule.status === 400);
  const dup = await api(token, "/admin/vendor-terms", {
    method: "POST",
    body: JSON.stringify({ name: "net-30", days: 30 }),
  });
  ok("a duplicate name is rejected 409, not silently updated", dup.status === 409,
     `got ${dup.status}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
