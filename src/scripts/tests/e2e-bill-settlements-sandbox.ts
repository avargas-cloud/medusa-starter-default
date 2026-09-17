/**
 * e2e-bill-settlements-sandbox.ts — plan pay-bills-credits-prepayments-20260917
 *
 * Pay Bills settles a bill with (1) a posted vendor credit, (2) a PREPAYMENT —
 * a posted check line against the vendor's OtherCurrentAsset account, which
 * mints the account-only VendorCredit (Dr AP / Cr prepayment) the accountant
 * used to hand-write in QuickBooks — and (3) new cash, in that order, per
 * vendor, through ONE route: `POST /admin/bill-settlements`.
 *
 * Asserted by EFFECT in the DB (never by the response alone): the credit
 * application, the minted VC + its consumption row, the GL entry of that VC,
 * the bill payment carrying cash only, and the bill's balance moving by
 * exactly what was settled. Negatives: over-consuming a line, a fully
 * consumed (qb_backfill-seeded) line, a bill of another vendor, a closed
 * period, and the partial-failure contract (credit posted, cash refused →
 * `ok:false` with the credit step still reported).
 *
 * Sandbox-only (private clone). QB bridge disabled: the QB lanes are
 * asserted as "queued" pipeline intents, never as QuickBooks results. The
 * backend under test needs `GL_POSTING_ENABLED=true` (the GL assert) and
 * `QB_VENDOR_BILL_MODE=bill` (the queued assert) — both off by default in
 * `./back-sb`.
 *
 *   DATABASE_URL=postgresql://postgres:sandbox@127.0.0.1:5499/medusa_paybills \
 *     E2E_BACKEND_URL=http://localhost:9188 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bill-settlements-sandbox.ts
 */
import { Client } from "pg";

