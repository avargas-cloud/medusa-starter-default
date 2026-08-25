/**
 * Re-stamps `order.metadata.separation_status` (+ its `is_separated` mirror)
 * for open orders whose stored stamp disagrees with the live derivation that
 * counts the invoiced floor (`effectiveSeparatedOf`, 2026-08-25).
 *
 * Why: the order-detail toolbar reads the STORED stamp, while the modal and
 * the list derive live. Before the floor entered the derivation, an order
 * whose open units were partly covered by invoices alone stamped `partial`
 * (or nothing at all) — 3021/S11432 showed "Partially Separated" on the
 * button, "162 of 162 set aside" in the modal and a full badge in the list.
 *
 * Writes ONLY the two metadata keys, via `||` merge (never a replace), on the
 * orders it names. It never touches `order_line_separation` rows, stock or
 * reservations. The UPDATE fires the Meili sync trigger, which is how the
 * list badge refreshes.
 *
 * Idempotent and resumable: the work-complete predicate is "does the stamp
 * match the recompute", so a re-run after an interruption only processes
 * what is still wrong.
 *
 * Dry-run by default. To apply:
 *   env DISABLE_SCHEDULED_JOBS=true DATABASE_URL=... APPLY=true \
 *       ROLLBACK_FILE=/abs/path/rollback.json \
 *       npx medusa exec ./src/scripts/fix/backfill-separation-status-floor.ts
 *
 * ROLLBACK_FILE is mandatory under APPLY: the old values are written there
 * BEFORE the first UPDATE. Restoring = re-stamping those values by hand.
 */
import { writeFileSync } from "node:fs";

import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import {
  effectiveSeparatedOf,
  separationStatusLinesOf,
} from "../../api/admin/orders/_lib/separation-caps";
import { deriveSeparationStatus } from "../../api/admin/orders/_lib/separation-status";
import { loadSeparationData } from "../../api/admin/orders/[id]/_lib/separation-data";

/** Safety cap: the measured universe is ~25 open orders with 3 divergent.
 *  Far more than 60 means the predicate drifted — stop and look. */
const MAX_UPDATES = 60;

export default async function backfillSeparationStatusFloor({
  container,
}: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  const rollbackFile = process.env.ROLLBACK_FILE ?? "";
  if (apply && !rollbackFile) {
    throw new Error(
      "[backfill-separation-status-floor] APPLY=true requires ROLLBACK_FILE=<abs path>"
    );
  }

  const query = container.resolve("query");
  const pool = getDbPool();

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
    `[backfill-separation-status-floor] ${apply ? "APPLY" : "DRY-RUN"} — ${open.length} open order(s)`
  );

  type Change = {
    order_id: string;
    display_id: number;
    old_separation_status: unknown;
    old_is_separated: unknown;
    new_separation_status: "none" | "partial" | "full";
    legacy: boolean;
  };
  const changes: Change[] = [];

  for (const o of open) {
    const data = await loadSeparationData(pool, o.id);
    if (!data) continue;
    const computed = deriveSeparationStatus(
      separationStatusLinesOf(data.lines).map((l) => ({
        quantity: l.quantity,
        fulfilled: l.fulfilled,
        separated: effectiveSeparatedOf(l),
      })),
      data.legacySeparatedFlag
    );
    const meta = (o.metadata ?? {}) as Record<string, unknown>;
    const raw = meta.separation_status;
    const shown = raw === "partial" || raw === "full" ? raw : "none";
    if (shown === computed) continue;
    changes.push({
      order_id: o.id,
      display_id: o.display_id,
      old_separation_status: raw ?? null,
      old_is_separated: meta.is_separated ?? null,
      new_separation_status: computed,
      legacy: data.legacySeparatedFlag,
    });
  }

  for (const c of changes) {
    console.log(
      `  S${c.display_id} ${c.order_id}: ${String(
        c.old_separation_status ?? "(absent)"
      )} → ${c.new_separation_status}${c.legacy ? "  [LEGACY is_separated sin filas — revisar antes de aplicar]" : ""}`
    );
  }
  console.log(
    `[backfill-separation-status-floor] ${changes.length} order(s) would change`
  );

  if (changes.length > MAX_UPDATES) {
    throw new Error(
      `[backfill-separation-status-floor] ${changes.length} > cap ${MAX_UPDATES} — predicate drifted, refusing`
    );
  }
  if (!apply || changes.length === 0) {
    if (!apply) console.log("Dry-run only. Set APPLY=true (+ROLLBACK_FILE) to write.");
    return;
  }

  // Old values FIRST — if the write below dies mid-way, the restore recipe
  // already exists on disk.
  writeFileSync(rollbackFile, JSON.stringify(changes, null, 2));
  console.log(`Rollback values written to ${rollbackFile}`);

  let applied = 0;
  for (const c of changes) {
    await pool.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1`,
      [
        c.order_id,
        JSON.stringify({
          separation_status: c.new_separation_status,
          is_separated: c.new_separation_status === "full",
        }),
      ]
    );
    applied++;
    console.log(`  ✅ S${c.display_id} stamped ${c.new_separation_status}`);
  }
  console.log(
    `[backfill-separation-status-floor] APPLIED ${applied}/${changes.length}`
  );
}
