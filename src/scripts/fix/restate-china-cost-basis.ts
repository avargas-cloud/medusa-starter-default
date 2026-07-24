/**
 * Restate the cost basis of every China-sourced product, and every historical
 * COGS snapshot that depended on it.
 *
 * WHAT IT DOES
 *   1. Anchors each variant at its ORIGINAL QuickBooks average cost (the
 *      2026-04-14 catalog load) — the value the 2026-07-17 convergence backfill
 *      discarded in favour of raw factory cost.
 *   2. Replays every confirmed vendor bill chronologically through the AVCO
 *      engine, using quantities reconstructed from the movement ledger instead
 *      of the unverified per-receipt capture, and settling oversold stock
 *      explicitly rather than clamping it.
 *   3. Reprices every historical invoice line at the cost in effect on the
 *      invoice's own date, and every credit-memo line at the cost of the sale
 *      it reverses.
 *
 * The customer-facing invoice never changes: price, tax, totals, payments and
 * receivable are untouched. Only the internal COGS annotation moves — and its
 * previous value is preserved in `sale_cost_adjustment` before it does.
 *
 * USAGE
 *   Dry run (default — reads only, writes nothing):
 *     env $(grep ^DATABASE_URL= .env) npx medusa exec ./src/scripts/fix/restate-china-cost-basis.ts
 *
 *   Apply:
 *     APPLY=true RUN_ID=csr_2026_07_24_a REASON="..." \
 *       npx medusa exec ./src/scripts/fix/restate-china-cost-basis.ts
 *
 *   Options:
 *     ANCHOR_DATE=2026-04-14T00:00:00Z   opening-balance date
 *     CUTOFF=2026-07-24T00:00:00Z        freeze inputs at this instant
 *     VERBOSE=true                       per-variant timeline detail
 */

import {
  buildPlan,
  DEFAULT_ANCHOR_DATE,
  METHODOLOGY_VERSION,
  type RestatementPlan,
} from "../../lib/cost/restatement/run-restatement";
import { applyPlan, type KnexWithTransaction } from "../../lib/cost/restatement/apply-plan";

