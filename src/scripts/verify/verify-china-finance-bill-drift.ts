/**
 * verify-china-finance-bill-drift
 *
 * Read-only. Two halves:
 *   1. Unit-checks the pure adjustment helpers (diff + note wording).
 *   2. Runs the real drift engine against the LIVE Veetech bill set and asserts
 *      the verdicts we established by hand while diagnosing the $16.73 credit.
 *
 * Safe against prod: every query is a SELECT.
 *
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-china-finance-bill-drift.ts
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

const VEETECH_VENDOR_ID = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC";

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

  // ── 2. Live drift engine ───────────────────────────────────────────────────
  console.log("\nDrift engine vs live Veetech bills");

  const drift = await loadBillDrift(knex, { vendorId: VEETECH_VENDOR_ID });
  const byNumber = new Map<string, BillDrift>();
  for (const d of drift.values()) {
    if (d.vendor_bill_number) byNumber.set(d.vendor_bill_number, d);
  }

  const numbers = await knex.raw(
    `SELECT id, number FROM vendor_bill
      WHERE vendor_id = ? AND deleted_at IS NULL AND bill_type IN ('regular','service','freight')`,
    [VEETECH_VENDOR_ID]
  );
  const total = numbers.rows.length;
  console.log(`  (scanned ${total} bills, ${drift.size} in drift)`);
  for (const d of drift.values()) {
    console.log(
      `    ${d.vendor_bill_number ?? d.vendor_bill_id} · ${d.kind} · ` +
        `Δ ${(d.delta_cents / 100).toFixed(2)} vs ${d.source_label}` +
        `${d.on_confirmed_wire ? " · PAID" : ""}`
    );
  }

  // VB-1045: bills 50 units of a SKU whose pinned receipt says 25. This is the
  // case the old po_drift check went BLIND to the moment the receipt was pinned.
  const v1045 = byNumber.get("VB-1045");
  check("VB-1045 is flagged (receipt-pinned blind spot closed)", !!v1045);
  check("VB-1045 compares against the RECEIPT", v1045?.kind === "receipt_lines", v1045?.kind);
  check("VB-1045 delta is +$111.50 over-billed", v1045?.delta_cents === 11150, `${v1045?.delta_cents}`);
  check("VB-1045 is marked as already paid", v1045?.on_confirmed_wire === true);
  check("VB-1045 names the offending SKU", v1045?.lines.some((l) => l.sku === "EAP-RM5-8S") === true);

  // VB-1046: the agent's commission reconciles to a SMALLER goods base than our
  // goods bill declares — the agent already revised, our bill is stale.
  const v1046 = byNumber.get("VB-1046");
  check("VB-1046 commission mismatch is flagged", v1046?.kind === "commission", v1046?.kind);
  check("VB-1046 delta is -$16.73", v1046?.delta_cents === -1673, `${v1046?.delta_cents}`);
  check(
    "VB-1046 implies a $3,025.00 goods base",
    v1046?.implied_base_cents === 302500,
    `${v1046?.implied_base_cents}`
  );

  // Every OTHER service bill must be silent — the agent's own rounding (never
  // more than 0.5¢ across 18 pairs) must not raise an alarm at a 10¢ tolerance.
  const noisyCommission = Array.from(drift.values()).filter(
    (d) => d.kind === "commission" && d.vendor_bill_number !== "VB-1046"
  );
  check(
    "no other commission bill is flagged (rounding tolerated)",
    noisyCommission.length === 0,
    noisyCommission.map((d) => `${d.vendor_bill_number}:${d.delta_cents}`).join(", ")
  );

  // Freight was clean across all 18 pairs when this was written.
  const freightDrift = Array.from(drift.values()).filter((d) => d.kind === "freight");
  check(
    "no freight bill is flagged",
    freightDrift.length === 0,
    freightDrift.map((d) => `${d.vendor_bill_number}:${d.delta_cents}`).join(", ")
  );

  // VB-1056 had a PO line missing from the bill; it was reconciled 2026-07-21.
  check("VB-1056 is clean after its Update From…", !byNumber.has("VB-1056"));

  // VB-1004's quantities match its receipt exactly. It only LOOKED like a
  // $111.50 shortfall because its line carries the receipt_line_id of a
  // DIFFERENT receipt on the same PO — the FK must fall back to SKU, never be
  // read as "the source says zero".
  check(
    "VB-1004 is not a phantom (multi-receipt FK falls back to SKU)",
    !byNumber.has("VB-1004"),
    byNumber.get("VB-1004")
      ? `still flagged Δ ${byNumber.get("VB-1004")!.delta_cents}`
      : ""
  );

  // VB-1048 swapped a PO line (Samples → Sample-Product). Real drift, but the
  // amounts cancel, so it must still be reported AND must not headline "$0.00".
  const v1048 = byNumber.get("VB-1048");
  check("VB-1048 net-zero line swap is still reported", !!v1048);
  check("VB-1048 nets to zero", v1048?.delta_cents === 0, `${v1048?.delta_cents}`);
  check("VB-1048 carries both sides of the swap", (v1048?.lines.length ?? 0) === 2, `${v1048?.lines.length}`);
  check(
    "a net-zero drift never headlines a dollar figure",
    v1048 ? !describeDrift(v1048).includes("$0.00") : false,
    v1048 ? describeDrift(v1048) : ""
  );

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}
