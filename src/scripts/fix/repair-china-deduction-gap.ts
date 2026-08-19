/**
 * repair-china-deduction-gap
 *
 * Repairs the state left behind by `onPoReceiveApplied`'s old `["shipped"]`
 * gate: a PO that kept receiving after its inventory transfer closed returned
 * early, so China stock was never debited, the transfer's China reservation was
 * never released, and qty_received was never bumped.
 *
 * TWO KINDS OF WORK, DELIBERATELY SEPARATE
 *
 *   STOCK  — units that physically left China and were never debited. Real
 *            inventory movement. Four lines, 56 units, audited 2026-08-19.
 *   RECORD — qty_received on transfer lines that under-report what their PO
 *            actually received. Moves no stock; makes the document stop lying.
 *            Includes lines a 2026-07-17 backfill created on already-received
 *            transfers with qty_received = 0.
 *
 * Run STOCK without RECORD, or the reverse, or both. Nothing is inferred: the
 * stock set is a hard-coded manifest, because a query that decides on its own
 * which units to debit is a query that can debit twice.
 *
 * All arithmetic goes through `moveChinaStock` / the reservation helpers — the
 * same code the receive path uses — so the numeric column and its raw_ BigNumber
 * twin always move together. Never raw single-column SQL.
 *
 * DRY RUN BY DEFAULT. With APPLY unset it opens a transaction, performs every
 * write, re-reads the resulting state, prints it, and ROLLS BACK. That preview
 * is also the mutation test for verify-china-deduction-parity: the checks are
 * evaluated inside the transaction and must flip to clean.
 *
 * Run:
 *   env DISABLE_SCHEDULED_JOBS=true \
 *       DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/fix/repair-china-deduction-gap.ts
 *   ... add APPLY=true to commit.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { moveChinaStock } from "../../lib/inventory-transfer-link";
import { releaseTransferChinaReservations } from "../../lib/inventory-transfer-reservations";
import { CHINA_LOC } from "../../lib/locations";

type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

/**
 * A knex instance, narrowed to what this script uses. `transaction()` matters:
 * `raw("BEGIN")` on the pool acquires a connection and releases it, so the
 * statements that follow can land on a DIFFERENT connection — the dry run would
 * announce a rollback while the writes committed. Every statement below runs on
 * the same `trx`.
 */
type KnexWithTx = KnexRaw & {
  transaction: <T>(fn: (trx: KnexRaw) => Promise<T>) => Promise<T>;
};

/** Thrown to unwind a successful dry run; knex rolls back on any throw. */
class DryRunRollback extends Error {
  constructor() {
    super("dry run");
  }
}

/**
 * The stock manifest. Every row is a receipt line whose China debit was
 * swallowed by the early return, identified by receipt number + SKU so the
 * script fails loudly rather than guessing if production has moved.
 */
const STOCK_MANIFEST: Array<{
  receipt: string;
  transfer: string;
  sku: string;
  units: number;
}> = [
  { receipt: "RCP-1106", transfer: "IT-1034", sku: "ECTSK-RFRC1C15A", units: 15 },
  { receipt: "RCP-1142", transfer: "IT-1037", sku: "ESPS9R4N50W0430", units: 1 },
  { receipt: "RCP-1198", transfer: "IT-1043", sku: "ESPCA3R4N70W10RG", units: 10 },
  { receipt: "RCP-1198", transfer: "IT-1043", sku: "ECTSK-RFRC1C5A", units: 30 },
];

interface ManifestResolution {
  receipt: string;
  sku: string;
  units: number;
  inventory_item_id: string;
  receipt_units: number;
}

