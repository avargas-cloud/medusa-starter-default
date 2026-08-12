/**
 * src/scripts/fix/repair-reservation-integrity.ts
 *
 * Repairs the inventory data-integrity bugs that sit UNDERNEATH the Meili
 * desync (Meili faithfully mirrors inventory_level — if the level is wrong,
 * Meili is wrong too). Three distinct defects, all observed in prod:
 *
 *   1. ORPHAN RESERVATIONS — a reservation_item still active on an order line
 *      that is already fully fulfilled (units already shipped) or whose order
 *      is canceled. Example: SKU XLG-200-24-A, order 1642 delivered qty 14 yet
 *      reservation qty 14 still active. These wrongly suppress available stock.
 *
 *   2. RESERVED-CACHE DRIFT — inventory_level.reserved_quantity != SUM of the
 *      active reservation_item.quantity for that (item, location). The level
 *      caches a stale number. Example: XLG level.reserved=1 vs reservations=15.
 *
 *   3. NEGATIVE STOCK — inventory_level.stocked_quantity < 0 (e.g. EPS-SPR-S-W-D
 *      = -2). Reported only by default (clamping needs a human decision).
 *
 * Order of operations matters: delete orphans FIRST, then recompute the
 * reserved cache from what remains, then re-sync Meili.
 *
 * SAFETY: dry-run by default. Pass `--apply` to write. Negative-stock clamping
 * requires `--clamp-negative` on top of `--apply`. Every affected inventory
 * item is re-synced to MeiliSearch at the end.
 *
 *   yarn medusa exec ./src/scripts/fix/repair-reservation-integrity.ts            # dry-run
 *   yarn medusa exec ./src/scripts/fix/repair-reservation-integrity.ts --apply
 *   yarn medusa exec ./src/scripts/fix/repair-reservation-integrity.ts --apply --clamp-negative
 */
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

interface OrphanRow {
  reservation_id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  line_item_id: string | null;
  reason: string;
}

interface CacheDriftRow {
  inventory_item_id: string;
  location_id: string;
  cached_reserved: number;
  real_reserved: number;
}

interface NegativeRow {
  inventory_item_id: string;
  location_id: string;
  stocked_quantity: number;
}

/** Narrow shape of the knex `raw` we use (PG_CONNECTION). */
interface KnexRaw {
  raw: <T = { rows: unknown[] }>(sql: string, bindings?: unknown[]) => Promise<T>;
}

/** Narrow shape of the inventory module method we call. */
interface InventoryServiceLike {
  deleteReservationItems: (ids: string[]) => Promise<void>;
}

