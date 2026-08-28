/**
 * verify-supply-chain-cohort — the "ordered this month" sub-lines under
 * Received and In Transit on all three arrows of reports/purchases/supply-chain.
 *
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-supply-chain-cohort.ts
 *
 * Read-only. Exits 1 if any check fails.
 *
 * WHAT THE SUB-LINE IS FOR
 * The three stacked figures answer three different questions and the pill made
 * them look like one subtraction. August 2026, China → Miami: Created
 * $28,480.81, Received $27,975.07, In Transit $9,191.23 — the owner read that
 * as "$500 left to arrive, so where do the $9,191 come from?" (2026-08-27).
 * Nothing was wrong: Received counts ARRIVALS regardless of when the goods were
 * ordered, and that month it carried $8,685.49 of merchandise ordered in July.
 * The cohort slice is the missing half — scoped to POs placed in the period,
 * Created decomposes exactly:
 *
 *     received_cohort $19,289.58 + in_transit_cohort $9,191.23 = $28,480.81
 *
 * WHY IT CALLS THE ROUTE'S OWN FUNCTIONS
 * Same reason as verify-supply-chain-commission: a second copy of the same SQL
 * moves with a mutation and stays green. The bite comes from the OTHER side —
 * check 1's totals were measured by hand against production on 2026-08-27,
 * with a differently-shaped query, BEFORE the cohort code existed.
 *
 * WHAT EACH CHECK DEFENDS
 * 1 — the cohort amounts on two CLOSED months, both lanes. August is absent on
 *     purpose: it is still accruing and would fail on its own the next time a
 *     container lands.
 * 2 — the predicate is actually APPLIED. Cohort must never exceed the total,
 *     and must be strictly LESS in at least one month — the failure mode of a
 *     dropped/always-true `in_cohort` is that the two legs come out equal, and
 *     equal is exactly what a subset check alone would happily accept.
 * 3 — the decomposition closes for the live month on the China lane, where
 *     Created, Received and In Transit are all on the same landed basis. Any
 *     residual is reported to the cent, so a real change (a cohort PO cancelled
 *     or closed without being received) is named rather than absorbed.
 *
 * 4 — In Transit's headline stays period-INDEPENDENT: passing a cohort must
 *     add a leg, never narrow the live figure it has always shown.
 * 5 — a negative control for the In Transit predicate, which checks 3 and 4
 *     cannot reach: on 2026-08-27 every open PO happened to be placed in the
 *     running month, so cohort and total coincided and an always-true predicate
 *     read as correct (verified by mutation — it passed). A window that cannot
 *     contain an open PO closes that hole regardless of how the data drifts.
 *
 * 6 — the Factories → China arrow, whose two queries are a separate code path
 *     that this change also had to touch (the received query grew a join to the
 *     FO header). Without it, both would ship having never run with bindings.
 *
 * DELIBERATELY NOT CHECKED: the same identity on the LOCAL VENDOR lane. Created
 * there uses `pol.total_cents` while Received uses `average_cost`, so the two
 * sides are on different cost bases and differ by ~$30 in August — real, and
 * documented on the pill itself. Asserting it would force someone to "fix" a
 * valuation difference by breaking one of the two figures.
 */

import {
  fetchPoSpend,
  fetchPeriodReceivedSplit,
  fetchCurrentPoOutstanding,
  fetchFactoryOrderSpend,
  fetchFactoryOrderReceived,
  fetchCurrentFoOutstanding,
} from "../../api/admin/reports/purchases/supply-chain/route";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/**
 * Measured against production on 2026-08-27 with a hand-written query grouped
 * by month — not by the code under test. Cents.
 */
const FIXTURES: Array<{
  month: string;
  from: string;
  to: string;
  agentTotal: number;
  agentCohort: number;
  localTotal: number;
  localCohort: number;
}> = [
  {
    month: "2026-06",
    from: "2026-06-01T00:00:00Z",
    to: "2026-07-01T00:00:00Z",
    agentTotal: 3607421,
    agentCohort: 2108300,
    localTotal: 2016142,
    localCohort: 1422315,
  },
  {
    month: "2026-07",
    from: "2026-07-01T00:00:00Z",
    to: "2026-08-01T00:00:00Z",
    agentTotal: 3885130,
    agentCohort: 1537567,
    localTotal: 3038249,
    localCohort: 2690569,
  },
];