const money = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${Math.abs(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const dollars = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export default async function restateChinaCostBasis({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as KnexWithTransaction;

  const apply = process.env.APPLY === "true";
  const verbose = process.env.VERBOSE === "true";
  const anchorDate = new Date(process.env.ANCHOR_DATE ?? DEFAULT_ANCHOR_DATE);
  const sourceDataCutoff = new Date(process.env.CUTOFF ?? Date.now());
  const runId =
    process.env.RUN_ID ?? `csr_dryrun_${sourceDataCutoff.toISOString().slice(0, 10)}`;
  const reason =
    process.env.REASON ??
    "China cost basis: restore the QuickBooks anchor discarded by the 2026-07-17 " +
      "convergence backfill and replay vendor-bill AVCO with a correct seed";

  console.log("═".repeat(78));
  console.log("  CHINA COST-BASIS RESTATEMENT");
  console.log("═".repeat(78));
  console.log(`  mode         ${apply ? "APPLY (writes)" : "DRY RUN (reads only)"}`);
  console.log(`  run id       ${runId}`);
  console.log(`  methodology  ${METHODOLOGY_VERSION}`);
  console.log(`  anchor       ${anchorDate.toISOString()}  (QuickBooks catalog load)`);
  console.log(`  cutoff       ${sourceDataCutoff.toISOString()}`);
  console.log("");

  const plan = await buildPlan(knex, {
    runId,
    anchorDate,
    sourceDataCutoff,
    reason,
    requestedBy: process.env.REQUESTED_BY ?? null,
  });

  printReconciliation(plan);
  if (verbose) printVariantDetail(plan);

  if (!apply) {
    console.log("");
    console.log("DRY RUN — nothing was written. Set APPLY=true and RUN_ID=<id> to persist.");
    return {
      dryRun: true,
      inputHash: plan.inputHash,
      reconciliation: plan.reconciliation,
    };
  }

  if (!process.env.RUN_ID) {
    throw new Error("APPLY=true requires an explicit RUN_ID so the run is auditable.");
  }

  console.log("");
  console.log("Applying…");
  const result = await applyPlan(knex, plan);
  console.log(`  cost events written     ${result.costEventsWritten}`);
  console.log(`  variants updated        ${result.variantsUpdated}`);
  console.log(`  invoice lines restated  ${result.invoiceLinesRestated}`);
  console.log(`  memo lines restated     ${result.creditMemoLinesRestated}`);
  console.log("");
  console.log(`✅ Applied as run ${result.runId} (input hash ${plan.inputHash.slice(0, 16)}…)`);

  return { dryRun: false, inputHash: plan.inputHash, ...result };
}

function printReconciliation(plan: RestatementPlan): void {
  const r = plan.reconciliation;

  console.log("── INVENTORY (Miami costing pool) " + "─".repeat(44));
  console.log(`  variants in scope             ${r.variantsInScope}`);
  console.log(`  with a QuickBooks anchor      ${r.variantsWithAnchor}`);
  console.log(`  cost events rebuilt           ${r.costEvents}`);
  console.log(`  value at today's cost         ${money(r.inventoryValueBeforeCents)}`);
  console.log(`  value at restated cost        ${money(r.inventoryValueAfterCents)}`);
  console.log(`  revaluation                   ${money(r.inventoryDeltaCents)}`);
  if (r.chinaWarehouseUnits > 0) {
    console.log(
      `  ⚠ China Warehouse units       ${r.chinaWarehouseUnits} — NOT revalued ` +
        `(pre-freight stage, outside the Miami pool)`
    );
  }
  if (r.cogsTrueUpCents !== 0) {
    console.log(`  negative-stock COGS true-up   ${money(r.cogsTrueUpCents)}`);
  }

  console.log("");
  console.log("── COGS RESTATEMENT " + "─".repeat(58));
  const table = [
    ["invoice lines", r.invoices],
    ["credit-memo lines", r.creditMemos],
  ] as const;
  for (const [label, summary] of table) {
    console.log(`  ${label}`);
    console.log(`    lines / changed             ${summary.lines} / ${summary.changedLines}`);
    console.log(`    COGS before                 ${dollars(summary.originalCogs)}`);
    console.log(`    COGS after                  ${dollars(summary.restatedCogs)}`);
    console.log(`    delta                       ${dollars(summary.deltaCogs)}`);
    const reasons = Object.entries(summary.byReason)
      .filter(([code]) => code !== "unchanged")
      .map(([code, count]) => `${code}=${count}`);
    if (reasons.length) console.log(`    pricing basis               ${reasons.join(", ")}`);
  }
  console.log("");
  console.log(`  NET COGS ADJUSTMENT           ${dollars(r.totalCogsDelta)}`);
  console.log(
    `  (a positive figure means COGS was UNDERSTATED — reported profit was too high)`
  );

  console.log("");
  console.log("── EXCEPTIONS " + "─".repeat(64));
  const codes = Object.entries(r.exceptionsByCode);
  if (codes.length === 0) {
    console.log("  none");
  } else {
    for (const [code, count] of codes.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${code}`);
    }
    console.log("");
    console.log("  First 10:");
    for (const exception of plan.exceptions.slice(0, 10)) {
      console.log(`    [${exception.code}] ${exception.sku ?? exception.variantId}: ${exception.detail}`);
    }
  }
}

function printVariantDetail(plan: RestatementPlan): void {
  console.log("");
  console.log("── PER-VARIANT TIMELINES " + "─".repeat(53));
  const movers = plan.rebuilds
    .filter((rebuild) => rebuild.events.length > 1)
    .sort((a, b) => b.events.length - a.events.length);

  for (const rebuild of movers) {
    console.log("");
    console.log(`  ${rebuild.sku ?? rebuild.variantId}   opening qty ${rebuild.openingQuantity}`);
    for (const event of rebuild.events) {
      const from =
        event.previousUnitCostCents === null
          ? "—"
          : `$${(event.previousUnitCostCents / 100).toFixed(4)}`;
      const to = `$${(event.newUnitCostCents / 100).toFixed(4)}`;
      const settled =
        event.negativeSettledQuantity > 0
          ? `  [settled ${event.negativeSettledQuantity} oversold, true-up ${money(event.cogsTrueUpCents)}]`
          : "";
      console.log(
        `    ${event.effectiveAt.toISOString().slice(0, 10)}  ${event.eventType.padEnd(20)} ` +
          `qty ${String(event.quantityDelta).padStart(5)}  on-hand ${String(
            event.quantityOnHandBefore
          ).padStart(5)} → ${String(event.quantityOnHandAfter).padStart(5)}  ` +
          `${from} → ${to}${settled}`
      );
    }
  }
}
