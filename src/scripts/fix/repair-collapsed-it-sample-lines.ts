/**
 * repair-collapsed-it-sample-lines
 *
 * Repairs the two inventory transfers whose Sample-Product lines were
 * collapsed by the variant-keyed PO↔IT mirror (fixed in the same change that
 * ships this script). The migration backfill deliberately skips these rows —
 * they are ambiguous by variant — so this script assigns identity explicitly:
 *
 *   IT-1045 (shipped, PO-1138): the surviving row was last overwritten with
 *     qty 2 @ $1.75 and a bare description. It becomes PO line
 *     pol_01KZP44GTC… (qty 5 @ $15.10); the second PO line pol_01KZPFA5FA…
 *     (qty 2 @ $27.00) gets a fresh IT line. Header recomputed and China
 *     reservations rebuilt (live reservation is 2 units, must be 7).
 *
 *   IT-1036 (received, PO-1087): record-only. China stock was decremented
 *     correctly on receive (onPoReceiveApplied iterates PO lines, not IT
 *     lines) and all reservations are released, so the only damage is the
 *     missing line. Insert it already-received (qty 1, qty_received 1) and
 *     claim the surviving row's FK. No stock or reservation writes.
 *
 * DRY-RUN by default; APPLY=true writes, in one transaction, asserting the
 * expected post-state before commit.
 *
 * Run: env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *        ./node_modules/.bin/tsx src/scripts/fix/repair-collapsed-it-sample-lines.ts
 */

import knexFactory from "knex";
import { generateEntityId } from "@medusajs/utils";

import { rebuildTransferChinaReservations } from "../../lib/inventory-transfer-reservations";

const SAMPLE_VARIANT = "variant_01KK53MV2GRQ68T3BR0JXYQSZN";
const SAMPLE_IITEM = "iitem_01KK5EV03BXC3J66YXH8HCV6AJ";

const IT_1045 = "it_01KZAGC4WV138BFSQ8FFYTA8NK";
const PO_1138 = "po_01KZ7ETG6YWCZKG6ZZW946K1AC";
const ITL_1045_SURVIVOR = "itl_01KZP44GTWDSNS11CCKYJ8Q9AE";
const POL_1138_A = "pol_01KZP44GTC2DF4EK71G8CNNSGV"; // qty 5 @ 1510
const POL_1138_B = "pol_01KZPFA5FA2QVHXG2H2854H0T3"; // qty 2 @ 2700

const ITL_1036_SURVIVOR = "itl_01KWHM4YGJ69TW9F8YVQ91Y76R";
const POL_1087_KEPT = "pol_01KWW2CF1J3FVBKCCGQZCK98YM"; // qty 1 @ 2700 (matches survivor)
const POL_1087_MISSING = "pol_01KWA27VZNM0X5JHQNTRGEY89M"; // qty 1 @ 1510

type Raw = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

interface PoLineRow {
  id: string;
  product_variant_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_ordered: number;
  qty_cancelled: number;
  unit_cost_cents: number;
}

async function one<T>(db: Raw, sql: string, bindings: unknown[]): Promise<T | undefined> {
  const r = await db.raw(sql, bindings);
  return r.rows[0] as T | undefined;
}

