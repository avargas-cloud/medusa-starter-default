/**
 * verify-skydance-fo-parity.ts
 *
 * The invariant behind the Skydance Factory Order rebuild.
 *
 * GROUND TRUTH (owner, 2026-08-19): there is NO controller inventory sitting in
 * the China warehouse. Every ECTSK unit that arrives is shipped straight out on
 * a transfer. The "Cantidad Original" balances the ledger derives were estimates
 * made before anyone had the real figure, which is why they never reconciled.
 *
 * So the state each ECTSK SKU must land on is:
 *
 *   On Hand (stocked_quantity at CHINA)          = 0        ← always
 *   reserved                                     = committed + in transit
 *   Available  = stocked − reserved              = −(committed + in transit)
 *   INV China  = available + committed + transit = 0
 *
 * `committed` and `in transit` are the same units at two stages of the same
 * journey: a transfer that is CONFIRMED has taken them off the shelf but not
 * left China; once it SHIPS they become in transit. Both hold a reservation,
 * so both belong on the right-hand side.
 *
 * A SKU with nothing at sea reads 0 across the board. A SKU with X at sea reads
 * Available −X and In Transit X, which is the normal mid-cycle state: the goods
 * left the shelf and the Factory Order that documents them is still a draft,
 * waiting for someone to verify the shipment in Miami. Receiving the transfer
 * and confirming that FO closes the cycle back to 0.
 *
 * WHAT THIS SCRIPT IS FOR
 * Run it before the rebuild to see the damage, and after to prove the fix. It
 * reads nothing but the truth of the tables — it does not call the rebuild's own
 * code, so it cannot agree with a bug by sharing it.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-skydance-fo-parity.ts
 */

import { Client } from "pg";

const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";
const SKU_PREFIX = "ECTSK";

interface SkuRow {
  sku: string;
  stocked: number;
  reserved: number;
  /** Units on a CONFIRMED transfer that has not shipped yet — the POS shows these as COMMITTED. */
  committed: number;
  /** Units on a SHIPPED transfer that Miami has not received — the POS shows these as IN TRANSIT. */
  in_transit: number;
}

interface UnlinkedFoRow {
  number: string;
  status: string;
  ectsk_lines: number;
  total_lines: number;
}

interface PoRow {
  po: string;
  it: string;
  it_received: string | null;
  fo: string | null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();

  let failures = 0;
  const fail = (msg: string) => {
    failures++;
    console.error(`✗ ${msg}`);
  };

