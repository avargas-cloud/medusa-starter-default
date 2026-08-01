/**
 * src/scripts/tests/e2e-vendor-terms-bill-sandbox.mjs
 *
 * The half the other E2E does not reach: a VENDOR BILL remembering which term
 * it was written under, and the Purchasing metadata save path.
 *
 * Why this exists separately: `payment_terms_days` alone cannot round-trip a
 * selection, because two terms can share a day count ("Due on Receipt" and
 * "Prepaid" are both 0; "Net 30" and "Net-30" are both 30 and are DISTINCT
 * terms in the company file). If the name does not persist, reopening a bill
 * shows "— None —" and the next save writes that absence as fact.
 *
 * SANDBOX ONLY (:9099) — it PATCHes a real bill and a real vendor.
 *
 * Usage: node src/scripts/tests/e2e-vendor-terms-bill-sandbox.mjs
 */
const BASE = "http://localhost:9099";
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

  console.log("\n1. A bill carries the term it was written under");
  const list = await api(token, "/admin/vendor-bills?limit=200");
  const bills = list.body.vendor_bills ?? list.body.bills ?? [];
  ok("the bill list responds", list.status === 200, `got ${list.status}`);

  // A draft bill is the only kind safe to PATCH; confirmed ones have posted costs.
  const draft = bills.find((b) => b.status === "draft");
  if (!draft) {
    console.log("    no draft bill available — cannot exercise the write path");
    ok("a draft bill exists to test with", false);
  } else {
    const detail = await api(token, `/admin/vendor-bills/${draft.id}`);
    const d = detail.body.vendor_bill ?? detail.body;
    console.log(`    using ${d.number ?? d.id} (${d.vendor_name ?? "?"})`);
    ok("the detail route returns payment_terms_name",
       "payment_terms_name" in d, Object.keys(d).filter(k => k.includes("term")).join(","));

    const terms = (await api(token, "/admin/vendor-terms")).body.terms;
    // Net 30 vs Net-30: same day count, different terms. Exactly the pair the
    // day count alone cannot tell apart.
    const spaced = terms.find((t) => t.name === "Net 30");
    const dashed = terms.find((t) => t.name === "Net-30");
    ok("the catalog has both 30-day spellings", Boolean(spaced && dashed));

    const before = { name: d.payment_terms_name, days: d.payment_terms_days };
    const patched = await api(token, `/admin/vendor-bills/${draft.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        payment_terms_name: spaced.name,
        payment_terms_days: spaced.days,
      }),
    });
    ok("saving a term is accepted", patched.status === 200,
       `got ${patched.status}: ${JSON.stringify(patched.body).slice(0, 140)}`);

    const after = await api(token, `/admin/vendor-bills/${draft.id}`);
    const a = after.body.vendor_bill ?? after.body;
    ok('the NAME survived the round trip ("Net 30", not "Net-30")',
       a.payment_terms_name === "Net 30", String(a.payment_terms_name));
    ok("the day count came back too", Number(a.payment_terms_days) === 30,
       String(a.payment_terms_days));

    // Restore whatever it had, so this is re-runnable.
    await api(token, `/admin/vendor-bills/${draft.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        payment_terms_name: before.name,
        payment_terms_days: before.days,
      }),
    });
    const restored = await api(token, `/admin/vendor-bills/${draft.id}`);
    ok("the bill was restored to its original term",
       (restored.body.vendor_bill ?? restored.body).payment_terms_name === before.name);
  }

  console.log("\n2. Purchasing metadata saves through the shared vendor PATCH");
  // This path changed when Purchasing moved from its own mutation into the
  // section modal. It is also the PATCH that decides whether to push to QB —
  // so a purchasing-only edit must NOT trigger a VendorMod.
  const VID = process.env.VENDOR_ID ?? "qbvnd_01KPGGQFQR998YTW3SG8FZDJFN";
  const v0 = (await api(token, `/admin/qb-catalog/vendors/${VID}`)).body;
  const vendor0 = v0.vendor ?? v0;
  const origDays = vendor0.metadata?.production_days ?? null;

  const purch = await api(token, `/admin/qb-catalog/vendors/${VID}`, {
    method: "PATCH",
    body: JSON.stringify({ metadata: { production_days: 42 } }),
  });
  ok("purchasing metadata PATCH accepted", purch.status === 200);
  ok("a purchasing-only edit does NOT push to QuickBooks",
     purch.body.qb_push?.queued === false, JSON.stringify(purch.body.qb_push));
  ok("reason is no_qb_relevant_change",
     purch.body.qb_push?.reason === "no_qb_relevant_change");

  const v1 = (await api(token, `/admin/qb-catalog/vendors/${VID}`)).body;
  ok("production_days persisted",
     Number((v1.vendor ?? v1).metadata?.production_days) === 42);

  // The deep-merge must not have eaten the payment term sitting beside it.
  ok("the payment term survived a metadata-only save",
     (v1.vendor ?? v1).metadata?.payment_terms === vendor0.metadata?.payment_terms,
     `${vendor0.metadata?.payment_terms} → ${(v1.vendor ?? v1).metadata?.payment_terms}`);

  await api(token, `/admin/qb-catalog/vendors/${VID}`, {
    method: "PATCH",
    body: JSON.stringify({ metadata: { production_days: origDays } }),
  });

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
};

main().catch((e) => { console.error(e); process.exitCode = 1; });
