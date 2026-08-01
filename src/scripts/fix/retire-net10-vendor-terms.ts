/**
 * src/scripts/fix/retire-net10-vendor-terms.ts
 *
 * Moves vendors off payment terms the accountant DEACTIVATED in QuickBooks and
 * onto terms that are live. Drives which terms to drain with FROM_TERMS.
 *
 * Why by hand and not by rule: the 25 are not one population. 22 are Chinese
 * lighting factories, and 3 are Miami businesses (AAB, TRISYSTEMS, US Storage
 * Center) that happen to share the term. One of the 22 is a freight forwarder,
 * where a 30/70 deposit against delivery of goods makes no sense. Country data
 * backs the split — the three US ones are the only three with a US address —
 * but the forwarder is a judgement the data cannot make, so the mapping is
 * explicit and reviewable rather than derived.
 *
 * Every move writes the name AND the rule together and fires a real VendorMod
 * to QuickBooks. Terms are LENGTHENING for 22 of them (10 → 30 days), which is
 * why this is safe to batch: nobody's payable comes due sooner than it does
 * today, except the two moved to Due on receipt, which are Miami vendors
 * already paid on delivery in practice.
 *
 * DRY RUN BY DEFAULT. Pass APPLY=true to write.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { pushVendorModToQuickBooks } from "../../lib/quickbooks/qb-vendor-mod";
import { readVendorTermsKnex, findTermByName } from "../../lib/vendor-terms/catalog";
import { toVendorSnapshot } from "../../lib/vendor-terms/push";

interface Knex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const APPLY = process.env.APPLY === "true";

/**
 * Vendor name → destination term, per the owner's call on each one.
 *
 * Spelled out rather than derived because these are not one population: the
 * Net-10 batch mixed 22 Chinese factories with 3 Miami businesses and a freight
 * forwarder, and the batch below mixes logistics, a hardware chain, a tax
 * collector and an insurer. No rule reads that correctly; a person did.
 */
const EXPLICIT: Record<string, string> = {
  // ── Net-10 batch (done 2026-08-01) ──
  "AAB FIRE AND ELECTRICAL CORD": "Net-30",
  "GuoShengInternational Forwarding Ltd": "Net-30",
  "TRISYSTEMS GROUP, INC.": "Due on receipt",
  "US Storage Center": "Due on receipt",

  // ── Remaining inactive terms ──
  // Consignment (90d) — logistics, rentals and print shops, none on consignment.
  "Interport Logistics Llc": "Net-30",
  "POES RENTAL OF HIALEAH, LLC": "Net-30",
  "Sign Zapata, Inc.": "Net-30",
  "Soulphase, Llc": "Net-30",
  "Zeev Lighting": "Net-30",
  // Terms whose day count never matched the relationship.
  "Home Depot": "Net-30",
  "FINESSE LIGHTING LLC": "Net-30",
  "Dainolite, Ltd.": "Net-30",
  // Genuinely annual: insurance, county taxes, yearly services.
  "JIM RICKARDS": "Annual",
  "Miami-Dade County Tax Collector": "Annual",
  "VIC MARKETING CORP": "Annual",
  "Progressive Insurance": "Annual",

  // ── VEETECH: su plazo real siempre fue 21 dias bajo el nombre "Net-30" ──
  // El operador creo Net-21 en QuickBooks el 2026-08-01 para que nombre y regla
  // por fin coincidan. Requiere ONLY: comparte "Net-30" con 63 vendors ajenos.
  "VEETECH Co., Ltd": "Net-21",

  // ── Cambios de termino GOING FORWARD, no correcciones ──
  // Se corrieron DESPUES del backfill a proposito: sus bills viejos ya
  // congelaron el termino bajo el que realmente se emitieron (ADI en
  // "Due on receipt", ELA en "Net-10"), y moverlos antes se los habria
  // reescrito. Estos vendors cambian de aca en adelante.
  "ADI GLOBAL": "Net-30",
  "ELA Florida": "Due on receipt",
};

/** Only used for vendors on FROM_TERM that EXPLICIT does not name. */
const DEFAULT_TERM = process.env.DEFAULT_TERM ?? "30% Deposit, 70% upon delivery";

