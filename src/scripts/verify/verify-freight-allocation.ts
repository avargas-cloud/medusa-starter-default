/**
 * verify-freight-allocation.ts
 *
 * Read-only DB audit of the freight-capitalization feature
 * (`vendor_bill.freight_allocation_basis`, `lib/purchase-orders/freight-policy.ts`).
 * NULL = legacy (freight stays a pure ExpenseLine — this is the byte-for-byte
 * behavior 2 already-`synced` bills depend on, $8.54 and $108.98 real QB lines).
 * Non-null = capitalized: the bill's `freight_charge` line(s) pool joins
 * `computeLandedLines` and gets folded into the product lines' landed cost.
 *
 * SANDBOX ONLY — hardcoded connection string, no prod fallback, by design
 * (this task is explicitly forbidden from touching production).
 *
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-freight-allocation.ts
 *
 * Invariant 4 deliberately does NOT call `computeLandedLines` (or any function
 * that produced the persisted data) to derive the "expected" landed total — a
 * verifier that re-uses the same engine that wrote the number would agree with
 * itself by construction, not verify anything. Instead it derives the pool
 * inputs directly from `vendor_bill`/`vendor_bill_line` (raw, un-allocated
 * money) and compares against `vendor_bill_cost_log.landed_unit_cost_cents ×
 * received_qty` — a SEPARATE artifact, written by the confirm route's AVCO
 * replay from the exact (non-lossy) `landed_total_cents` the allocation engine
 * returned, never from the lossy per-unit `vendor_bill_line.landed_unit_cost_cents`
 * this check is verifying elsewhere (invariant 3).
 */

import { Client } from "pg";