export default async function repairReservationIntegrity({
  container,
  args,
}: {
  container: MedusaContainer;
  args: string[];
}): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  // `medusa exec` intercepts --flags, so callers pass bare words
  // (`medusa exec ./file.ts apply clamp-negative`). Accept both forms + env.
  const has = (name: string) =>
    args.includes(name) || args.includes(`--${name}`);
  const apply = has("apply") || process.env.APPLY === "1";
  const clampNegative = has("clamp-negative");
  const prodConfirmed = has("prod-confirmed");

  // Raw SQL via the shared knex connection — read-only for detection.
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as KnexRaw;

  // ── Target-DB guard ─────────────────────────────────────────────────────
  // `medusa exec` can silently pick up a leaked DATABASE_URL from the shell and
  // hit the WRONG database. Announce the target, and refuse a destructive
  // --apply against the prod DB ('railway') unless --prod-confirmed is passed.
  const dbInfo = await knex.raw<{
    rows: Array<{ db: string; host: string | null; port: number | null }>;
  }>(
    `SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port`
  );
  const target = dbInfo.rows[0];
  logger.info(
    `[repair-reservations] TARGET DB = ${target?.db} @ ${target?.host}:${target?.port}`
  );

  const isProd = target?.db === "railway";
  if (apply && isProd && !prodConfirmed) {
    logger.error(
      `[repair-reservations] REFUSING to --apply against prod DB '${target?.db}'. ` +
        `Re-run with --prod-confirmed once verified in sandbox.`
    );
    return;
  }

  logger.info(
    `[repair-reservations] mode=${apply ? "APPLY" : "DRY-RUN"} clampNegative=${clampNegative} prod=${isProd}`
  );

  // ── 1. Detect orphan reservations ───────────────────────────────────────
  // A reservation is orphan when its order line is fully fulfilled (units
  // already left) or the parent order is canceled. We join reservation_item
  // → order_item (latest non-deleted version) via line_item_id.
  // CRITICAL: order_item is VERSIONED — Medusa keeps a row per order version.
  // We MUST match only the CURRENT version (o.version = oi.version), otherwise
  // a stale version whose fulfilled_quantity >= quantity falsely flags a still
  // open/partial line as orphan. (Naive join over-counted 25→9 in prod.)
  //
  // TWO-SIGNAL RULE (added 2026-08-12, after S11179): `fulfilled_quantity` is a
  // counter and counters get poisoned — S11179 had numeric 6 / raw 3 / real 3,
  // and trusting the counter alone deleted a REAL backorder reservation for 3
  // units still owed to the customer. "Fully fulfilled" now requires the counter
  // AND the live fulfillment rows (canceled excluded) to independently agree.
  // A line where they disagree is reported as poisoned by the daily digest
  // (_reservation-drift-section) and never auto-deleted.
  const orphanResult = await knex.raw(
    `
    WITH active_ful AS (
      SELECT fi.line_item_id, SUM(fi.quantity) AS ful_real
      FROM fulfillment_item fi
      JOIN fulfillment f ON f.id = fi.fulfillment_id
        AND f.canceled_at IS NULL AND f.deleted_at IS NULL
      GROUP BY fi.line_item_id
    )
    SELECT ri.id              AS reservation_id,
           ri.inventory_item_id,
           ri.location_id,
           ri.quantity,
           ri.line_item_id,
           CASE
             WHEN o.status = 'canceled' THEN 'order_canceled'
             ELSE 'line_fully_fulfilled'
           END AS reason
    FROM reservation_item ri
    JOIN order_item oi
           ON oi.item_id = ri.line_item_id
          AND oi.deleted_at IS NULL
    JOIN "order" o
           ON o.id = oi.order_id
          AND o.version = oi.version
    LEFT JOIN active_ful af ON af.line_item_id = ri.line_item_id
    WHERE ri.deleted_at IS NULL
      AND (
        o.status = 'canceled'
        OR (
          oi.fulfilled_quantity >= oi.quantity
          AND COALESCE(af.ful_real, 0) >= oi.quantity
        )
      )
  `
  );
  const orphans: OrphanRow[] = (orphanResult as { rows: OrphanRow[] }).rows;

  // ── 3. Detect negative stock (report) ───────────────────────────────────
  const negResult = await knex.raw(
    `SELECT inventory_item_id, location_id, stocked_quantity
       FROM inventory_level
      WHERE stocked_quantity < 0`
  );
  const negatives: NegativeRow[] = (negResult as { rows: NegativeRow[] }).rows;

  logger.info(
    `[repair-reservations] found ${orphans.length} orphan reservations, ${negatives.length} negative-stock levels`
  );
  for (const o of orphans.slice(0, 40)) {
    logger.info(
      `  ORPHAN res=${o.reservation_id} item=${o.inventory_item_id} loc=${o.location_id} qty=${o.quantity} reason=${o.reason}`
    );
  }
  for (const n of negatives.slice(0, 40)) {
    logger.info(
      `  NEGATIVE item=${n.inventory_item_id} loc=${n.location_id} stocked=${n.stocked_quantity}`
    );
  }

  const affectedItems = new Set<string>();
  orphans.forEach((o) => affectedItems.add(o.inventory_item_id));

  // ── APPLY: delete orphan reservations via the inventory module ──────────
  if (apply && orphans.length > 0) {
    const inventoryService = container.resolve(
      Modules.INVENTORY
    ) as InventoryServiceLike;
    const ids = orphans.map((o) => o.reservation_id);
    // Delete in chunks to avoid oversized statements.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await inventoryService.deleteReservationItems(chunk);
    }
    logger.info(`[repair-reservations] deleted ${ids.length} orphan reservations`);
  }

  // ── 2. Recompute reserved-cache drift (AFTER orphan deletion) ───────────
  const driftResult = await knex.raw(
    `
    SELECT il.inventory_item_id,
           il.location_id,
           il.reserved_quantity AS cached_reserved,
           COALESCE(r.sum_qty, 0) AS real_reserved
    FROM inventory_level il
    LEFT JOIN (
      SELECT inventory_item_id, location_id, SUM(quantity) AS sum_qty
      FROM reservation_item
      WHERE deleted_at IS NULL
      GROUP BY inventory_item_id, location_id
    ) r
      ON r.inventory_item_id = il.inventory_item_id
     AND r.location_id = il.location_id
    WHERE il.reserved_quantity <> COALESCE(r.sum_qty, 0)
  `
  );
  const drifts: CacheDriftRow[] = (driftResult as { rows: CacheDriftRow[] }).rows;
  logger.info(
    `[repair-reservations] reserved-cache drift: ${drifts.length} levels (cache != SUM reservations)`
  );
  // ALL drifts must be re-synced to Meili — only the LOGGING is capped at 40.
  drifts.forEach((d) => affectedItems.add(d.inventory_item_id));
  for (const d of drifts.slice(0, 40)) {
    logger.info(
      `  CACHE item=${d.inventory_item_id} loc=${d.location_id} cached=${d.cached_reserved} real=${d.real_reserved}`
    );
  }

  if (apply && drifts.length > 0) {
    // reserved_quantity is a derived BigNumber cache. We must write BOTH the
    // numeric column AND the jsonb raw_ column (Medusa hydrates from raw_ first
    // — writing only the numeric one gets silently reverted on next ORM load).
    // Single set-based UPDATE so SUM is read atomically with the write (no
    // read-then-write race against concurrent reservation changes).
    const repaired = await knex.raw<{ rowCount?: number }>(
      `
      UPDATE inventory_level il
         SET reserved_quantity = sub.sum_qty,
             raw_reserved_quantity = jsonb_build_object('value', sub.sum_qty::text, 'precision', 20),
             updated_at = NOW()
      FROM (
        SELECT il2.inventory_item_id,
               il2.location_id,
               COALESCE(r.sum_qty, 0) AS sum_qty
        FROM inventory_level il2
        LEFT JOIN (
          SELECT inventory_item_id, location_id, SUM(quantity) AS sum_qty
          FROM reservation_item
          WHERE deleted_at IS NULL
          GROUP BY inventory_item_id, location_id
        ) r
          ON r.inventory_item_id = il2.inventory_item_id
         AND r.location_id = il2.location_id
        WHERE il2.deleted_at IS NULL
          AND il2.reserved_quantity <> COALESCE(r.sum_qty, 0)
      ) sub
      WHERE il.inventory_item_id = sub.inventory_item_id
        AND il.location_id = sub.location_id
        AND il.deleted_at IS NULL
    `
    );
    logger.info(
      `[repair-reservations] repaired ${
        repaired.rowCount ?? drifts.length
      } reserved-cache values (numeric + raw_)`
    );
  }

  // ── NEGATIVE STOCK: clamp only when explicitly asked ────────────────────
  if (apply && clampNegative && negatives.length > 0) {
    for (const n of negatives) {
      await knex.raw(
        `UPDATE inventory_level
            SET stocked_quantity = 0,
                raw_stocked_quantity = jsonb_build_object('value', '0', 'precision', 20),
                updated_at = NOW()
          WHERE inventory_item_id = ? AND location_id = ? AND deleted_at IS NULL`,
        [n.inventory_item_id, n.location_id]
      );
      affectedItems.add(n.inventory_item_id);
    }
    logger.info(
      `[repair-reservations] clamped ${negatives.length} negative-stock levels to 0`
    );
  } else if (negatives.length > 0) {
    logger.warn(
      `[repair-reservations] ${negatives.length} negative-stock levels NOT touched (need --clamp-negative). These usually mean over-fulfillment and want a human look.`
    );
  }

  // ── Re-sync every affected item to MeiliSearch ──────────────────────────
  if (apply && affectedItems.size > 0) {
    let ok = 0;
    for (const itemId of affectedItems) {
      try {
        await syncInventoryItemToMeiliSearchWorkflow(container).run({
          input: { inventoryItemId: itemId },
        });
        ok++;
      } catch (e: unknown) {
        logger.warn(
          `[repair-reservations] meili sync failed for ${itemId}: ${(e as Error).message}`
        );
      }
    }
    logger.info(
      `[repair-reservations] re-synced ${ok}/${affectedItems.size} affected items to Meili`
    );
  }

  logger.info(
    `[repair-reservations] DONE. ${apply ? "Changes applied." : "Dry-run only — re-run with --apply to write."}`
  );
}
