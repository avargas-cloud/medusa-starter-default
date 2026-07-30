/**
 * verify-china-finance-bill-drift
 *
 * Read-only. Runs the REAL drift engine over every live vendor bill and does
 * two things a unit test cannot:
 *
 *   1. asserts INVARIANTS — statements that must hold whatever today's data
 *      happens to be;
 *   2. prints the day's drift set, plus the shapes known to be able to break
 *      the engine, so a human can look at them.
 *
 * WHAT THIS FILE DELIBERATELY NO LONGER DOES  [rewritten 2026-07-31]
 *
 * It used to assert verdicts about named production bills: "VB-1045 is
 * over-billed by $111.50", "VB-1046's delta is -$16.73". Every one of those was
 * a claim about data other people are allowed to correct — and somebody did
 * correct VB-1045, which turned eight assertions red for a reason that had
 * nothing to do with the code. It sat at 14 pass / 10 fail while the engine
 * changed five times underneath it, because nothing runs it automatically: CI
 * runs `test:unit` and `type-check`, and `verify-*` is a human gate.
 *
 * Those per-rule verdicts now live in `src/__tests__/china-finance/
 * bill-drift.unit.spec.ts`, on fixtures nobody can edit in production, and they
 * run on every push. A fixture pinned to a live document expires the next time
 * that document is fixed; that is not a bug in the fixture, it is what pinning
 * to live data means.
 *
 * WHY THESE INVARIANTS
 *
 * Each one is a defect this engine actually shipped, restated as a rule:
 *   · I1 — a missing line valued at $0.00 hid an $11.78 shortfall on a bill
 *     already paid by wire, and made it read as "the amounts cancel out".
 *   · I2/I3 — the headline number and the lines under it must be the same
 *     story; a drift that does not add up cannot be acted on.
 *   · I4 — adopted bills carry no lines, so any verdict about one is noise.
 *   · I5 — `info` is reserved for a partial invoice that is not yet wrong.
 *   · I6 — "$0.00" as a headline told the operator nothing was at stake.
 *
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-china-finance-bill-drift.ts
 *
 * Run it with `tsx` and it exits 0 WITHOUT EXECUTING — this is a `medusa exec`
 * script (`export default`). The silence of a verifier is not approval.
 */

import type { ExecArgs } from "@medusajs/framework/types";