/** The month that is running right now — the only one with a live In Transit. */
function currentMonthRange(): { from: string; to: string; label: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (n: number) => String(n + 1).padStart(2, "0");
  return {
    from: new Date(Date.UTC(y, m, 1)).toISOString(),
    to: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
    label: `${y}-${pad(m)}`,
  };
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function ({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const db = container.resolve("__pg_connection__") as Knex;
  const out = (s: string) => process.stdout.write(s);
  let failed = 0;

  const ok = (msg: string) => out(`  PASS  ${msg}\n`);
  const bad = (msg: string) => {
    failed++;
    out(`  FAIL  ${msg}\n`);
  };

  out("\nverify-supply-chain-cohort\n\n");

  // ── 1 · cohort amounts on closed months, measured by hand beforehand ──────
  out("1 · cohort receipts on closed months (hand-measured 2026-08-27)\n");
  for (const f of FIXTURES) {
    const r = await fetchPeriodReceivedSplit(db, f.from, f.to);
    const cases: Array<[string, number, number]> = [
      [`${f.month} agent received`, r.agentReceivedCents, f.agentTotal],
      [`${f.month} agent cohort`, r.agentReceivedCohortCents, f.agentCohort],
      [`${f.month} local received`, r.vendorReceivedCents, f.localTotal],
      [`${f.month} local cohort`, r.vendorReceivedCohortCents, f.localCohort],
    ];
    for (const [name, got, want] of cases) {
      if (got === want) ok(`${name} = ${usd(got)}`);
      else bad(`${name}: expected ${usd(want)}, got ${usd(got)}`);
    }
  }

  // ── 2 · the predicate is applied, not merely present ─────────────────────
  out("\n2 · cohort is a STRICT subset (catches a dropped in_cohort predicate)\n");
  const current = currentMonthRange();
  const months = [
    ...FIXTURES.map((f) => ({ month: f.month, from: f.from, to: f.to })),
    { month: current.label, from: current.from, to: current.to },
  ];
  let sawStrictlyLess = false;
  for (const m of months) {
    const r = await fetchPeriodReceivedSplit(db, m.from, m.to);
    for (const [lane, cohort, total] of [
      ["agent", r.agentReceivedCohortCents, r.agentReceivedCents],
      ["local", r.vendorReceivedCohortCents, r.vendorReceivedCents],
    ] as Array<[string, number, number]>) {
      if (cohort > total) {
        bad(`${m.month} ${lane}: cohort ${usd(cohort)} exceeds total ${usd(total)}`);
      } else if (cohort < total) {
        sawStrictlyLess = true;
        ok(`${m.month} ${lane}: ${usd(cohort)} of ${usd(total)} was ordered in-period`);
      } else {
        ok(`${m.month} ${lane}: cohort equals total (${usd(total)}) — nothing older landed`);
      }
    }
  }
  if (sawStrictlyLess) {
    ok("at least one month carries goods ordered earlier — the predicate bites");
  } else {
    bad(
      "cohort equals total in EVERY month — either the in_cohort predicate is " +
        "gone/always-true, or production genuinely has no cross-month arrivals " +
        "left to measure. Check the data before relaxing this."
    );
  }

  // ── 3 · Created decomposes on the live month, China lane ─────────────────
  out(`\n3 · ${current.label} China lane: created = received_cohort + in_transit_cohort\n`);
  const created = await fetchPoSpend(db, current.from, current.to);
  const received = await fetchPeriodReceivedSplit(db, current.from, current.to);
  const openNow = await fetchCurrentPoOutstanding(db, { from: current.from, to: current.to });

  const parts = received.agentReceivedCohortCents + openNow.chinaAgentCohortCents;
  const residual = created.chinaAgentCents - parts;
  out(
    `        created ${usd(created.chinaAgentCents)} · received_cohort ` +
      `${usd(received.agentReceivedCohortCents)} · in_transit_cohort ` +
      `${usd(openNow.chinaAgentCohortCents)}\n`
  );
  if (residual === 0) {
    ok(`decomposition closes exactly (residual ${usd(0)})`);
  } else {
    bad(
      `residual ${usd(residual)} — a PO placed this month left the open set ` +
        `without being received (cancelled, closed or voided), or one of the ` +
        `three legs changed cost basis. Not automatically a bug: identify the PO ` +
        `before changing any of the three queries.`
    );
  }

  // ── 4 · In Transit's headline stays period-INDEPENDENT ───────────────────
  out("\n4 · the cohort leg never narrows the headline In Transit\n");
  const openUnscoped = await fetchCurrentPoOutstanding(db);
  if (
    openUnscoped.chinaAgentCents === openNow.chinaAgentCents &&
    openUnscoped.localVendorCents === openNow.localVendorCents
  ) {
    ok(
      `live outstanding identical with and without the cohort argument ` +
        `(agent ${usd(openNow.chinaAgentCents)}, local ${usd(openNow.localVendorCents)})`
    );
  } else {
    bad(
      `passing a cohort changed the headline figure: agent ` +
        `${usd(openUnscoped.chinaAgentCents)} → ${usd(openNow.chinaAgentCents)}, local ` +
        `${usd(openUnscoped.localVendorCents)} → ${usd(openNow.localVendorCents)}. ` +
        `In Transit must stay the period-independent live number.`
    );
  }
  if (openUnscoped.chinaAgentCohortCents !== 0 || openUnscoped.localVendorCohortCents !== 0) {
    bad(
      `without a cohort argument the cohort legs must be 0, got agent ` +
        `${usd(openUnscoped.chinaAgentCohortCents)} / local ` +
        `${usd(openUnscoped.localVendorCohortCents)}`
    );
  } else {
    ok("no cohort argument ⇒ cohort legs are 0 (current mode shows no sub-line)");
  }

  // ── 5 · negative control for the In Transit cohort predicate ─────────────
  // Checks 3 and 4 do NOT cover an always-true predicate on this leg: measured
  // 2026-08-27, every open PO happened to be placed in the running month, so
  // cohort and total coincide and a broken filter reads as correct. That is a
  // property of today's data, not of the code, and it will silently come and go.
  // A window that CANNOT contain an open PO pins it down: the cohort must be
  // exactly 0 there while the headline stays whole.
  out("\n5 · negative control — a window with no open POs must yield a 0 cohort\n");
  const ancient = { from: "2000-01-01T00:00:00Z", to: "2001-01-01T00:00:00Z" };
  const openAncient = await fetchCurrentPoOutstanding(db, ancient);
  if (openAncient.chinaAgentCents === 0 && openAncient.localVendorCents === 0) {
    out("  SKIP  nothing is outstanding at all — no headline to contrast against\n");
  } else if (
    openAncient.chinaAgentCohortCents === 0 &&
    openAncient.localVendorCohortCents === 0
  ) {
    ok(
      `year 2000 cohort is ${usd(0)} against a live ` +
        `${usd(openAncient.chinaAgentCents + openAncient.localVendorCents)} outstanding`
    );
  } else {
    bad(
      `year 2000 cohort is non-zero (agent ${usd(openAncient.chinaAgentCohortCents)}, ` +
        `local ${usd(openAncient.localVendorCohortCents)}) — no purchase order was ` +
        `placed then, so the in_cohort predicate is not filtering.`
    );
  }


  // ── 6 · the Factories → China arrow ──────────────────────────────────────
  // Its two queries live on a separate code path (factory_order*, valued at
  // factory cost pre-freight) and neither had ever been executed with bindings
  // before this check existed — fetchFactoryOrderReceived had to grow a join to
  // the FO header just to know when the order was placed.
  out("\n6 · Factories → China cohort legs\n");
  const foCreated = await fetchFactoryOrderSpend(db, current.from, current.to);
  const foReceived = await fetchFactoryOrderReceived(db, current.from, current.to);
  const foOpen = await fetchCurrentFoOutstanding(db, { from: current.from, to: current.to });
  const foOpenAncient = await fetchCurrentFoOutstanding(db, ancient);
  out(
    `        created ${usd(foCreated)} · received ${usd(foReceived.cents)} ` +
      `(cohort ${usd(foReceived.cohortCents)}) · in transit ${usd(foOpen.cents)} ` +
      `(cohort ${usd(foOpen.cohortCents)})\n`
  );
  if (foReceived.cohortCents > foReceived.cents) {
    bad(`FO received cohort ${usd(foReceived.cohortCents)} exceeds total ${usd(foReceived.cents)}`);
  } else {
    ok(`FO received cohort within total`);
  }
  if (foOpen.cohortCents > foOpen.cents) {
    bad(`FO in-transit cohort ${usd(foOpen.cohortCents)} exceeds total ${usd(foOpen.cents)}`);
  } else {
    ok(`FO in-transit cohort within total`);
  }
  if (foOpenAncient.cents === 0) {
    out("  SKIP  no factory orders outstanding — no headline to contrast against\n");
  } else if (foOpenAncient.cohortCents === 0) {
    ok(`FO year 2000 cohort is ${usd(0)} against a live ${usd(foOpenAncient.cents)} outstanding`);
  } else {
    bad(
      `FO year 2000 cohort is ${usd(foOpenAncient.cohortCents)} — the in_cohort ` +
        `predicate on factory orders is not filtering.`
    );
  }

  out(failed === 0 ? "\nALL CHECKS PASSED\n\n" : `\n${failed} CHECK(S) FAILED\n\n`);
  if (failed > 0) process.exit(1);
}
