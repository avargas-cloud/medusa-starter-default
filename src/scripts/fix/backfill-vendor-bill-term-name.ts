/**
 * src/scripts/fix/backfill-vendor-bill-term-name.ts
 *
 * Fills `vendor_bill.payment_terms_name` on bills written before the column
 * existed. Without it every existing bill shows "— None —" in the Terms
 * dropdown, and — worse — the next Save would PERSIST that as "no term",
 * turning a display gap into data loss.
 *
 * INFERRING FROM THE DAY COUNT ALONE IS NOT SAFE and this script does not do
 * it as a first resort: 30 days matches "Net-30", "Net 30" AND
 * "30% Deposit, 70% upon delivery"; 0 days matches six different terms. Picking
 * one would be a coin flip recorded as fact.
 *
 * The signal that actually identifies the term is the BILL'S VENDOR: a bill is
 * written under its vendor's term, so if the vendor's term has the day count
 * the bill stored, that is the term — not a guess.
 *
 *   1. vendor's own term, when its days match the bill's days   → confident
 *   2. exactly ONE catalog term has that day count              → confident
 *   3. anything else                                            → LEFT NULL and listed
 *
 * Case 3 is left for a human on purpose. A bill whose stored days contradict
 * its vendor's term is the same pre-existing drift the verifier reports; naming
 * a term for it here would launder a contradiction into a clean-looking record.
 *
 * DRY RUN BY DEFAULT. Pass APPLY=true to write.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { readVendorTermsKnex } from "../../lib/vendor-terms/catalog";
import { normalizeVendorTermKey } from "../../lib/vendor-terms/types";

interface Knex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface BillRow {
  id: string;
  number: string | null;
  payment_terms_days: number | string | null;
  vendor_terms_ref_name: string | null;
  vendor_name: string | null;
}

const APPLY = process.env.APPLY === "true";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const knex = container.resolve("__pg_connection__") as Knex;

  console.log(`\n=== vendor_bill.payment_terms_name backfill — APPLY=${APPLY} ===\n`);

  const catalog = await readVendorTermsKnex(knex);
  if (!catalog.options.length) {
    throw new Error(
      "The vendor terms catalog is empty — run seed-vendor-terms-catalog.ts first"
    );
  }
  const byName = new Map(
    catalog.options.map((o) => [normalizeVendorTermKey(o.name), o])
  );
  // Day count → the terms that carry it. Only a UNIQUE hit is usable.
  const byDays = new Map<number, string[]>();
  for (const o of catalog.options) {
    if (o.days == null) continue;
    byDays.set(o.days, [...(byDays.get(o.days) ?? []), o.name]);
  }

  const { rows } = await knex.raw(
    `SELECT vb.id,
            vb.number,
            vb.payment_terms_days,
            v.terms_ref_name AS vendor_terms_ref_name,
            vb.vendor_name_snapshot AS vendor_name
       FROM vendor_bill vb
       LEFT JOIN qb_vendor v ON v.id = vb.vendor_id AND v.deleted_at IS NULL
      WHERE vb.payment_terms_name IS NULL
        AND vb.payment_terms_days IS NOT NULL
        AND vb.deleted_at IS NULL
      ORDER BY vb.number NULLS LAST`
  );

  const bills = rows as BillRow[];
  console.log(`${bills.length} bill(s) carry a day count but no term name\n`);
  if (!bills.length) return;

  const resolved: { bill: BillRow; term: string; how: string }[] = [];
  const unresolved: { bill: BillRow; why: string }[] = [];

  for (const b of bills) {
    const days = b.payment_terms_days == null ? null : Number(b.payment_terms_days);
    if (days == null || !Number.isInteger(days)) {
      unresolved.push({ bill: b, why: "day count is not an integer" });
      continue;
    }

    // 1. The vendor's own term, if it agrees with what the bill stored.
    const vendorTerm = b.vendor_terms_ref_name
      ? byName.get(normalizeVendorTermKey(b.vendor_terms_ref_name))
      : undefined;
    if (vendorTerm && vendorTerm.days === days) {
      resolved.push({ bill: b, term: vendorTerm.name, how: "vendor's term" });
      continue;
    }

    // 2. A day count only one term in the catalog can produce.
    const candidates = byDays.get(days) ?? [];
    if (candidates.length === 1) {
      resolved.push({ bill: b, term: candidates[0]!, how: "unique by days" });
      continue;
    }

    unresolved.push({
      bill: b,
      why: vendorTerm
        ? `vendor is on "${vendorTerm.name}" (${vendorTerm.days} days) but the bill stored ${days}`
        : candidates.length
          ? `${days} days is ambiguous: ${candidates.join(", ")}`
          : `no catalog term has ${days} days`,
    });
  }

  const byHow = resolved.reduce<Record<string, number>>((acc, r) => {
    acc[r.how] = (acc[r.how] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`RESOLVED ${resolved.length}:`);
  for (const [how, n] of Object.entries(byHow)) console.log(`  ${n} by ${how}`);
  const sample = resolved.slice(0, 8);
  for (const r of sample) {
    console.log(
      `    ${r.bill.number ?? r.bill.id} → "${r.term}" (${r.how})`
    );
  }
  if (resolved.length > sample.length) {
    console.log(`    … and ${resolved.length - sample.length} more`);
  }

  if (unresolved.length) {
    console.log(`\nLEFT NULL ${unresolved.length} — a human decides these:`);
    for (const u of unresolved.slice(0, 20)) {
      console.log(`    ${u.bill.number ?? u.bill.id}: ${u.why}`);
    }
    if (unresolved.length > 20) {
      console.log(`    … and ${unresolved.length - 20} more`);
    }
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with APPLY=true.\n`);
    return;
  }

  let written = 0;
  for (const r of resolved) {
    // Guarded on IS NULL so a concurrent save that already set a name wins —
    // this backfill fills gaps, it never overwrites a human's choice.
    const res = await knex.raw(
      `UPDATE vendor_bill
          SET payment_terms_name = ?, updated_at = NOW()
        WHERE id = ? AND payment_terms_name IS NULL`,
      [r.term, r.bill.id]
    );
    const count =
      (res as unknown as { rowCount?: number }).rowCount ?? res.rows.length;
    if (count) written++;
  }

  console.log(`\nWROTE ${written} of ${resolved.length}.`);
  console.log(`${unresolved.length} left NULL on purpose.\n`);
}