import {
  buildAdjustmentNote,
  diffBillLines,
} from "../../lib/china-finance/bill-adjustment";
import {
  describeDrift,
  loadBillDrift,
  type BillDrift,
} from "../../lib/china-finance/bill-drift";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const money = (c: number): string =>
  `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

interface BillMeta {
  id: string;
  number: string | null;
  bill_type: string;
  status: string;
  vendor_name: string | null;
  is_agent: boolean;
}

export default async function main({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
  };

  // ── 1. Pure helpers ────────────────────────────────────────────────────────
  console.log("\nAdjustment helpers (pure)");

  const changes = diffBillLines(
    [
      { id: "a", sku: "EAP-RM5-8S", qty: 50, unit_cost_cents: 446 },
      { id: "b", sku: "EAP-AR1-8S", qty: 200, unit_cost_cents: 318 },
    ],
    [
      { id: "a", sku: "EAP-RM5-8S", qty: 25, unit_cost_cents: 446 },
      { id: "b", sku: "EAP-AR1-8S", qty: 200, unit_cost_cents: 318 },
    ]
  );
  check("only the changed line is reported", changes.length === 1, `got ${changes.length}`);
  check(
    "qty drop is valued correctly (25 × $4.46 = -$111.50)",
    changes[0]?.delta_cents === -11150,
    `got ${changes[0]?.delta_cents}`
  );

  const removed = diffBillLines(
    [{ id: "a", sku: "SAMPLES", qty: 1, unit_cost_cents: 2700 }],
    []
  );
  check("a removed line becomes to_qty 0", removed[0]?.to_qty === 0);
  check("a removed line is fully negative", removed[0]?.delta_cents === -2700);

  const added = diffBillLines(
    [],
    [{ id: null, sku: "EMSH4V160D30WRW3", qty: 40, unit_cost_cents: 2497 }]
  );
  check("an added line is positive", added[0]?.delta_cents === 99880);

  const note = buildAdjustmentNote({
    changes,
    previousTotalCents: 313650,
    newTotalCents: 302500,
    billNumber: "VB-1045",
    sourceLabel: "the receipt",
  });
  check("note names the SKU and both quantities", note.includes("EAP-RM5-8S quantity 50 → 25"));
  check("note states the resulting credit", note.includes("$111.50 difference is a credit"));
  check("note carries both totals", note.includes("$3,136.50") || note.includes("$3136.50"));

  // ── 2. The live drift set ──────────────────────────────────────────────────
  console.log("\nDrift engine vs every live vendor bill");

  const billRows = await knex.raw(
    `SELECT vb.id, vb.number, vb.bill_type, vb.status,
            qv.name AS vendor_name,
            COALESCE(qv.metadata @> '{"is_china_agent":true}'::jsonb
                     OR lower(qv.metadata->>'is_china_agent') = 'true', false) AS is_agent
       FROM vendor_bill vb
       LEFT JOIN qb_vendor qv ON qv.id = vb.vendor_id
      WHERE vb.deleted_at IS NULL
        AND vb.bill_type IN ('regular','service','freight')
        AND COALESCE(vb.qb_source,'') <> 'adopted'`
  );
  const bills = billRows.rows as BillMeta[];
  const metaById = new Map(bills.map((b) => [b.id, b]));

  const drift = new Map<string, BillDrift>();
  const CHUNK = 200;
  for (let i = 0; i < bills.length; i += CHUNK) {
    const part = await loadBillDrift(knex, {
      vendorBillIds: bills.slice(i, i + CHUNK).map((b) => b.id),
    });
    for (const [k, v] of part) drift.set(k, v);
  }
  const all = Array.from(drift.values());
  const agentDrift = all.filter((d) => metaById.get(d.vendor_bill_id)?.is_agent);

  console.log(
    `  (scanned ${bills.length} bills — ${bills.filter((b) => b.is_agent).length} of an ` +
      `agent vendor · ${drift.size} in drift, ${agentDrift.length} of them China Finance)`
  );
  for (const d of all.sort((a, b) => Math.abs(b.delta_cents) - Math.abs(a.delta_cents))) {
    const m = metaById.get(d.vendor_bill_id);
    console.log(
      `    ${d.vendor_bill_number ?? d.vendor_bill_id} [${d.severity}] ${d.kind} ` +
        `Δ ${money(d.delta_cents)} vs ${d.source_label}` +
        `${d.on_confirmed_wire ? " · PAID(wire)" : ""} · ${m?.vendor_name ?? "?"}` +
        `${m?.is_agent ? " (AGENT)" : ""} · ${m?.status}`
    );
    for (const l of d.lines) {
      console.log(
        `        ${l.sku || "(no sku)"} bill=${l.bill_qty} source=${l.source_qty} ` +
          `unit=${money(l.unit_cost_cents)} Δ ${money(l.delta_cents)}`
      );
    }
  }

  // ── 3. Invariants ──────────────────────────────────────────────────────────
  console.log("\nInvariants (true of ANY data)");

  // I1 — the defect that hid VB-1053. A line the bill does not carry is valued
  // from the receipt override, or failing that the PO's unit cost. Zero means
  // the engine could not price goods it can see, and a $0.00 delta is then
  // reported to the operator as "nothing changed".
  const zeroValued = all.flatMap((d) =>
    d.lines
      .filter((l) => l.bill_qty === 0 && l.source_qty > 0 && l.unit_cost_cents === 0)
      .map((l) => `${d.vendor_bill_number}:${l.sku || "(no sku)"}`)
  );
  check(
    "I1 · a line missing from the bill is never valued at $0.00",
    zeroValued.length === 0,
    zeroValued.join(", ")
  );

  // I2 — headline and detail must be the same story.
  const inconsistent = all
    .filter((d) => d.lines.length > 0)
    .filter(
      (d) => d.lines.reduce((n, l) => n + l.delta_cents, 0) !== d.delta_cents
    )
    .map((d) => `${d.vendor_bill_number}`);
  check(
    "I2 · the delta equals the sum of its lines",
    inconsistent.length === 0,
    inconsistent.join(", ")
  );

  // I3 — `expected_cents` is what the bill SHOULD say; the two must not drift
  // apart, or the "Update From…" preview would propose a different number than
  // the badge shows.
  const badExpected = all
    .filter((d) => d.expected_cents !== d.bill_total_cents - d.delta_cents)
    .map((d) => `${d.vendor_bill_number}`);
  check(
    "I3 · expected = bill total − delta",
    badExpected.length === 0,
    badExpected.join(", ")
  );

  // I4 — adopted bills are header-only mirrors of the accountant's QuickBooks
  // entry. They carry no lines, so any verdict about one is an artefact.
  const adopted = await knex.raw(
    `SELECT id FROM vendor_bill WHERE COALESCE(qb_source,'') = 'adopted' AND deleted_at IS NULL`
  );
  const adoptedIds = new Set((adopted.rows as Array<{ id: string }>).map((r) => r.id));
  const adoptedFlagged = all.filter((d) => adoptedIds.has(d.vendor_bill_id));
  check(
    `I4 · no adopted bill is flagged (${adoptedIds.size} adopted, excluded by design)`,
    adoptedFlagged.length === 0,
    adoptedFlagged.map((d) => d.vendor_bill_id).join(", ")
  );

  // I5 — `info` says "this is a partial invoice, nothing is wrong yet". It can
  // only ever apply to a bill claiming LESS than its PO and not yet pinned to a
  // receipt. An `info` on anything else would silence a real problem.
  const badInfo = all
    .filter((d) => d.severity === "info")
    .filter((d) => d.kind !== "po_lines" || d.delta_cents >= 0)
    .map((d) => `${d.vendor_bill_number}:${d.kind}:${d.delta_cents}`);
  check(
    "I5 · 'info' only ever means an under-claiming, receipt-less regular bill",
    badInfo.length === 0,
    badInfo.join(", ")
  );

  // I6 — a headline of "$0.00" reads as "no money at stake", which is exactly
  // what a net-zero line swap is NOT allowed to imply.
  const zeroHeadline = all
    .filter((d) => describeDrift(d).includes("$0.00"))
    .map((d) => `${d.vendor_bill_number}`);
  check(
    "I6 · no drift headlines a $0.00 figure",
    zeroHeadline.length === 0,
    zeroHeadline.join(", ")
  );

  // ── 4. Watch-list: the shapes that have broken this engine ─────────────────
  //
  // Not assertions — exposure. A SKU repeated across two PO lines is what made
  // VB-1048 report a $42.10 shortfall against a bill that was exact, back when
  // the received side was aggregated by SKU. The rule is now covered by the
  // unit spec; this prints who is standing on that shape today so a human can
  // see it coming rather than discovering it through a wrong number.
  console.log("\nWatch-list — POs whose SKU is not unique across their lines");
  const dupes = await knex.raw(
    `WITH dup AS (
       SELECT purchase_order_id, sku_snapshot, COUNT(*) AS n
         FROM purchase_order_line
        WHERE deleted_at IS NULL AND COALESCE(status,'open') <> 'cancelled'
        GROUP BY 1, 2 HAVING COUNT(*) > 1)
     SELECT po.number AS po_number, dup.sku_snapshot, dup.n,
            COALESCE((SELECT string_agg(vb.number, ', ' ORDER BY vb.number)
                        FROM vendor_bill vb
                       WHERE vb.purchase_order_id = po.id
                         AND vb.deleted_at IS NULL
                         AND vb.bill_type = 'regular'
                         AND COALESCE(vb.qb_source,'') <> 'adopted'), '—') AS bills
       FROM dup JOIN purchase_order po ON po.id = dup.purchase_order_id
      ORDER BY po.number`
  );
  const dupRows = dupes.rows as Array<{
    po_number: string;
    sku_snapshot: string;
    n: number;
    bills: string;
  }>;
  if (dupRows.length === 0) console.log("  (none)");
  for (const r of dupRows) {
    console.log(
      `  ${r.po_number} · "${r.sku_snapshot}" on ${r.n} lines · bills: ${r.bills}`
    );
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}