const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  console.error("\n❌ ABORTADO: este verificador es SANDBOX-ONLY (puerto 5499)\n");
  process.exit(2);
}

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  try {
    // ── 1 · Every non-null basis is one of the three valid values ────────────
    const badBasis = await db.query<{ id: string; number: string | null; freight_allocation_basis: string }>(
      `SELECT id, number, freight_allocation_basis
         FROM vendor_bill
        WHERE deleted_at IS NULL
          AND freight_allocation_basis IS NOT NULL
          AND freight_allocation_basis NOT IN ('units', 'value', 'cbm')`
    );
    check(
      `todo freight_allocation_basis no-null es 'units'|'value'|'cbm' (${badBasis.rowCount ?? 0} inválidos)`,
      (badBasis.rowCount ?? 0) === 0,
      badBasis.rows.map((r) => `${r.number ?? r.id}: '${r.freight_allocation_basis}'`).join(", ")
    );

    // ── 2 · No bill mixes the local freight_charge pool with the header/sibling
    //        pool at once — resolveFreightPolicy's fail-closed condition,
    //        checked literally against the two stored columns (not the gated
    //        `freight_included` version the confirm route reads) so this catches
    //        stale header amounts even before `freight_included` is flipped on. ──
    const mixedPools = await db.query<{ id: string; number: string | null; freight_amount_cents: number }>(
      `SELECT id, number, freight_amount_cents
         FROM vendor_bill
        WHERE deleted_at IS NULL
          AND freight_allocation_basis IS NOT NULL
          AND freight_amount_cents > 0`
    );
    check(
      `ningún bill mezcla freight_allocation_basis no-null con freight_amount_cents > 0 (${mixedPools.rowCount ?? 0})`,
      (mixedPools.rowCount ?? 0) === 0,
      mixedPools.rows.map((r) => `${r.number ?? r.id}: ${money(r.freight_amount_cents)}`).join(", ")
    );

    // ── 3 · Confirmed + capitalized: freight_charge lines are zeroed out and
    //        the raw unit_cost_cents survives ─────────────────────────────────
    const badFreightLines = await db.query<{
      bill_id: string;
      number: string | null;
      line_id: string;
      landed_unit_cost_cents: number;
      unit_cost_cents: number;
    }>(
      `SELECT vb.id AS bill_id, vb.number, vbl.id AS line_id,
              vbl.landed_unit_cost_cents, vbl.unit_cost_cents
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
        WHERE vb.deleted_at IS NULL
          AND vb.status = 'confirmed'
          AND vb.freight_allocation_basis IS NOT NULL
          AND vbl.line_kind = 'freight_charge'
          AND NOT (vbl.landed_unit_cost_cents = 0 AND vbl.unit_cost_cents > 0)`
    );
    check(
      `en todo bill CONFIRMADO capitalizado, sus líneas freight_charge tienen landed=0 y unit_cost>0 (${badFreightLines.rowCount ?? 0} mal)`,
      (badFreightLines.rowCount ?? 0) === 0,
      badFreightLines.rows
        .map((r) => `${r.number ?? r.bill_id} line ${r.line_id}: landed=${r.landed_unit_cost_cents} unit=${r.unit_cost_cents}`)
        .join(", ")
    );

    // ── 4 · Σ landed money (via vendor_bill_cost_log, a SEPARATE artifact) ────
    //        equals goods + commission + freight-pool + tariff + tax, derived
    //        here straight from vendor_bill/vendor_bill_line — no allocation
    //        engine involved. ────────────────────────────────────────────────
    const reconciliation = await db.query<{
      id: string;
      number: string | null;
      goods_cents: string;
      freight_cents: string;
      commission_cents: string;
      tariff_cents: number;
      tax_cents: number;
      logged_cents: string | null;
    }>(
      `WITH capitalized_bills AS (
         SELECT vb.id, vb.number, vb.tax_amount_cents, vb.service_vendor_bill_id,
                (CASE WHEN vb.tariff_included THEN vb.tariff_amount_cents ELSE 0 END) AS tariff_cents
           FROM vendor_bill vb
          WHERE vb.status = 'confirmed' AND vb.deleted_at IS NULL
            AND vb.freight_allocation_basis IS NOT NULL
       ),
       goods AS (
         SELECT vendor_bill_id, SUM(unit_cost_cents * qty)::bigint AS goods_cents
           FROM vendor_bill_line
          WHERE deleted_at IS NULL AND COALESCE(line_type, 'product') = 'product'
          GROUP BY vendor_bill_id
       ),
       freight_pool AS (
         SELECT vendor_bill_id, SUM(COALESCE(amount_cents, 0))::bigint AS freight_cents
           FROM vendor_bill_line
          WHERE deleted_at IS NULL AND line_kind = 'freight_charge'
          GROUP BY vendor_bill_id
       ),
       commission AS (
         SELECT cb.id AS bill_id,
                COALESCE(SUM(sl.landed_unit_cost_cents * sl.qty), 0)::bigint AS commission_cents
           FROM capitalized_bills cb
           LEFT JOIN vendor_bill sib
             ON sib.id = cb.service_vendor_bill_id AND sib.deleted_at IS NULL
            AND sib.status IN ('draft', 'confirmed', 'synced')
           LEFT JOIN vendor_bill_line sl
             ON sl.vendor_bill_id = sib.id AND sl.deleted_at IS NULL
          GROUP BY cb.id
       ),
       logged AS (
         SELECT vendor_bill_id, SUM(landed_unit_cost_cents * received_qty) AS logged_cents
           FROM vendor_bill_cost_log
          WHERE reversed_at IS NULL
          GROUP BY vendor_bill_id
       )
       SELECT cb.id, cb.number,
              COALESCE(g.goods_cents, 0)::text AS goods_cents,
              COALESCE(f.freight_cents, 0)::text AS freight_cents,
              COALESCE(c.commission_cents, 0)::text AS commission_cents,
              cb.tariff_cents,
              cb.tax_amount_cents AS tax_cents,
              l.logged_cents::text AS logged_cents
         FROM capitalized_bills cb
         LEFT JOIN goods g ON g.vendor_bill_id = cb.id
         LEFT JOIN freight_pool f ON f.vendor_bill_id = cb.id
         LEFT JOIN commission c ON c.bill_id = cb.id
         LEFT JOIN logged l ON l.vendor_bill_id = cb.id
        ORDER BY cb.number`
    );

    let landedMismatches = 0;
    const landedDetail: string[] = [];
    for (const row of reconciliation.rows) {
      const expected =
        Number(row.goods_cents) +
        Number(row.freight_cents) +
        Number(row.commission_cents) +
        Number(row.tariff_cents) +
        Number(row.tax_cents);
      const logged = row.logged_cents == null ? null : Math.round(Number(row.logged_cents));
      if (logged === null || logged !== expected) {
        landedMismatches++;
        landedDetail.push(
          `${row.number ?? row.id}: expected ${money(expected)} (goods ${money(Number(row.goods_cents))} + freight ${money(Number(row.freight_cents))} + commission ${money(Number(row.commission_cents))} + tariff ${money(Number(row.tariff_cents))} + tax ${money(Number(row.tax_cents))}), logged ${logged === null ? "NONE" : money(logged)}`
        );
      }
    }
    check(
      `Σ landed (vía vendor_bill_cost_log) = mercadería + comisión + flete + tariff + tax, al centavo, en los ${reconciliation.rowCount ?? 0} bills confirmados capitalizados`,
      landedMismatches === 0,
      landedDetail.join(" | ")
    );

    // ── 5 · Capitalized bill never carries an inherited header freight amount ─
    const inherited = await db.query<{ id: string; number: string | null; freight_amount_cents: number }>(
      `SELECT id, number, freight_amount_cents
         FROM vendor_bill
        WHERE deleted_at IS NULL
          AND status = 'confirmed'
          AND freight_allocation_basis IS NOT NULL
          AND freight_amount_cents > 0`
    );
    check(
      `ningún bill CONFIRMADO con política capitalizada arrastra freight_amount_cents heredado (${inherited.rowCount ?? 0})`,
      (inherited.rowCount ?? 0) === 0,
      inherited.rows.map((r) => `${r.number ?? r.id}: ${money(r.freight_amount_cents)}`).join(", ")
    );

    // ── 6 · No confirmed/synced product line's persisted landed cost is SHORT
    //        of its own raw unit cost while its bill has a freight pool to
    //        place. This is the exact symptom of the 2026-08-21 incident: the
    //        per-unit allocator's residual (see landed-allocation.ts) can
    //        exceed every line's qty on a high-volume/low-freight bill, and
    //        before the fix the whole pool silently vanished instead of
    //        landing on the highest-value line. This does NOT re-derive the
    //        expected landed value (that would be `computeLandedLines` trusting
    //        itself) — it only asserts landed can never be *less* than raw
    //        goods cost when there was freight money to add, which needs no
    //        allocation engine to know is wrong. ──────────────────────────────
    const shortLanded = await db.query<{
      bill_id: string;
      number: string | null;
      line_id: string;
      unit_cost_cents: number;
      landed_unit_cost_cents: number;
    }>(
      `SELECT vb.id AS bill_id, vb.number, vbl.id AS line_id,
              vbl.unit_cost_cents, vbl.landed_unit_cost_cents
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
        WHERE vb.deleted_at IS NULL
          AND vb.status IN ('confirmed', 'synced')
          AND vb.freight_allocation_basis IS NOT NULL
          AND COALESCE(vbl.line_type, 'product') = 'product'
          AND EXISTS (
            SELECT 1 FROM vendor_bill_line f
             WHERE f.vendor_bill_id = vb.id AND f.deleted_at IS NULL
               AND f.line_kind = 'freight_charge' AND f.amount_cents > 0
          )
          AND vbl.landed_unit_cost_cents < vbl.unit_cost_cents`
    );
    check(
      `ninguna línea de producto en un bill confirmado/synced con flete capitalizado tiene landed < unit_cost (${shortLanded.rowCount ?? 0} mal)`,
      (shortLanded.rowCount ?? 0) === 0,
      shortLanded.rows
        .map((r) => `${r.number ?? r.bill_id} line ${r.line_id}: unit=${r.unit_cost_cents} landed=${r.landed_unit_cost_cents}`)
        .join(", ")
    );

    // ── Counts, for context ────────────────────────────────────────────────
    const counts = await db.query<{ total: string; capitalized: string; legacy: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE bill_type = 'regular')::text AS total,
         COUNT(*) FILTER (WHERE bill_type = 'regular' AND freight_allocation_basis IS NOT NULL)::text AS capitalized,
         COUNT(*) FILTER (WHERE bill_type = 'regular' AND freight_allocation_basis IS NULL)::text AS legacy
       FROM vendor_bill WHERE deleted_at IS NULL`
    );
    const c = counts.rows[0]!;
    console.log(
      `\nBills regulares: ${c.total} total — ${c.capitalized} capitalizados, ${c.legacy} legacy (NULL)\n`
    );
  } finally {
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
