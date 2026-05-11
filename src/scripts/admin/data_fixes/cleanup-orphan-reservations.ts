import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

type Mode = "dry-run" | "apply";

interface OrphanRow {
  reservation_id: string;
  line_item_id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  variant_sku: string | null;
  reason: string;
}

interface DriftRow {
  inventory_item_id: string;
  location_id: string;
  variant_sku: string | null;
  cached: number;
  actual: number;
  delta: number;
}

interface RawMirrorDriftRow {
  location_id: string;
  variant_sku: string | null;
  reserved: number;
  raw_value: string | null;
}

function resolveMode(args: string[]): Mode {
  if (args.includes("apply") || args.includes("--apply")) return "apply";
  if (process.env.CLEANUP_APPLY === "1" || process.env.CLEANUP_APPLY === "true") return "apply";
  return "dry-run";
}

export default async function cleanupOrphanReservations({ container, args }: ExecArgs) {
  const mode = resolveMode(args ?? []);
  const pgConnection = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

  console.log(`\n🧹 cleanup-orphan-reservations · mode=${mode.toUpperCase()}`);
  console.log(`   ${mode === "dry-run" ? "(no changes will be written — pass --apply to execute)" : "(WRITES ENABLED)"}\n`);

  const orphansResult = await pgConnection.raw(
    `
    -- Case A: line_item_id exists in order_line_item but order is gone/deleted
    SELECT
      ri.id            AS reservation_id,
      ri.line_item_id,
      ri.inventory_item_id,
      ri.location_id,
      ri.quantity,
      pv.sku           AS variant_sku,
      CASE
        WHEN oi.id IS NULL THEN 'no order_item linkage'
        WHEN o.deleted_at IS NOT NULL THEN 'order soft-deleted'
        ELSE 'unknown'
      END              AS reason
    FROM reservation_item ri
    JOIN order_line_item oli ON oli.id = ri.line_item_id
    LEFT JOIN order_item oi ON oi.item_id = oli.id
    LEFT JOIN "order" o ON o.id = oi.order_id
    LEFT JOIN product_variant pv ON pv.id = oli.variant_id
    WHERE ri.deleted_at IS NULL
      AND (oi.id IS NULL OR o.deleted_at IS NOT NULL)

    UNION ALL

    -- Case B: line_item_id does not exist in order_line_item at all
    -- (order was edited and line items were replaced, leaving stale reservation IDs)
    SELECT
      ri.id            AS reservation_id,
      ri.line_item_id,
      ri.inventory_item_id,
      ri.location_id,
      ri.quantity,
      pv.sku           AS variant_sku,
      'line_item_id missing from order_line_item' AS reason
    FROM reservation_item ri
    LEFT JOIN product_variant_inventory_item pvii
      ON pvii.inventory_item_id = ri.inventory_item_id AND pvii.deleted_at IS NULL
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
    WHERE ri.deleted_at IS NULL
      AND ri.line_item_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM order_line_item oli WHERE oli.id = ri.line_item_id
      )

    ORDER BY reason, quantity DESC
    `,
    []
  );

  const orphans = orphansResult.rows as OrphanRow[];
  console.log(`📋 Orphan reservations found: ${orphans.length}`);
  if (orphans.length > 0) {
    const totalQty = orphans.reduce((acc, r) => acc + Number(r.quantity || 0), 0);
    console.log(`   Total qty held by orphans: ${totalQty}\n`);
    console.table(
      orphans.slice(0, 25).map(r => ({
        reservation: r.reservation_id.slice(-12),
        sku: r.variant_sku ?? "(unknown)",
        qty: Number(r.quantity),
        reason: r.reason,
      }))
    );
    if (orphans.length > 25) console.log(`   ... and ${orphans.length - 25} more`);
  }

  const driftResult = await pgConnection.raw(
    `
    WITH actual AS (
      SELECT inventory_item_id, location_id, COALESCE(SUM(quantity), 0)::int AS qty
      FROM reservation_item
      WHERE deleted_at IS NULL
        AND id NOT IN (
          SELECT ri.id
          FROM reservation_item ri
          JOIN order_line_item oli ON oli.id = ri.line_item_id
          LEFT JOIN order_item oi ON oi.item_id = oli.id
          LEFT JOIN "order" o ON o.id = oi.order_id
          WHERE ri.deleted_at IS NULL
            AND (oi.id IS NULL OR o.deleted_at IS NOT NULL)
        )
      GROUP BY inventory_item_id, location_id
    )
    SELECT
      il.inventory_item_id,
      il.location_id,
      pv.sku                                AS variant_sku,
      il.reserved_quantity::int             AS cached,
      COALESCE(actual.qty, 0)               AS actual,
      (il.reserved_quantity::int - COALESCE(actual.qty, 0)) AS delta
    FROM inventory_level il
    LEFT JOIN actual
      ON actual.inventory_item_id = il.inventory_item_id
      AND actual.location_id = il.location_id
    LEFT JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
    WHERE il.deleted_at IS NULL
      AND il.reserved_quantity::int <> COALESCE(actual.qty, 0)
    ORDER BY ABS(il.reserved_quantity::int - COALESCE(actual.qty, 0)) DESC
    `,
    []
  );

  const drift = driftResult.rows as DriftRow[];
  console.log(`\n📊 inventory_level.reserved_quantity drift rows: ${drift.length}`);
  if (drift.length > 0) {
    console.table(
      drift.slice(0, 25).map(d => ({
        sku: d.variant_sku ?? "(unknown)",
        location: d.location_id.slice(-12),
        cached: d.cached,
        actual: d.actual,
        delta: d.delta,
      }))
    );
    if (drift.length > 25) console.log(`   ... and ${drift.length - 25} more`);
  }

  const rawMirrorDriftResult = await pgConnection.raw(
    `
    SELECT
      il.location_id,
      pv.sku AS variant_sku,
      il.reserved_quantity::int AS reserved,
      il.raw_reserved_quantity->>'value' AS raw_value
    FROM inventory_level il
    LEFT JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = il.inventory_item_id
      AND pvii.deleted_at IS NULL
    LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
    WHERE il.deleted_at IS NULL
      AND COALESCE(il.raw_reserved_quantity->>'value', '') <> il.reserved_quantity::int::text
    ORDER BY il.updated_at DESC
    `,
    []
  );

  const rawMirrorDrift = rawMirrorDriftResult.rows as RawMirrorDriftRow[];
  console.log(`\n📊 raw_reserved_quantity mirror drift rows: ${rawMirrorDrift.length}`);
  if (rawMirrorDrift.length > 0) {
    console.table(
      rawMirrorDrift.slice(0, 25).map(d => ({
        sku: d.variant_sku ?? "(unknown)",
        location: d.location_id.slice(-12),
        reserved: d.reserved,
        raw: d.raw_value ?? "(null)",
      }))
    );
    if (rawMirrorDrift.length > 25) console.log(`   ... and ${rawMirrorDrift.length - 25} more`);
  }

  if (mode === "dry-run") {
    console.log(`\n✅ Dry-run complete. Run with \`yarn medusa exec ./src/scripts/admin/data_fixes/cleanup-orphan-reservations.ts apply\` (positional) or \`CLEANUP_APPLY=1 yarn medusa exec ...\` to execute.\n`);
    return;
  }

  if (orphans.length === 0 && drift.length === 0 && rawMirrorDrift.length === 0) {
    console.log(`\n✅ Nothing to fix. Database is clean.\n`);
    return;
  }

  console.log(`\n🚧 Applying changes...`);

  if (orphans.length > 0) {
    const orphanIds = orphans.map(o => o.reservation_id);
    const placeholders = orphanIds.map(() => "?").join(",");
    const result = await pgConnection.raw(
      `UPDATE reservation_item SET deleted_at = NOW(), updated_at = NOW()
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      orphanIds
    );
    console.log(`   ✓ Soft-deleted ${orphans.length} orphan reservations`);
    void result;
  }

  await pgConnection.raw(
    `
    UPDATE inventory_level il
    SET reserved_quantity = COALESCE(sub.qty, 0),
        raw_reserved_quantity = jsonb_build_object(
          'value',
          COALESCE(sub.qty, 0)::text,
          'precision',
          20
        ),
        updated_at = NOW()
    FROM (
      SELECT inventory_item_id, location_id, SUM(quantity)::int AS qty
      FROM reservation_item
      WHERE deleted_at IS NULL
      GROUP BY inventory_item_id, location_id
    ) sub
    WHERE il.inventory_item_id = sub.inventory_item_id
      AND il.location_id = sub.location_id
      AND il.deleted_at IS NULL
      AND il.reserved_quantity::int <> COALESCE(sub.qty, 0)
    `,
    []
  );

  await pgConnection.raw(
    `
    UPDATE inventory_level il
    SET reserved_quantity = 0,
        raw_reserved_quantity = jsonb_build_object(
          'value',
          '0',
          'precision',
          20
        ),
        updated_at = NOW()
    WHERE il.deleted_at IS NULL
      AND il.reserved_quantity::int <> 0
      AND NOT EXISTS (
        SELECT 1 FROM reservation_item ri
        WHERE ri.inventory_item_id = il.inventory_item_id
          AND ri.location_id = il.location_id
          AND ri.deleted_at IS NULL
      )
    `,
    []
  );

  await pgConnection.raw(
    `
    UPDATE inventory_level il
    SET raw_reserved_quantity = jsonb_build_object(
          'value',
          il.reserved_quantity::int::text,
          'precision',
          20
        ),
        updated_at = NOW()
    WHERE il.deleted_at IS NULL
      AND COALESCE(il.raw_reserved_quantity->>'value', '') <> il.reserved_quantity::int::text
    `,
    []
  );

  console.log(`   ✓ Recomputed reserved_quantity across ${drift.length} inventory_level rows`);
  console.log(`   ✓ Synced raw_reserved_quantity across ${rawMirrorDrift.length} inventory_level rows`);
  console.log(`\n✅ Cleanup complete.\n`);
}
