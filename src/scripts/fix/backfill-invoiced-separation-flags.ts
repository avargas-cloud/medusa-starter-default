/**
 * One-shot: align `order.metadata.fully_invoiced` with reality on OPEN orders,
 * in both directions.
 *
 * WHY — `stampFullyInvoiced` gated itself on "already separated" until
 * 2026-08-14, so billed-in-full orders that were never separated carry no flag
 * and the POS shows "To Separate" forever (8 in prod, S2918 among them). The
 * inverse drift — a stale `true` on an order edited UP after full billing —
 * is also corrected here if it ever exists (none did on 2026-08-14).
 *
 * The subscriber fix covers the future; this covers history.
 *
 * Writes ONLY the `fully_invoiced` key (order metadata deep-merges). A flag
 * that is absent while computed-false is left absent — absence already means
 * false, and stamping ~1,400 orders would be churn without a reader.
 *
 * Reindexing is NOT done here on purpose: the `order` row trigger enqueues to
 * meili_sync_queue and orderReconciler rebuilds the doc through the one
 * canonical path (enriched totals + items). A hand-rolled doc build here would
 * be a second, poorer writer — the exact divergence that caused S11417.
 *
 * DRY RUN by default. Apply:
 *   env DATABASE_URL=... APPLY=true npx medusa exec ./src/scripts/fix/backfill-invoiced-separation-flags.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { loadFullyInvoicedForOrder } from "../../lib/invoices/load-fully-invoiced";

const MAX_WRITES = 50;

export default async function backfillInvoicedSeparationFlags({
  container,
}: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  const query = container.resolve("query");
  const orderModule = container.resolve(Modules.ORDER);

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "status", "is_draft_order", "metadata"],
    pagination: { take: null },
  });

  const open = (orders ?? []).filter(
    (o: any) =>
      o?.is_draft_order !== true &&
      !["completed", "canceled", "archived", "draft"].includes(o?.status)
  );
  console.log(
    `[backfill-invoiced-flags] ${open.length} open order(s) to evaluate (${
      apply ? "APPLY" : "DRY RUN"
    })`
  );

  const changes: Array<{
    id: string;
    display_id: number;
    before: unknown;
    after: boolean;
  }> = [];

  for (const o of open) {
    try {
      const meta = (o.metadata ?? {}) as Record<string, unknown>;
      const before = meta.fully_invoiced;
      const computed = await loadFullyInvoicedForOrder(o.id, container);

      // Absent + computed-false needs no write: absence already reads false.
      const needsWrite = computed ? before !== true : before === true;
      if (!needsWrite) continue;

      changes.push({
        id: o.id,
        display_id: o.display_id,
        before: before ?? null,
        after: computed,
      });
    } catch (err: unknown) {
      console.log(
        `[backfill-invoiced-flags] ❌ evaluate ${o.id}: ${(err as Error).message}`
      );
    }
  }

  // The rollback artifact: before-values per order, printed in full.
  console.log(
    `[backfill-invoiced-flags] plan (${changes.length} write(s)):\n` +
      changes
        .map(
          (c) =>
            `  S${c.display_id} (${c.id}): fully_invoiced ${JSON.stringify(
              c.before
            )} → ${c.after}`
        )
        .join("\n")
  );

  if (changes.length > MAX_WRITES) {
    throw new Error(
      `[backfill-invoiced-flags] ${changes.length} writes exceed the declared cap of ${MAX_WRITES} — aborting; re-scope first.`
    );
  }
  if (!apply) {
    console.log("[backfill-invoiced-flags] DRY RUN — nothing written.");
    return;
  }

  for (const c of changes) {
    await orderModule.updateOrders(c.id, {
      metadata: { fully_invoiced: c.after },
    });
    console.log(
      `[backfill-invoiced-flags] ✅ S${c.display_id} fully_invoiced → ${c.after}`
    );
  }
  console.log(
    `[backfill-invoiced-flags] done: ${changes.length} order(s) stamped. ` +
      "Meili follows via the order trigger + orderReconciler (~1 min)."
  );
}