async function resolveManifest(knex: KnexRaw): Promise<ManifestResolution[]> {
  const resolved: ManifestResolution[] = [];
  for (const entry of STOCK_MANIFEST) {
    const res = await knex.raw(
      `SELECT rl.inventory_item_id, rl.qty_received_now::int AS receipt_units
         FROM purchase_order_receipt_line rl
         JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
        WHERE r.number = ? AND rl.sku_snapshot = ?
          AND rl.deleted_at IS NULL AND r.deleted_at IS NULL
          AND r.status = 'applied'`,
      [entry.receipt, entry.sku]
    );
    const rows = res.rows as Array<{
      inventory_item_id: string;
      receipt_units: number;
    }>;
    if (rows.length !== 1) {
      throw new Error(
        `${entry.receipt}/${entry.sku}: expected exactly 1 applied receipt line, found ${rows.length}. ` +
          `Production no longer matches the audited manifest — re-audit before repairing.`
      );
    }
    if (Number(rows[0].receipt_units) !== entry.units) {
      throw new Error(
        `${entry.receipt}/${entry.sku}: receipt says ${rows[0].receipt_units} units, manifest says ${entry.units}. ` +
          `Re-audit before repairing.`
      );
    }
    resolved.push({ ...entry, ...rows[0] });
  }
  return resolved;
}

async function chinaLevels(
  knex: KnexRaw,
  inventoryItemIds: string[]
): Promise<Map<string, { stocked: number; reserved: number }>> {
  const out = new Map<string, { stocked: number; reserved: number }>();
  if (inventoryItemIds.length === 0) return out;
  const res = await knex.raw(
    `SELECT inventory_item_id, stocked_quantity::int AS stocked,
            reserved_quantity::int AS reserved
       FROM inventory_level
      WHERE location_id = ? AND deleted_at IS NULL
        AND inventory_item_id = ANY(?)`,
    [CHINA_LOC, inventoryItemIds]
  );
  for (const r of res.rows as Array<{
    inventory_item_id: string;
    stocked: number;
    reserved: number;
  }>) {
    out.set(r.inventory_item_id, { stocked: r.stocked, reserved: r.reserved });
  }
  return out;
}