  try {
    // ── 1. On Hand must be 0 for every controller ────────────────────────
    const levels = await client.query<SkuRow>(
      // Two buckets, because BOTH hold a reservation against China and the POS
      // shows them in separate columns:
      //   COMMITTED  — transfer confirmed, still on the shelf, not shipped yet
      //   IN TRANSIT — transfer shipped, Miami has not received it
      // Splitting them is not cosmetic: an operator confirming tomorrow's
      // shipment moves units from neither bucket into COMMITTED, and a check
      // that only knew about shipped transfers reported every one of those as
      // an orphan reservation. It did, on 2026-08-19, for 10 SKUs — IT-1048,
      // confirmed 19:46 UTC, an ordinary day's work — while the data was
      // perfectly consistent. A verifier that cries wolf on normal operations
      // gets ignored, and then it is not a verifier.
      `WITH moving AS (
         SELECT pv.id AS variant_id,
                SUM(CASE WHEN it.shipped_at IS NULL
                         THEN GREATEST(0, l.qty - COALESCE(l.qty_received, 0))
                         ELSE 0 END)::int AS committed,
                SUM(CASE WHEN it.shipped_at IS NOT NULL
                         THEN GREATEST(0, l.qty - COALESCE(l.qty_received, 0))
                         ELSE 0 END)::int AS in_transit
           FROM inventory_transfer_line l
           JOIN inventory_transfer it ON it.id = l.transfer_id
           JOIN product_variant pv ON pv.id = l.product_variant_id
          WHERE l.deleted_at IS NULL AND it.deleted_at IS NULL
            AND it.voided_at IS NULL AND it.received_at IS NULL
            AND it.status IN ('confirmed', 'shipped')
          GROUP BY pv.id
       )
       SELECT pv.sku,
              il.stocked_quantity::int  AS stocked,
              il.reserved_quantity::int AS reserved,
              COALESCE(m.committed, 0)  AS committed,
              COALESCE(m.in_transit, 0) AS in_transit
         FROM inventory_level il
         JOIN product_variant_inventory_item pvii
           ON pvii.inventory_item_id = il.inventory_item_id AND pvii.deleted_at IS NULL
         JOIN product_variant pv ON pv.id = pvii.variant_id
         LEFT JOIN moving m ON m.variant_id = pv.id
        WHERE il.location_id = $1 AND il.deleted_at IS NULL
          AND pv.sku LIKE $2 || '%'
        ORDER BY pv.sku`,
      [CHINA_LOC, SKU_PREFIX]
    );

    const offenders = levels.rows.filter((r) => r.stocked !== 0);
    if (offenders.length > 0) {
      fail(`${offenders.length} controller SKU(s) with On Hand ≠ 0:`);
      for (const r of offenders) {
        console.error(
          `    ${r.sku.padEnd(20)} On Hand ${String(r.stocked).padStart(5)} · ` +
            `reserved ${r.reserved} · in transit ${r.in_transit}`
        );
      }
    } else {
      console.log(`✓ All ${levels.rows.length} controller SKUs sit at On Hand 0`);
    }

    // ── 2. reserved must equal what is actually at sea ────────────────────
    // Not cosmetic: `Available` is `stocked − reserved`, so a stale reservation
    // invents a shortfall the transfers do not explain — and with On Hand at 0
    // it is the ONLY thing that can move Available.
    const mismatched = levels.rows.filter(
      (r) => r.reserved !== r.committed + r.in_transit
    );
    if (mismatched.length > 0) {
      fail(`${mismatched.length} SKU(s) whose reserved ≠ committed + in transit:`);
      for (const r of mismatched) {
        console.error(
          `    ${r.sku.padEnd(20)} reserved ${r.reserved} vs ` +
            `${r.committed} committed + ${r.in_transit} in transit = ${r.committed + r.in_transit}`
        );
      }
    } else {
      const moving = levels.rows.filter((r) => r.committed + r.in_transit > 0);
      console.log(
        `✓ Every reservation is explained by a live transfer ` +
          `(${moving.length} SKU(s) moving: ` +
          `${moving.reduce((s, r) => s + r.committed, 0)} committed, ` +
          `${moving.reduce((s, r) => s + r.in_transit, 0)} in transit)`
      );
    }

    // ── 3. No manual (PO-less) Factory Order may remain with ECTSK lines ──
    const unlinked = await client.query<UnlinkedFoRow>(
      `SELECT fo.number, fo.status,
              COUNT(*) FILTER (WHERE fol.sku_snapshot LIKE $1 || '%')::int AS ectsk_lines,
              COUNT(*)::int AS total_lines
         FROM factory_order fo
         JOIN factory_order_line fol
           ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL
        WHERE fo.linked_purchase_order_id IS NULL
          AND fo.deleted_at IS NULL AND fo.voided_at IS NULL
        GROUP BY fo.id, fo.number, fo.status
       HAVING COUNT(*) FILTER (WHERE fol.sku_snapshot LIKE $1 || '%') > 0
        ORDER BY fo.number`,
      [SKU_PREFIX]
    );
    if (unlinked.rows.length > 0) {
      fail(`${unlinked.rows.length} Factory Order(s) with ECTSK lines and no PO:`);
      for (const r of unlinked.rows) {
        console.error(
          `    ${r.number} [${r.status}] ${r.ectsk_lines}/${r.total_lines} ECTSK lines`
        );
      }
    } else {
      console.log("✓ No controller Factory Order is left unattached to a PO");
    }

    // ── 4. Every shipped PO carrying ECTSK must have its mirrored FO ──────
    // This is the process gap the whole rebuild exists to close: the Skydance
    // button was used on 1 of 9 shipments, and the missing documents are what
    // let the deficits appear.
    const pos = await client.query<PoRow>(
      `SELECT po.number AS po, it.number AS it,
              to_char(it.received_at, 'YYYY-MM-DD') AS it_received,
              fo.number AS fo
         FROM purchase_order po
         JOIN inventory_transfer it
           ON it.linked_purchase_order_id = po.id
          AND it.deleted_at IS NULL AND it.voided_at IS NULL
          AND it.shipped_at IS NOT NULL
         LEFT JOIN LATERAL (
           -- LATERAL, not a plain LEFT JOIN: a rebuild leaves the OLD document
           -- soft-deleted under the same number as the new one, so a join on
           -- linked_purchase_order_id alone matches both rows and the live one
           -- gets lost among duplicates. Pick exactly the surviving document.
           SELECT f.number
             FROM factory_order f
            WHERE f.linked_purchase_order_id = po.id
              AND f.deleted_at IS NULL AND f.voided_at IS NULL
            ORDER BY f.created_at DESC
            LIMIT 1
         ) fo ON true
        WHERE po.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM purchase_order_line pol
             WHERE pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
               AND pol.sku_snapshot LIKE $1 || '%'
          )
        ORDER BY it.shipped_at`,
      [SKU_PREFIX]
    );
    const missingFo = pos.rows.filter((r) => !r.fo);
    if (missingFo.length > 0) {
      fail(`${missingFo.length} shipped PO(s) with ECTSK lines and no mirrored FO:`);
      for (const r of missingFo) {
        console.error(
          `    ${r.po} → ${r.it} (${r.it_received ?? "in transit"})`
        );
      }
    } else {
      console.log(`✓ All ${pos.rows.length} shipped ECTSK POs carry a mirrored FO`);
    }
  } finally {
    await client.end();
  }

  if (failures > 0) {
    console.error(`\nFAIL — ${failures} invariant(s) broken`);
    process.exit(1);
  }
  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
