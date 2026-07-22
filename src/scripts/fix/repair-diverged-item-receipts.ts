/**
 * src/scripts/fix/repair-diverged-item-receipts.ts
 *
 * One-off (and re-runnable) repair for ItemReceipts whose quantity in QB
 * diverged from Medusa because a line was edited while the ADD was still
 * in-flight, so the frozen ADD payload shipped the pre-edit qty and no Mod ever
 * corrected it (root cause of the RCP-1134 / PO-1081 QB Error 3060 incident).
 *
 * It enqueues an ItemReceiptMod that rehydrates the receipt from LIVE state
 * (qty>0 lines sent, qty=0 lines omitted → QB deletes them and reopens the PO
 * qty). The Railway item-receipt poller (Phase F) dispatches it on the next
 * tick; the bridge preflight-queries the EditSequence, so a stale/null
 * edit_sequence is harmless.
 *
 * DRY-RUN by default (nothing is written). Reports ALL current drift.
 * To APPLY, you MUST name the receipts explicitly:
 *
 *   # report only (read-only):
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/fix/repair-diverged-item-receipts.ts
 *
 *   # enqueue Mods for the named receipts:
 *   APPLY=true RECEIPTS=RCP-1134,RCP-1071 \
 *     env DATABASE_URL=... npx medusa exec ./src/scripts/fix/repair-diverged-item-receipts.ts
 */

import {
  buildItemReceiptModPayload,
  computeReceiptDrift,
  enqueueItemReceiptModAtomic,
  type KnexRaw,
} from "../../lib/purchase-orders/item-receipt-mod-payload";

export default async function repairDivergedItemReceipts({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}) {
  const APPLY = process.env.APPLY === "true";
  const targets = (process.env.RECEIPTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const knex = container.resolve("__pg_connection__") as KnexRaw;

  const drift = await computeReceiptDrift(knex);

  console.log(
    `\n🔎 Item-receipt QB drift scan — ${drift.length} receipt(s) diverged (QB qty ≠ live qty)\n`
  );
  for (const d of drift) {
    console.log(`  ${d.receipt_number} (${d.receipt_id})`);
    for (const l of d.lines) {
      const act = l.live_qty === 0 ? "→ OMIT (QB deletes line, reopens PO qty)" : "";
      console.log(
        `     ${l.sku.padEnd(20)} QB=${l.qb_qty}  live=${l.live_qty}  Δ=${l.live_qty - l.qb_qty} ${act}`
      );
    }
  }

  if (targets.length === 0) {
    console.log(
      `\nℹ️  Read-only report. To enqueue Mods, re-run with APPLY=true RECEIPTS=<comma-separated numbers>.\n`
    );
    return;
  }

  console.log(
    `\n${APPLY ? "🔧 APPLY" : "🧪 DRY-RUN"} — enqueue Mods for: ${targets.join(", ")}\n`
  );

  const driftByNumber = new Map(drift.map((d) => [d.receipt_number, d]));
  let enqueued = 0;

  for (const num of targets) {
    const d = driftByNumber.get(num);
    if (!d) {
      console.log(`  ⏭️  ${num}: not in the current drift set — skipping (already matches QB, or guarded).`);
      continue;
    }

    const built = await buildItemReceiptModPayload(knex, d.receipt_id);
    if (!built.ok) {
      console.log(`  ⛔ ${num}: cannot build Mod payload — ${built.reason}`);
      continue;
    }

    console.log(
      `  ${num}: Mod payload = ${built.payload.lines.length} line(s) → ${built.payload.lines
        .map((l) => `${l.sku}:${l.qty_received_now}`)
        .join(", ")}`
    );

    if (!APPLY) {
      console.log(`     (dry-run — would set mod_status='waiting')`);
      continue;
    }

    const ok = await enqueueItemReceiptModAtomic(knex, built.pipeline_id, built.payload);
    if (ok) {
      enqueued++;
      console.log(`     ✅ enqueued — poller Phase F will dispatch on next tick.`);
    } else {
      console.log(`     ⚠️  atomic gate rejected (a Mod is already waiting/submitted, or ADD not synced).`);
    }
  }

  console.log(
    `\n${APPLY ? `✅ APPLY complete — ${enqueued} Mod(s) enqueued.` : "ℹ️  DRY-RUN only — re-run with APPLY=true to write."}\n`
  );
}
