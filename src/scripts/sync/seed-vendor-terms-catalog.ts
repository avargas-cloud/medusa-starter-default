/**
 * src/scripts/sync/seed-vendor-terms-catalog.ts
 *
 * Seeds / refreshes the vendor payment-terms catalog in `system_defaults`
 * (context "Vendor Defaults", field "Vendor Payment Terms"). Each row is the
 * double field: `value` is the name QuickBooks knows, `metadata` carries the
 * rule (N days, or day-of-month) plus whether QB actually has that term.
 *
 * TWO SOURCES, and the difference matters:
 *
 *   SOURCE=qb        Live TermsQuery against the bridge. Authoritative — a term
 *                    that comes back from here is safe to send in a VendorMod,
 *                    so it is stamped `exists_in_qb: true`.
 *
 *   SOURCE=vendors   Derived offline from the terms our 280 synced vendors
 *                    already carry. Works with QuickBooks unreachable (the
 *                    sandbox has the bridge switched off), and it is the same
 *                    data — it CAME from QB over months. Stamped
 *                    `exists_in_qb: false`, because "some vendor has this name"
 *                    is not proof the Terms list still has it.
 *
 *   SOURCE=both      vendors first, then QB reconciles names and day counts on
 *                    top. Default.
 *
 * DRY RUN BY DEFAULT. Pass APPLY=true to write.
 *
 * Usage:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/sync/seed-vendor-terms-catalog.ts
 *   SOURCE=vendors APPLY=true env DATABASE_URL=... npx medusa exec ./src/...
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { fetchQbTermsMap, type QbTermsMap } from "../../lib/quickbooks/qb-terms";
import {
  deriveTermsFromVendors,
  flagNameNumberMismatch,
  type VendorTermSighting,
} from "../../lib/vendor-terms/derive";
import {
  VENDOR_TERMS_CONTEXT,
  VENDOR_TERMS_FIELD,
  VENDOR_TERMS_SCOPE,
  normalizeVendorTermKey,
} from "../../lib/vendor-terms/types";

type Source = "qb" | "vendors" | "both";

interface PendingRow {
  name: string;
  days: number | null;
  day_of_month_due: number | null;
  due_next_month_days: number | null;
  exists_in_qb: boolean;
  is_active: boolean;
  vendors: number;
}

const APPLY = process.env.APPLY === "true";
const SOURCE = ((process.env.SOURCE ?? "both").toLowerCase() as Source) ?? "both";

const log = (...a: unknown[]): void => console.log(...a);

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  if (!["qb", "vendors", "both"].includes(SOURCE)) {
    throw new Error(`SOURCE must be qb | vendors | both — got "${SOURCE}"`);
  }

  const knex = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };

  log(`\n=== Vendor terms catalog — SOURCE=${SOURCE} APPLY=${APPLY} ===\n`);

  const byKey = new Map<string, PendingRow>();

  // ── 1. Derive from the vendors that already carry a term ────────────────────
  if (SOURCE === "vendors" || SOURCE === "both") {
    const sightings = await readVendorSightings(knex);
    const derived = deriveTermsFromVendors(sightings);

    log(
      `vendors: ${sightings.length} (name, rule) combinations → ${derived.terms.length} distinct terms`
    );

    for (const t of derived.terms) {
      byKey.set(normalizeVendorTermKey(t.name), {
        name: t.name,
        days: t.days,
        day_of_month_due: t.day_of_month_due,
        due_next_month_days: null,
        exists_in_qb: false,
        is_active: true,
        vendors: t.vendors,
      });
    }

    if (derived.conflicts.length) {
      log(`\n  DISAGREEMENTS papered over (majority reading won):`);
      for (const c of derived.conflicts) {
        const lost = c.rejected
          .map((r) => `${describeRule(r)} on ${r.vendors}`)
          .join(", ");
        log(
          `    "${c.name}": kept ${describeRule(c.chosen)} on ${c.chosen.vendors} vendors — dropped ${lost}`
        );
      }
    }
    if (derived.ruleless.length) {
      log(
        `\n  EXCLUDED, no usable rule (left out on purpose, NOT defaulted to 0):`
      );
      for (const n of derived.ruleless) log(`    "${n}"`);
    }

    const mismatches = flagNameNumberMismatch(derived.terms);
    if (mismatches.length) {
      log(`\n  NAME CONTRADICTS ITS OWN RULE (advisory — the rule wins):`);
      for (const m of mismatches) {
        log(
          `    "${m.name}" resolves to ${m.days} days but its name says ${m.nameSuggests}`
        );
      }
    }
  }

  // ── 2. Reconcile against the live QuickBooks Terms list ─────────────────────
  if (SOURCE === "qb" || SOURCE === "both") {
    let qbMap: QbTermsMap;
    try {
      qbMap = await fetchQbTermsMap();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (SOURCE === "qb") throw new Error(`QB Terms query failed: ${msg}`);
      log(
        `\n  QB unreachable (${msg}) — keeping the vendor-derived catalog, every row exists_in_qb=false`
      );
      qbMap = {};
    }

    const qbEntries = Object.values(qbMap);
    if (qbEntries.length) {
      log(`\nqb: Terms list returned ${qbEntries.length} terms`);
      for (const entry of qbEntries) {
        const key = normalizeVendorTermKey(entry.name);
        const existing = byKey.get(key);
        // QB is authoritative on the rule for a term it owns.
        byKey.set(key, {
          name: entry.name,
          days: entry.days,
          day_of_month_due: entry.day_of_month_due,
          due_next_month_days: entry.due_next_month_days,
          exists_in_qb: true,
          is_active: entry.is_active,
          vendors: existing?.vendors ?? 0,
        });
        if (
          existing &&
          (existing.days !== entry.days ||
            existing.day_of_month_due !== entry.day_of_month_due)
        ) {
          log(
            `    "${entry.name}": our vendors said ${describeRule(existing)}, QuickBooks says ${describeRule(entry)} — QB wins`
          );
        }
      }
      const orphans = [...byKey.values()].filter((r) => !r.exists_in_qb);
      if (orphans.length) {
        log(
          `\n  NOT IN THE QB TERMS LIST (a VendorMod carrying these would be rejected):`
        );
        for (const o of orphans) {
          log(`    "${o.name}" — ${describeRule(o)}, ${o.vendors} vendors`);
        }
      }
    }
  }

  // ── 3. Write ────────────────────────────────────────────────────────────────
  const rows = [...byKey.values()].filter(
    (r) => r.days != null || r.day_of_month_due != null
  );
  rows.sort((a, b) => b.vendors - a.vendors || a.name.localeCompare(b.name));

  log(`\n=== ${rows.length} terms resolved ===`);
  for (const [i, r] of rows.entries()) {
    log(
      `  ${String(i + 1).padStart(2)}. ${r.name.padEnd(34)} ${describeRule(r).padEnd(14)} ` +
        `qb=${r.exists_in_qb ? "yes" : "NO "} ${r.is_active ? "active  " : "INACTIVE"} vendors=${r.vendors}`
    );
  }

  if (!APPLY) {
    log(`\nDRY RUN — nothing written. Re-run with APPLY=true to persist.\n`);
    return;
  }

  let inserted = 0;
  let updated = 0;
  for (const [i, r] of rows.entries()) {
    const metadata = {
      days: r.days,
      day_of_month_due: r.day_of_month_due,
      due_next_month_days: r.due_next_month_days,
      exists_in_qb: r.exists_in_qb,
      is_active: r.is_active,
      qb_synced_at: r.exists_in_qb ? new Date().toISOString() : null,
    };
    // ON CONFLICT keys on (context, field_name, value) — the table's own unique.
    const result = await knex.raw(
      `INSERT INTO system_defaults
         (context, field_name, value, sort_order, data_scope, metadata)
       VALUES (?, ?, ?, ?, ?, ?::jsonb)
       ON CONFLICT (context, field_name, value) DO UPDATE
         SET metadata = EXCLUDED.metadata,
             sort_order = EXCLUDED.sort_order,
             data_scope = EXCLUDED.data_scope,
             updated_at = NOW()
       RETURNING (xmax = 0) AS was_insert`,
      [
        VENDOR_TERMS_CONTEXT,
        VENDOR_TERMS_FIELD,
        r.name,
        i + 1,
        VENDOR_TERMS_SCOPE,
        JSON.stringify(metadata),
      ]
    );
    const wasInsert = (result.rows[0] as { was_insert: boolean } | undefined)
      ?.was_insert;
    if (wasInsert) inserted++;
    else updated++;
  }

  log(`\nWROTE ${inserted} new, ${updated} updated.\n`);
}

function describeRule(r: {
  days: number | null;
  day_of_month_due: number | null;
}): string {
  if (r.days != null) return `${r.days} days`;
  if (r.day_of_month_due != null) return `due day ${r.day_of_month_due}`;
  return "no rule";
}

/**
 * One row per distinct (term name, rule) combination, with how many vendors
 * carry it. Grouping in SQL keeps 1,109 vendors from crossing the wire.
 */
async function readVendorSightings(knex: {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}): Promise<VendorTermSighting[]> {
  const result = await knex.raw(
    `SELECT terms_ref_name                                      AS name,
            (metadata->>'default_payment_terms_days')::int      AS days,
            (metadata->>'default_payment_terms_day_of_month')::int
                                                                AS day_of_month_due,
            COUNT(*)::int                                       AS vendors
       FROM qb_vendor
      WHERE deleted_at IS NULL
        AND terms_ref_name IS NOT NULL
        AND btrim(terms_ref_name) <> ''
      GROUP BY 1, 2, 3
      ORDER BY vendors DESC, name`
  );
  return (result.rows as VendorTermSighting[]).map((r) => ({
    name: String(r.name),
    days: r.days == null ? null : Number(r.days),
    day_of_month_due:
      r.day_of_month_due == null ? null : Number(r.day_of_month_due),
    vendors: Number(r.vendors),
  }));
}