/**
 * Which term(s) to drain. Use "*" with ONLY to select purely by name — needed
 * for a vendor that carries NO term at all (ELA Florida had 10 days stored and
 * no name), which no term filter can reach.
 *
 * PIPE-separated, not comma: term names contain commas
 * ("30% Deposit, 70% upon delivery", "50% deposit, 50% upon delivery"), so a
 * comma split would quietly break one name into two that match nothing — and a
 * batch that matches nothing reports a clean run over zero vendors instead of
 * failing. Same reason ONLY uses a pipe.
 * Every vendor on these terms must be named in EXPLICIT, or it falls to
 * DEFAULT_TERM — which is right for a homogeneous batch and wrong for a mixed
 * one, so the script REFUSES to guess when FROM covers several terms.
 */
const FROM_TERMS = (process.env.FROM_TERMS ?? "Net-10")
  .split("|")
  .map((t) => t.trim())
  .filter(Boolean);

/**
 * Optional PIPE-separated vendor names to restrict the batch to. Pipe because
 * vendor names contain commas — "VEETECH Co., Ltd", "Dainolite, Ltd.",
 * "Sign Zapata, Inc." — and a comma split turns one name into two that match
 * nothing.
 *
 * Needed for a targeted move: VEETECH sits on "Net-30" alongside 63 unrelated
 * vendors, so draining that term would sweep all of them. With ONLY set, the
 * term is just a filter and the named vendors are the batch.
 */