async function loadPoLine(db: Raw, id: string): Promise<PoLineRow> {
  const row = await one<PoLineRow>(
    db,
    `SELECT id, product_variant_id, sku_snapshot, description_snapshot,
            qty_ordered, qty_cancelled, unit_cost_cents
       FROM purchase_order_line WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  if (!row) throw new Error(`Precondition failed: PO line ${id} missing/deleted`);
  return row;
}

async function recomputeHeader(db: Raw, transferId: string): Promise<void> {
  await db.raw(
    `UPDATE inventory_transfer AS it
        SET total_lines = agg.c, total_units = agg.u, subtotal_cents = agg.s,
            updated_at = NOW()
       FROM (
         SELECT COUNT(*) AS c, COALESCE(SUM(qty), 0) AS u,
                COALESCE(SUM(qty * unit_cost_cents), 0) AS s
           FROM inventory_transfer_line
          WHERE transfer_id = ? AND deleted_at IS NULL
       ) AS agg
      WHERE it.id = ?`,
    [transferId, transferId]
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const apply = process.env.APPLY === "true";

  const knex = knexFactory({ client: "pg", connection: url });

  try {
    // ── Preconditions + snapshot ─────────────────────────────────────────
    const survivor1045 = await one<{ qty: number; unit_cost_cents: number }>(
      knex,
      `SELECT qty, unit_cost_cents FROM inventory_transfer_line
        WHERE id = ? AND transfer_id = ? AND product_variant_id = ? AND deleted_at IS NULL`,
      [ITL_1045_SURVIVOR, IT_1045, SAMPLE_VARIANT]
    );
    if (!survivor1045 || Number(survivor1045.qty) !== 2) {
      throw new Error(
        `Precondition failed: IT-1045 survivor line not found or qty !== 2 (got ${JSON.stringify(survivor1045)})`
      );
    }
    const sampleCount1045 = await one<{ cnt: number }>(
      knex,
      `SELECT COUNT(*)::int AS cnt FROM inventory_transfer_line
        WHERE transfer_id = ? AND product_variant_id = ? AND deleted_at IS NULL`,
      [IT_1045, SAMPLE_VARIANT]
    );
    if (Number(sampleCount1045?.cnt) !== 1) {
      throw new Error(`Precondition failed: expected exactly 1 live sample line on IT-1045, got ${sampleCount1045?.cnt}`);
    }
    const survivor1036 = await one<{ transfer_id: string; qty: number; qty_received: number }>(
      knex,
      `SELECT transfer_id, qty, qty_received FROM inventory_transfer_line
        WHERE id = ? AND product_variant_id = ? AND deleted_at IS NULL`,
      [ITL_1036_SURVIVOR, SAMPLE_VARIANT]
    );
    if (!survivor1036 || Number(survivor1036.qty) !== 1 || Number(survivor1036.qty_received) !== 1) {
      throw new Error(
        `Precondition failed: IT-1036 survivor line not found or not qty 1 received 1 (got ${JSON.stringify(survivor1036)})`
      );
    }
    const it1036Id = survivor1036.transfer_id;

    const polA = await loadPoLine(knex, POL_1138_A);
    const polB = await loadPoLine(knex, POL_1138_B);
    const polKept = await loadPoLine(knex, POL_1087_KEPT);
    const polMissing = await loadPoLine(knex, POL_1087_MISSING);
    if (polA.qty_ordered !== 5 || polA.unit_cost_cents !== 1510)
      throw new Error(`Precondition failed: ${POL_1138_A} is not qty 5 @ 1510`);
    if (polB.qty_ordered !== 2 || polB.unit_cost_cents !== 2700)
      throw new Error(`Precondition failed: ${POL_1138_B} is not qty 2 @ 2700`);
    if (polMissing.qty_ordered !== 1 || polMissing.unit_cost_cents !== 1510)
      throw new Error(`Precondition failed: ${POL_1087_MISSING} is not qty 1 @ 1510`);

    const colProbe = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'inventory_transfer_line'
          AND column_name = 'purchase_order_line_id'`,
      []
    );
    const hasFkColumn = colProbe.rows.length > 0;
    const fkCol = hasFkColumn
      ? "purchase_order_line_id"
      : "NULL AS purchase_order_line_id";

    const snapshot = {
      it_1045_lines: (
        await knex.raw(
          `SELECT id, ${fkCol}, qty, qty_received, unit_cost_cents, sku, description
             FROM inventory_transfer_line WHERE transfer_id = ? AND deleted_at IS NULL ORDER BY created_at`,
          [IT_1045]
        )
      ).rows,
      it_1036_lines: (
        await knex.raw(
          `SELECT id, ${fkCol}, qty, qty_received, unit_cost_cents, sku, description
             FROM inventory_transfer_line WHERE transfer_id = ? AND deleted_at IS NULL ORDER BY created_at`,
          [it1036Id]
        )
      ).rows,
      headers: (
        await knex.raw(
          `SELECT id, number, status, total_lines, total_units, subtotal_cents
             FROM inventory_transfer WHERE id IN (?, ?)`,
          [IT_1045, it1036Id]
        )
      ).rows,
      sample_reservations: (
        await knex.raw(
          `SELECT id, quantity, metadata->>'inventory_transfer_id' AS transfer
             FROM reservation_item
            WHERE inventory_item_id = ? AND deleted_at IS NULL`,
          [SAMPLE_IITEM]
        )
      ).rows,
      sample_china_level: (
        await knex.raw(
          `SELECT location_id, stocked_quantity, reserved_quantity
             FROM inventory_level WHERE inventory_item_id = ? AND deleted_at IS NULL`,
          [SAMPLE_IITEM]
        )
      ).rows,
    };
    console.log("SNAPSHOT BEFORE:\n" + JSON.stringify(snapshot, null, 2));

    const writeSet = [
      `IT-1045 UPDATE ${ITL_1045_SURVIVOR}: qty 2→5, cost 175→1510, desc → PO line A, FK → ${POL_1138_A}`,
      `IT-1045 INSERT new line: FK ${POL_1138_B}, qty 2 @ 2700, desc from PO line B`,
      `IT-1045 header recompute (expect 15 lines / 323 units)`,
      `IT-1045 rebuildTransferChinaReservations (expect sample reservation 2→7)`,
      `IT-1036 UPDATE ${ITL_1036_SURVIVOR}: FK → ${POL_1087_KEPT} (data already matches)`,
      `IT-1036 INSERT new line: FK ${POL_1087_MISSING}, qty 1 received 1 @ 1510 (record-only)`,
      `IT-1036 header recompute (expect 15 lines / 273 units)`,
    ];
    console.log("\nWRITE SET:\n" + writeSet.map((w) => `  - ${w}`).join("\n"));

    if (!apply) {
      console.log("\nDRY-RUN (set APPLY=true to write). No changes made.");
      return;
    }
    if (!hasFkColumn) {
      throw new Error(
        "APPLY refused: purchase_order_line_id column missing — deploy the migration first"
      );
    }

    // ── Apply ────────────────────────────────────────────────────────────
    await knex.transaction(async (trx) => {
      // IT-1045
      await trx.raw(
        `UPDATE inventory_transfer_line
            SET qty = ?, unit_cost_cents = ?, sku = ?, description = ?,
                purchase_order_line_id = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [
          polA.qty_ordered,
          polA.unit_cost_cents,
          polA.sku_snapshot,
          polA.description_snapshot,
          POL_1138_A,
          ITL_1045_SURVIVOR,
        ]
      );
      await trx.raw(
        `INSERT INTO inventory_transfer_line (
            id, transfer_id, purchase_order_line_id, product_variant_id,
            sku, description, qty, unit_cost_cents, qty_received, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
        [
          generateEntityId("", "itl"),
          IT_1045,
          POL_1138_B,
          polB.product_variant_id,
          polB.sku_snapshot,
          polB.description_snapshot,
          polB.qty_ordered,
          polB.unit_cost_cents,
        ]
      );
      await recomputeHeader(trx, IT_1045);
      await rebuildTransferChinaReservations(trx, IT_1045, PO_1138);

      // IT-1036 — record-only
      await trx.raw(
        `UPDATE inventory_transfer_line
            SET purchase_order_line_id = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [POL_1087_KEPT, ITL_1036_SURVIVOR]
      );
      await trx.raw(
        `INSERT INTO inventory_transfer_line (
            id, transfer_id, purchase_order_line_id, product_variant_id,
            sku, description, qty, unit_cost_cents, qty_received, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          generateEntityId("", "itl"),
          it1036Id,
          POL_1087_MISSING,
          polMissing.product_variant_id,
          polMissing.sku_snapshot,
          polMissing.description_snapshot,
          polMissing.qty_ordered,
          polMissing.unit_cost_cents,
          polMissing.qty_ordered, // already received — record correction only
        ]
      );
      await recomputeHeader(trx, it1036Id);

      // ── Post-state assertions (rollback on mismatch) ───────────────────
      const h1045 = await one<{ total_lines: number; total_units: number }>(
        trx,
        `SELECT total_lines, total_units FROM inventory_transfer WHERE id = ?`,
        [IT_1045]
      );
      if (Number(h1045?.total_lines) !== 15 || Number(h1045?.total_units) !== 323) {
        throw new Error(`Post-state failed: IT-1045 header ${JSON.stringify(h1045)}, expected 15/323`);
      }
      const h1036 = await one<{ total_lines: number; total_units: number }>(
        trx,
        `SELECT total_lines, total_units FROM inventory_transfer WHERE id = ?`,
        [it1036Id]
      );
      if (Number(h1036?.total_lines) !== 15 || Number(h1036?.total_units) !== 273) {
        throw new Error(`Post-state failed: IT-1036 header ${JSON.stringify(h1036)}, expected 15/273`);
      }
      const res = await one<{ total: number }>(
        trx,
        `SELECT COALESCE(SUM(quantity), 0)::int AS total FROM reservation_item
          WHERE inventory_item_id = ? AND deleted_at IS NULL
            AND metadata->>'inventory_transfer_id' = ?`,
        [SAMPLE_IITEM, IT_1045]
      );
      if (Number(res?.total) !== 7) {
        throw new Error(`Post-state failed: IT-1045 sample reservation total ${res?.total}, expected 7`);
      }
    });

    console.log("\nAPPLIED. Post-state:");
    const post = {
      headers: (
        await knex.raw(
          `SELECT number, total_lines, total_units, subtotal_cents FROM inventory_transfer WHERE id IN (?, ?)`,
          [IT_1045, it1036Id]
        )
      ).rows,
      sample_reservations: (
        await knex.raw(
          `SELECT quantity, metadata->>'inventory_transfer_id' AS transfer FROM reservation_item
            WHERE inventory_item_id = ? AND deleted_at IS NULL`,
          [SAMPLE_IITEM]
        )
      ).rows,
      sample_china_level: (
        await knex.raw(
          `SELECT location_id, stocked_quantity, reserved_quantity FROM inventory_level
            WHERE inventory_item_id = ? AND deleted_at IS NULL`,
          [SAMPLE_IITEM]
        )
      ).rows,
    };
    console.log(JSON.stringify(post, null, 2));
  } finally {
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