const BACKEND = process.env.E2E_BACKEND_URL ?? "http://localhost:9188";

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
let token = "";
async function api<T = any>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}
async function login(): Promise<void> {
  const res = await fetch(`${BACKEND}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.E2E_EMAIL ?? "sandbox@test.com",
      password: process.env.E2E_PASSWORD ?? "sandbox123",
    }),
  });
  const j = (await res.json()) as { token?: string };
  if (!j.token) throw new Error(`login failed (${res.status})`);
  token = j.token;
}

type Prepayment = {
  gl_check_id: string;
  doc_number: string;
  day: string;
  gl_check_line_id: string;
  account_list_id: string;
  remaining_cents: number | string;
};
type PayableBill = { id: string; number: string | null; balance_cents: number | string };
type PayableVendor = { vendor_id: string; bills: PayableBill[] };

const n = (v: number | string | null | undefined): number => Number(v ?? 0);
const today = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function billBalance(billId: string): Promise<number> {
  const { json } = await api<{ vendors: PayableVendor[] }>("GET", "/admin/accounting/payables");
  for (const v of json.vendors ?? []) {
    const b = v.bills.find((x) => x.id === billId);
    if (b) return n(b.balance_cents);
  }
  return 0;
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await login();
    const runStartedAt = new Date();

    // ── Fixtures: the vendor with prepayments on account + an open credit ──
    const vendor = (
      await db.query<{ vendor_id: string }>(
        `SELECT c.payee_id AS vendor_id
           FROM gl_check c JOIN gl_check_line l ON l.check_id = c.id
           JOIN qb_account a ON a.qb_list_id = l.account_list_id AND a.account_type = 'OtherCurrentAsset'
          WHERE c.status = 'posted' AND c.deleted_at IS NULL AND c.payee_type = 'vendor'
          GROUP BY c.payee_id ORDER BY COUNT(*) DESC LIMIT 1`
      )
    ).rows[0];
    assert(!!vendor, "a vendor with OtherCurrentAsset check lines exists");
    if (!vendor) return;
    const V = vendor.vendor_id;

    const prep = await api<{ prepayments: Prepayment[] }>("GET", `/admin/accounting/payables/prepayments?vendor_id=${V}`);
    assert(prep.status === 200 && Array.isArray(prep.json.prepayments), "GET prepayments answers 200 with a list", `status=${prep.status}`);
    const lines = prep.json.prepayments ?? [];
    assert(lines.length > 0 && lines.every((l) => n(l.remaining_cents) > 0), "every offered line has remaining > 0", `n=${lines.length}`);
    const seededLine = (
      await db.query<{ gl_check_line_id: string }>(
        `SELECT gl_check_line_id FROM vendor_prepayment_consumption WHERE source = 'qb_backfill' AND vendor_id = $1 LIMIT 1`,
        [V]
      )
    ).rows[0];
    assert(
      !!seededLine && !lines.some((l) => l.gl_check_line_id === seededLine.gl_check_line_id),
      "a qb_backfill-seeded (fully consumed) line is NOT offered"
    );
    const missing = await api<{ prepayments: Prepayment[] }>("GET", `/admin/accounting/payables/prepayments?vendor_id=nope`);
    assert(missing.status === 200 && (missing.json.prepayments ?? []).length === 0, "unknown vendor → empty list, no error");

    const openBills = (
      await db.query<{ id: string; number: string }>(
        `SELECT id, number FROM vendor_bill WHERE vendor_id = $1 AND deleted_at IS NULL AND status IN ('confirmed','synced') ORDER BY number LIMIT 6`,
        [V]
      )
    ).rows;
    const balances = await Promise.all(openBills.map(async (b) => ({ ...b, balance: await billBalance(b.id) })));
    const payable = balances.filter((b) => b.balance >= 2000);
    assert(payable.length >= 2, "two open bills with balance ≥ $20 exist for the vendor", balances.map((b) => `${b.number}=${b.balance}`).join(" "));
    if (payable.length < 2) return;
    const [B1, B2] = payable;
    const credit = (
      await db.query<{ id: string; number: string; remaining: string }>(
        `SELECT id, number, (total_cents - applied_cents)::bigint AS remaining FROM vendor_credit
          WHERE vendor_id = $1 AND status = 'posted' AND deleted_at IS NULL AND total_cents - applied_cents >= 1000
          ORDER BY credit_date LIMIT 1`,
        [V]
      )
    ).rows[0];
    assert(!!credit, "a posted vendor credit with remaining ≥ $10 exists");
    if (!credit) return;
    const bank = (await db.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE account_type = 'Bank' AND is_active LIMIT 1`)).rows[0];
    const card = (await db.query<{ qb_list_id: string }>(`SELECT qb_list_id FROM qb_account WHERE account_type = 'CreditCard' AND is_active LIMIT 1`)).rows[0];
    const line = lines.reduce((best, l) => (n(l.remaining_cents) > n(best.remaining_cents) ? l : best), lines[0]);
    const vcBefore = n((await db.query(`SELECT COUNT(*)::int AS c FROM vendor_credit WHERE reason = 'prepayment'`)).rows[0].c);

    // ── A. Prepayment only ───────────────────────────────────────────────
    const amtA = Math.min(1000, B1.balance, n(line.remaining_cents));
    const A = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V,
      settlement_date: today(),
      credit_allocations: [],
      prepayment_allocations: [{ gl_check_line_id: line.gl_check_line_id, vendor_bill_id: B1.id, amount_cents: amtA }],
      cash: null,
    });
    assert(A.status === 201 && A.json.settlement?.ok === true, "[A] prepayment-only settlement answers 201 ok", `status=${A.status} ${JSON.stringify(A.json).slice(0, 200)}`);
    const stepA = A.json.settlement?.steps?.[0];
    assert(stepA?.kind === "prepayment" && /^VC-\d+$/.test(stepA.vendor_credit_number ?? ""), "[A] step is a prepayment with a VC-#### number", stepA?.vendor_credit_number);
    if (stepA?.vendor_credit_id) {
      const vc = (
        await db.query(
          `SELECT vc.status, vc.reason, vc.credit_date::text, vc.total_cents::bigint, vc.applied_cents::bigint,
                  (SELECT COUNT(*)::int FROM vendor_credit_line l WHERE l.credit_id = vc.id AND l.qb_account_list_id = $2) AS asset_lines
             FROM vendor_credit vc WHERE vc.id = $1`,
          [stepA.vendor_credit_id, line.account_list_id]
        )
      ).rows[0] as any;
      assert(vc?.status === "posted" && vc.reason === "prepayment" && n(vc.total_cents) === amtA && n(vc.applied_cents) === amtA && n(vc.asset_lines) === 1,
        "[A] VC posted, reason=prepayment, one line against the check's account, fully applied", JSON.stringify(vc));
      assert(vc?.credit_date === today(), "[A] VC dated on the settlement date, never the check's day", vc?.credit_date);
      const cons = (await db.query(`SELECT consumed_cents::bigint, source, gl_check_line_id FROM vendor_prepayment_consumption WHERE vendor_credit_id = $1`, [stepA.vendor_credit_id])).rows[0] as any;
      assert(cons && n(cons.consumed_cents) === amtA && cons.source === "settlement" && cons.gl_check_line_id === line.gl_check_line_id, "[A] consumption row = amount, source=settlement", JSON.stringify(cons));
      const gl = (
        await db.query(
          `SELECT l.account_snapshot->>'account_type' AS t, l.debit_cents::bigint AS d, l.credit_cents::bigint AS c
             FROM bank_journal_entry e JOIN bank_journal_line l ON l.entry_id = e.id
            WHERE e.source_kind = 'vendor_credit' AND e.source_id = $1 AND e.deleted_at IS NULL AND l.deleted_at IS NULL`,
          [stepA.vendor_credit_id]
        )
      ).rows as Array<{ t: string; d: string; c: string }>;
      const drAp = gl.find((r) => r.t === "AccountsPayable" && n(r.d) === amtA);
      const crAsset = gl.find((r) => r.t === "OtherCurrentAsset" && n(r.c) === amtA);
      assert(!!drAp && !!crAsset, "[A] GL: Dr Accounts Payable / Cr prepayment asset for the amount", JSON.stringify(gl));
      assert(stepA.qb_add?.queued === true, "[A] VendorCreditAdd queued for QB", JSON.stringify(stepA.qb_add));
      const app = (await db.query(`SELECT amount_cents::bigint FROM vendor_credit_application WHERE id = $1 AND voided_at IS NULL`, [stepA.application_id])).rows[0] as any;
      assert(n(app?.amount_cents) === amtA, "[A] credit application row exists for the amount");
    }
    assert((await billBalance(B1.id)) === B1.balance - amtA, "[A] bill balance dropped by exactly the prepayment", `${B1.number}`);
    const prepAfter = await api<{ prepayments: Prepayment[] }>("GET", `/admin/accounting/payables/prepayments?vendor_id=${V}`);
    const lineAfter = (prepAfter.json.prepayments ?? []).find((l) => l.gl_check_line_id === line.gl_check_line_id);
    assert(n(lineAfter?.remaining_cents ?? 0) === n(line.remaining_cents) - amtA, "[A] the line's remaining dropped by the amount (or the line left the list at 0)");

    // ── A2. Delta v2: voiding the prepayment credit releases the line ────
    if (stepA?.vendor_credit_id && stepA?.application_id) {
      // The bridge is off here, so the $0+SetCredit link never confirms and
      // the un-apply guard would wait forever: stage the same state QB
      // refusing the link would leave — a `failed` pipeline row.
      await db.query(
        `UPDATE qb_order_pipeline SET status = 'failed', error = 'e2e: simulated QB refusal' WHERE step = 'vendor_credit_apply' AND reference_id = $1`,
        [stepA.application_id]
      );
      const unapply = await api<any>("POST", `/admin/vendor-credits/${stepA.vendor_credit_id}/applications/${stepA.application_id}/void`, { reason: "e2e" });
      const voidRes = unapply.status < 300
        ? await api<any>("POST", `/admin/vendor-credits/${stepA.vendor_credit_id}/void`, { reason: "e2e: wrong bill" })
        : unapply;
      assert(voidRes.status < 300, "[A2] the prepayment credit can be un-applied and voided", `${unapply.status}/${voidRes.status} ${JSON.stringify(voidRes.json).slice(0, 120)}`);
      const cons = (await db.query(`SELECT voided_at FROM vendor_prepayment_consumption WHERE vendor_credit_id = $1`, [stepA.vendor_credit_id])).rows[0] as any;
      assert(!!cons?.voided_at, "[A2] its consumption row is voided");
      const back = (await api<{ prepayments: Prepayment[] }>("GET", `/admin/accounting/payables/prepayments?vendor_id=${V}`)).json.prepayments ?? [];
      const lineBack = back.find((l) => l.gl_check_line_id === line.gl_check_line_id);
      assert(n(lineBack?.remaining_cents ?? 0) === n(line.remaining_cents), "[A2] the check line recovered its full remaining", `${lineBack?.remaining_cents} vs ${line.remaining_cents}`);
    }

    // ── B. Credit + cash on one bill ────────────────────────────────────
    const amtCredit = Math.min(500, Math.floor(B2.balance / 2), n(credit.remaining));
    const amtCash = Math.min(500, B2.balance - amtCredit);
    const B = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V,
      settlement_date: today(),
      credit_allocations: [{ credit_id: credit.id, vendor_bill_id: B2.id, amount_cents: amtCredit }],
      prepayment_allocations: [],
      cash: { bank_account_list_id: bank.qb_list_id, method: "check", reference: "e2e-settle", memo: "e2e", allocations: [{ vendor_bill_id: B2.id, amount_cents: amtCash }] },
    });
    assert(B.status === 201 && B.json.settlement?.ok === true, "[B] credit+cash settlement answers 201 ok", `status=${B.status} ${JSON.stringify(B.json).slice(0, 200)}`);
    const kinds = (B.json.settlement?.steps ?? []).map((s: any) => s.kind);
    assert(JSON.stringify(kinds) === JSON.stringify(["credit", "cash"]), "[B] steps run credit → cash", kinds.join(","));
    const cashStep = B.json.settlement?.steps?.find((s: any) => s.kind === "cash");
    if (cashStep) {
      const bp = (await db.query(`SELECT amount_cents::bigint AS a, (SELECT COUNT(*)::int FROM vendor_bill_payment_allocation x WHERE x.payment_id = p.id AND x.credit_application_id IS NOT NULL) AS with_credit FROM vendor_bill_payment p WHERE p.id = $1`, [cashStep.bill_payment_id])).rows[0] as any;
      assert(n(bp?.a) === amtCash && n(bp?.with_credit) === 0, "[B] bill payment carries CASH only, no credit allocation", JSON.stringify(bp));
    }
    assert((await billBalance(B2.id)) === B2.balance - amtCredit - amtCash, "[B] bill balance dropped by credit + cash");

    // ── C. Negatives ────────────────────────────────────────────────────
    const lineNow = (await api<{ prepayments: Prepayment[] }>("GET", `/admin/accounting/payables/prepayments?vendor_id=${V}`)).json.prepayments ?? [];
    const small = lineNow.reduce((best, l) => (n(l.remaining_cents) < n(best.remaining_cents) ? l : best), lineNow[0]);
    const over = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V, settlement_date: today(), credit_allocations: [],
      prepayment_allocations: [{ gl_check_line_id: small.gl_check_line_id, vendor_bill_id: B1.id, amount_cents: n(small.remaining_cents) + 1 }], cash: null,
    });
    assert(over.status === 409 && over.json.code === "prepayment_exceeds_remaining", "[C1] over-consuming a line → 409 prepayment_exceeds_remaining", `${over.status} ${over.json.code}`);
    const seeded = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V, settlement_date: today(), credit_allocations: [],
      prepayment_allocations: [{ gl_check_line_id: seededLine!.gl_check_line_id, vendor_bill_id: B1.id, amount_cents: 1 }], cash: null,
    });
    assert(seeded.status === 409 && seeded.json.code === "prepayment_exceeds_remaining", "[C2] a qb_backfill-consumed line cannot be consumed again", `${seeded.status} ${seeded.json.code}`);
    const other = (await db.query<{ id: string }>(`SELECT id FROM vendor_bill WHERE vendor_id <> $1 AND deleted_at IS NULL AND status IN ('confirmed','synced') LIMIT 1`, [V])).rows[0];
    const cross = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V, settlement_date: today(), credit_allocations: [],
      prepayment_allocations: [{ gl_check_line_id: line.gl_check_line_id, vendor_bill_id: other.id, amount_cents: 1 }], cash: null,
    });
    assert(cross.status === 404 && cross.json.code === "prepayment_bill_not_found", "[C3] a bill of another vendor → 404", `${cross.status} ${cross.json.code}`);
    const vcAfterNeg = n((await db.query(`SELECT COUNT(*)::int AS c FROM vendor_credit WHERE reason = 'prepayment'`)).rows[0].c);
    assert(vcAfterNeg === vcBefore + 1, "[C] negatives minted no vendor credit (only A did)", `${vcBefore} → ${vcAfterNeg}`);

    // Closed period: seed a closed month far in the past on this private clone.
    await db.query(
      `INSERT INTO accounting_period_close (id, period_start, period_end, revision, status, summary, open_documents, readiness, inventory_snapshots, closed_by_user_id, closed_at)
       VALUES ('apc_e2e_settle', '2024-01-01', '2024-02-01', 1, 'closed', '{}', '[]', '{}', '[]', 'e2e', now()) ON CONFLICT (id) DO NOTHING`
    );
    const closed = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V, settlement_date: "2024-01-15", credit_allocations: [],
      prepayment_allocations: [{ gl_check_line_id: line.gl_check_line_id, vendor_bill_id: B1.id, amount_cents: 1 }], cash: null,
    });
    await db.query(`DELETE FROM accounting_period_close WHERE id = 'apc_e2e_settle'`);
    assert(closed.status === 423, "[C4] settlement dated in a closed period → 423", `${closed.status} ${JSON.stringify(closed.json).slice(0, 160)}`);
    const orphan = (await db.query(`SELECT COUNT(*)::int AS c FROM vendor_credit vc WHERE vc.reason = 'prepayment' AND vc.status = 'draft' AND vc.created_at >= $1`, [runStartedAt])).rows[0] as any;
    assert(n(orphan.c) === 0, "[C4] the refused settlement left no draft prepayment credit behind");

    // ── D. Partial failure contract: credit posts, cash refused ─────────
    const B1now = await billBalance(B1.id);
    const amtD = Math.min(300, Math.floor(B1now / 2), n(credit.remaining) - amtCredit);
    const appsBefore = n((await db.query(`SELECT COUNT(*)::int AS c FROM vendor_credit_application WHERE credit_id = $1 AND voided_at IS NULL`, [credit.id])).rows[0].c);
    const D = await api<any>("POST", "/admin/bill-settlements", {
      vendor_id: V, settlement_date: today(),
      credit_allocations: [{ credit_id: credit.id, vendor_bill_id: B1.id, amount_cents: amtD }],
      prepayment_allocations: [],
      cash: { bank_account_list_id: card.qb_list_id, method: "check", allocations: [{ vendor_bill_id: B1.id, amount_cents: 100 }] },
    });
    const appsAfter = n((await db.query(`SELECT COUNT(*)::int AS c FROM vendor_credit_application WHERE credit_id = $1 AND voided_at IS NULL`, [credit.id])).rows[0].c);
    assert(D.status >= 400 && D.json.settlement?.ok === false && D.json.settlement?.failed?.kind === "cash", "[D] cash refused (card account with method=check) → ok:false, failed.kind=cash", `${D.status} ${D.json.code}`);
    assert(D.json.settlement?.steps?.length === 1 && D.json.settlement.steps[0].kind === "credit" && appsAfter === appsBefore + 1, "[D] the credit step BEFORE the failure stays posted and is reported");
    assert((await billBalance(B1.id)) === B1now - amtD, "[D] bill balance reflects only the credit");
  } finally {
    await db.end();
  }
  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