const ONLY = (process.env.ONLY ?? "")
  .split("|")
  .map((t) => t.trim())
  .filter(Boolean);

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const knex = container.resolve("__pg_connection__") as Knex;
  console.log(`\n=== ${FROM_TERMS.join(", ")} → live terms — APPLY=${APPLY} ===\n`);

  const catalog = await readVendorTermsKnex(knex);

  // A FROM term nobody has is almost always a typo. Without this the run
  // reports "0 vendors" and exits 0 — a silent no-op that reads like success.
  for (const t of FROM_TERMS) {
    if (t === "*") continue; // name-only batch, no term filter
    if (!findTermByName(catalog, t)) {
      throw new Error(
        `FROM_TERMS names "${t}", which is not in the catalog. ` +
          `Remember the separator is "|", not "," — term names contain commas.`
      );
    }
  }

  const { rows } = await knex.raw(
    `SELECT id, qb_list_id, name, full_name, company_name, first_name,
            middle_initial, last_name, contact, alt_contact, account_number,
            notes, email, phone, alt_phone, fax, tax_identity,
            vendor_type_ref_name, terms_ref_name, credit_limit,
            is_vendor_eligible_for_1099, is_active,
            addr1, addr2, city, state, postal_code, country, metadata
       FROM qb_vendor
      WHERE deleted_at IS NULL AND (?::boolean OR terms_ref_name = ANY(?))
      ORDER BY name`,
    [FROM_TERMS.includes("*"), FROM_TERMS]
  );
  let vendors = rows as Record<string, unknown>[];
  if (ONLY.length) {
    const wanted = new Set(ONLY.map((n) => n.toLowerCase()));
    const before = vendors.length;
    vendors = vendors.filter((v) => wanted.has(String(v.name ?? "").toLowerCase()));
    // A name that matches nothing is a typo, not an empty batch — say so rather
    // than reporting a clean run over zero vendors.
    const found = new Set(vendors.map((v) => String(v.name ?? "").toLowerCase()));
    const missing = ONLY.filter((n) => !found.has(n.toLowerCase()));
    if (missing.length) {
      throw new Error(
        `ONLY named ${missing.length} vendor(s) that are not on ${FROM_TERMS.join("/")}: ` +
          missing.map((m) => `"${m}"`).join(", ")
      );
    }
    console.log(`ONLY filter: ${vendors.length} of ${before} vendor(s) on the term\n`);
  }
  console.log(`${vendors.length} vendor(s) on ${FROM_TERMS.map((t) => `"${t}"`).join(", ")}\n`);

  // A mixed batch has no sensible default — falling back would quietly assign a
  // term nobody chose. Name every vendor or fix the list.
  if (FROM_TERMS.length > 1 || ONLY.length) {
    const unnamed = vendors.filter((v) => !EXPLICIT[String(v.name ?? "")]);
    if (unnamed.length) {
      throw new Error(
        `${unnamed.length} vendor(s) on a MIXED batch are not named in EXPLICIT, ` +
          `and this script will not guess a term for them: ` +
          unnamed.map((v) => `"${v.name}"`).join(", ")
      );
    }
  }

  const plan = vendors.map((v) => {
    const name = String(v.name ?? "");
    const target = EXPLICIT[name] ?? DEFAULT_TERM;
    const term = findTermByName(catalog, target);
    if (!term) throw new Error(`No catalog term named "${target}" (for ${name})`);
    return { vendor: v, name, target, term };
  });

  // Validate only the destinations THIS batch reaches. Checking every entry in
  // EXPLICIT would abort a Net-10 run over a term that only the later batch
  // needs and that may not be seeded yet.
  for (const name of new Set(plan.map((p) => p.target))) {
    const t = findTermByName(catalog, name)!;
    if (!t.exists_in_qb) {
      throw new Error(`"${name}" is not in the QuickBooks Terms list — a VendorMod would be rejected`);
    }
    if (!t.is_active) {
      throw new Error(`"${name}" is INACTIVE in QuickBooks — pick a live term`);
    }
  }

  for (const group of [...new Set(plan.map((p) => p.target))]) {
    const members = plan.filter((p) => p.target === group);
    console.log(`→ ${group} (${members[0]!.term.days} days) — ${members.length}:`);
    for (const m of members) console.log(`     ${m.name}`);
  }

  const skipped = plan.filter(
    (p) => !p.vendor.qb_list_id || String(p.vendor.qb_list_id).startsWith("pending_")
  );
  if (skipped.length) {
    console.log(`\nSKIPPED — never created in QuickBooks, nothing to Mod:`);
    for (const s of skipped) console.log(`     ${s.name}`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with APPLY=true.\n`);
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const p of plan) {
    if (skipped.includes(p)) continue;
    const after = {
      ...p.vendor,
      terms_ref_name: p.term.name,
      metadata: {
        ...((p.vendor.metadata as Record<string, unknown>) ?? {}),
        payment_terms: p.term.name,
        default_payment_terms_days: p.term.days,
        default_payment_terms_day_of_month: p.term.day_of_month_due,
        default_payment_terms_days_manual: true,
        default_payment_terms_source: "manual",
      },
    };
    // Local first, then QuickBooks: the local row is the source of truth now,
    // and a push failure must be visible rather than block the correction.
    await knex.raw(
      `UPDATE qb_vendor SET terms_ref_name = ?, metadata = ?::jsonb, updated_at = NOW()
        WHERE id = ?`,
      [p.term.name, JSON.stringify(after.metadata), String(p.vendor.id)]
    );
    try {
      /**
       * The address is DELIBERATELY omitted from this Mod.
       *
       * This script changes one thing — the payment term — and QuickBooks
       * already holds the address, because ours came from QuickBooks via the
       * vendor sync in the first place. Sending it back gains nothing and can
       * lose everything: VEETECH's Chinese address is stored across US-shaped
       * fields ("city" holds a road, "country" holds a truncated district), and
       * QB refuses to re-compose it into its 5-line block (error 3205). 27
       * vendors have all six address fields populated and are exposed to the
       * same failure.
       *
       * This is NOT a general relaxation of the full-snapshot rule: the vendor
       * PATCH route still sends the address, because there the operator may be
       * editing it. Omission is safe here precisely because nothing about the
       * address is changing, so QuickBooks keeping its own copy is the correct
       * outcome rather than a lossy shortcut.
       */
      const res = await pushVendorModToQuickBooks({
        ...toVendorSnapshot(after),
        address: null,
      });
      if (res.ok) {
        ok++;
        await knex.raw(
          `UPDATE qb_vendor SET sync_status='synced', last_error=NULL,
                  last_synced_at=NOW() WHERE id = ?`,
          [String(p.vendor.id)]
        );
        console.log(`  ✓ ${p.name} → ${p.term.name}`);
      } else {
        failed++;
        const msg = `QuickBooks rejected the update (${res.statusCode}): ${res.statusMessage}`;
        await knex.raw(
          `UPDATE qb_vendor SET sync_status='error', last_error=? WHERE id = ?`,
          [msg, String(p.vendor.id)]
        );
        console.log(`  ✗ ${p.name} — ${msg}`);
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await knex.raw(
        `UPDATE qb_vendor SET sync_status='error', last_error=? WHERE id = ?`,
        [`VendorMod did not reach QuickBooks: ${msg}`, String(p.vendor.id)]
      );
      console.log(`  ✗ ${p.name} — ${msg}`);
    }
  }

  console.log(`\n${ok} pushed to QuickBooks, ${failed} failed, ${skipped.length} skipped.`);
  if (failed) {
    console.log(`Failed ones are local-only for now; their reason is on the vendor page.`);
  }
}