export default async function repairChinaDeductionGap({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const apply = process.env.APPLY === "true";
  const doStock = process.env.SKIP_STOCK !== "true";
  const doRecord = process.env.SKIP_RECORD !== "true";
  const doMirror = process.env.SKIP_MIRROR !== "true";

  const knex = container.resolve("__pg_connection__") as KnexWithTx;

  console.log(
    `repair-china-deduction-gap — ${apply ? "APPLY (writes commit)" : "DRY RUN (rolls back)"}` +
      ` · stock=${doStock} mirror=${doMirror} record=${doRecord}\n`
  );

  const resolved = doStock ? await resolveManifest(knex) : [];
  const itemIds = resolved.map((r) => r.inventory_item_id);
  const before = await chinaLevels(knex, itemIds);

  try {
    await knex.transaction(async (trx) => {
    // ── STOCK ────────────────────────────────────────────────────────────
    if (doStock) {
      const now = new Date().toISOString();
      for (const row of resolved) {
        const rows = await moveChinaStock(trx, row.inventory_item_id, -row.units, now);
        if (rows !== 1) {
          throw new Error(
            `${row.receipt}/${row.sku}: moveChinaStock touched ${rows} rows (expected 1) — no China level?`
          );
        }
        console.log(`  stock  ${row.receipt} ${row.sku.padEnd(18)} −${row.units}`);
      }

      // Release reservations still held by the repaired transfers. Scoped by
      // transfer id, so a sibling transfer's reservation on the same SKU
      // (IT-1045 holds 26 of ECTSK-RFRC1C5A) is never touched.
      const transfers = Array.from(new Set(STOCK_MANIFEST.map((m) => m.transfer)));
      for (const number of transfers) {
        const res = await trx.raw(
          `SELECT id, status FROM inventory_transfer
            WHERE number = ? AND deleted_at IS NULL`,
          [number]
        );
        const transfer = res.rows[0] as { id: string; status: string } | undefined;
        if (!transfer) throw new Error(`${number}: transfer not found`);
        if (transfer.status !== "received") {
          throw new Error(
            `${number}: status is '${transfer.status}', expected 'received' — re-audit before repairing.`
          );
        }
        const touched = await releaseTransferChinaReservations(trx, transfer.id);
        if (touched.length > 0) {
          console.log(`  resv   ${number} released ${touched.length} reservation(s)`);
        }
      }
    }

    // ── MIRROR ───────────────────────────────────────────────────────────
    //
    // The PO→IT mirror skipped PO-1129 entirely while IT-1043 was 'received':
    // a 10→20 raise never landed, and a whole 30-unit line was never created.
    // Runs BEFORE the RECORD pass, which caps qty_received at the line's qty —
    // reversed, the raised line would be capped at its stale 10.
    //
    // Deliberately NOT a generic re-mirror of every linked PO: that would be a
    // second implementation of the route's mirror, free to disagree with it.
    // This backfills the one transfer the outage stranded; from here the fixed
    // route owns the job.
    if (doMirror) {
      const mirrored = await trx.raw(
        `WITH target AS (
           SELECT it.id AS transfer_id, pol.id AS pol_id, pol.product_variant_id,
                  pol.sku_snapshot, pol.description_snapshot, pol.unit_cost_cents,
                  (pol.qty_ordered - pol.qty_cancelled) AS po_qty
             FROM purchase_order po
             JOIN inventory_transfer it
               ON it.linked_purchase_order_id = po.id
              AND it.deleted_at IS NULL AND it.voided_at IS NULL
             JOIN purchase_order_line pol
               ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
            WHERE po.number = 'PO-1129'
         ),
         fixed_qty AS (
           UPDATE inventory_transfer_line itl
              SET qty = t.po_qty, unit_cost_cents = t.unit_cost_cents,
                  sku = t.sku_snapshot, description = t.description_snapshot,
                  updated_at = NOW()
             FROM target t
            WHERE itl.purchase_order_line_id = t.pol_id
              AND itl.transfer_id = t.transfer_id
              AND itl.deleted_at IS NULL
              AND itl.qty <> t.po_qty
            RETURNING itl.sku, itl.qty
         ),
         added AS (
           INSERT INTO inventory_transfer_line (
             id, transfer_id, purchase_order_line_id, product_variant_id,
             sku, description, qty, qty_received, unit_cost_cents,
             created_at, updated_at
           )
           SELECT 'itl_' || replace(gen_random_uuid()::text, '-', ''),
                  t.transfer_id, t.pol_id, t.product_variant_id,
                  t.sku_snapshot, t.description_snapshot, t.po_qty, 0,
                  t.unit_cost_cents, NOW(), NOW()
             FROM target t
            WHERE NOT EXISTS (
              SELECT 1 FROM inventory_transfer_line x
               WHERE x.transfer_id = t.transfer_id
                 AND x.purchase_order_line_id = t.pol_id
                 AND x.deleted_at IS NULL
            )
            RETURNING sku, qty
         )
         SELECT 'qty' AS kind, sku, qty FROM fixed_qty
         UNION ALL
         SELECT 'new' AS kind, sku, qty FROM added`,
        []
      );
      for (const r of mirrored.rows as Array<{ kind: string; sku: string; qty: number }>) {
        console.log(`  mirror ${r.kind === "new" ? "added " : "requal"} ${r.sku.padEnd(18)} qty ${r.qty}`);
      }

      // Header totals follow the lines, same recomputation the route runs.
      await trx.raw(
        `UPDATE inventory_transfer AS it
            SET total_lines = agg.c, total_units = agg.u,
                subtotal_cents = agg.s, updated_at = NOW()
           FROM (
             SELECT COUNT(*) AS c, COALESCE(SUM(qty),0) AS u,
                    COALESCE(SUM(qty * unit_cost_cents),0) AS s
               FROM inventory_transfer_line
              WHERE transfer_id = (SELECT id FROM inventory_transfer WHERE number = 'IT-1043')
                AND deleted_at IS NULL
           ) AS agg
          WHERE it.number = 'IT-1043'`,
        []
      );
    }

    // ── RECORD ───────────────────────────────────────────────────────────
    if (doRecord) {
      // Bring qty_received up to what the PO actually received, capped at the
      // line's own qty. Never lowers a value: GREATEST keeps a line that
      // already records more than the receipts explain.
      const rec = await trx.raw(
        `WITH po_received AS (
           SELECT rl.purchase_order_line_id AS pol_id,
                  SUM(rl.qty_received_now)  AS units
             FROM purchase_order_receipt_line rl
             JOIN purchase_order_receipt r
               ON r.id = rl.purchase_order_receipt_id
              AND r.deleted_at IS NULL AND r.status = 'applied'
            WHERE rl.deleted_at IS NULL
            GROUP BY rl.purchase_order_line_id
         )
         UPDATE inventory_transfer_line itl
            SET qty_received = GREATEST(itl.qty_received, LEAST(pr.units, itl.qty)),
                updated_at   = NOW()
           FROM po_received pr
           JOIN inventory_transfer_line src ON src.purchase_order_line_id = pr.pol_id
          WHERE itl.id = src.id
            AND itl.deleted_at IS NULL
            AND LEAST(pr.units, itl.qty) > itl.qty_received
          RETURNING itl.id, itl.sku, itl.qty, itl.qty_received`,
        []
      );
      const updated = rec.rows as Array<{ sku: string; qty: number; qty_received: number }>;
      for (const r of updated) {
        console.log(`  record ${r.sku.padEnd(18)} qty_received → ${r.qty_received}/${r.qty}`);
      }
      console.log(`  record ${updated.length} transfer line(s) corrected`);
    }

    // ── Resulting state ──────────────────────────────────────────────────
    const after = await chinaLevels(trx, itemIds);
    console.log("\nChina levels (stocked / reserved):");
    for (const row of resolved) {
      const b = before.get(row.inventory_item_id);
      const a = after.get(row.inventory_item_id);
      console.log(
        `  ${row.sku.padEnd(18)} ${b?.stocked}/${b?.reserved}  →  ${a?.stocked}/${a?.reserved}`
      );
    }

      // Evaluated INSIDE the transaction, on the repaired state. This is what
      // makes the dry run a mutation test rather than a preview: if the repair
      // does not actually clear the invariants, the gate says so before a
      // single write commits.
      await reportGateState(trx);

      if (!apply) throw new DryRunRollback();
    });
    console.log("\nCOMMITTED");
  } catch (err) {
    if (err instanceof DryRunRollback) {
      console.log("\nROLLED BACK (dry run) — set APPLY=true to commit");
      return;
    }
    throw err;
  }
}

/** Re-runs the three invariants of verify-china-deduction-parity in-place. */
async function reportGateState(trx: KnexRaw): Promise<void> {
  const short = await trx.raw(
    `WITH po_received AS (
       SELECT rl.purchase_order_line_id AS pol_id, SUM(rl.qty_received_now) AS units
         FROM purchase_order_receipt_line rl
         JOIN purchase_order_receipt r ON r.id = rl.purchase_order_receipt_id
          AND r.deleted_at IS NULL AND r.status = 'applied'
        WHERE rl.deleted_at IS NULL
        GROUP BY rl.purchase_order_line_id
     )
     SELECT COUNT(*)::int AS n
       FROM inventory_transfer_line itl
       JOIN po_received pr ON pr.pol_id = itl.purchase_order_line_id
       JOIN inventory_transfer it ON it.id = itl.transfer_id
        AND it.deleted_at IS NULL AND it.voided_at IS NULL
      WHERE itl.deleted_at IS NULL
        AND LEAST(pr.units, itl.qty) > itl.qty_received`,
    []
  );
  const orphan = await trx.raw(
    `SELECT COUNT(*)::int AS n FROM reservation_item ri
       JOIN inventory_transfer it ON it.id = ri.metadata->>'inventory_transfer_id'
      WHERE ri.deleted_at IS NULL
        AND (it.status IN ('received','voided') OR it.voided_at IS NOT NULL)`,
    []
  );
  const owing = await trx.raw(
    `SELECT COUNT(DISTINCT it.id)::int AS n FROM inventory_transfer it
       JOIN inventory_transfer_line itl ON itl.transfer_id = it.id AND itl.deleted_at IS NULL
      WHERE it.status = 'received' AND it.deleted_at IS NULL AND it.voided_at IS NULL
        AND itl.qty_received < itl.qty`,
    []
  );
  const n = (r: { rows: unknown[] }) => (r.rows[0] as { n: number }).n;
  console.log("\nGate state after repair (all must be 0):");
  console.log(`  A. IT lines under-recording what the PO received : ${n(short)}`);
  console.log(`  B. China reservations held by closed transfers   : ${n(orphan)}`);
  console.log(`  C. Received transfers with units outstanding     : ${n(owing)}`);
}
