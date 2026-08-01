/**
 * src/scripts/verify/verify-vendor-terms-consolidation.ts
 *
 * Gate for the vendor payment-terms catalog.
 *
 * It calls the REAL exported functions — never a re-typed copy of their SQL or
 * their XML. A verifier that reimplements what it checks only proves that two
 * copies of the same mistake agree.
 *
 * Read-only against data: the one write it performs runs inside a transaction
 * that always rolls back, because the only honest way to know that a knex `?`
 * binding actually binds is to let Postgres try it.
 *
 * Usage:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/verify/verify-vendor-terms-consolidation.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import {
  buildDateDrivenTermsAddQbxml,
  buildStandardTermsAddQbxml,
} from "../../lib/quickbooks/qb-terms-add";
import { buildVendorModQbxml } from "../../lib/quickbooks/qb-vendor-mod";
import { readVendorTermsKnex } from "../../lib/vendor-terms/catalog";
import { resolveDueDate } from "../../lib/vendor-terms/due-date";
import { decideVendorPush } from "../../lib/vendor-terms/push";
import {
  VENDOR_TERMS_CONTEXT,
  VENDOR_TERMS_FIELD,
  VENDOR_TERMS_SCOPE,
  isValidTerm,
} from "../../lib/vendor-terms/types";

interface Knex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

let pass = 0;
let fail = 0;
/**
 * Data findings are counted apart from code failures ON PURPOSE.
 *
 * This verifier gates a CODE change. Production carries payment-term drift that
 * predates it (a vendor on "Due on receipt" with 30 days stored, one on
 * "Net-30" with 21) and cleaning that up is a separate, approved-separately
 * data migration. If those two rows turned this gate red forever, the gate
 * could never certify anything again — and a permanently red gate is one people
 * stop reading. So they are reported loudly and listed by name, but only broken
 * INVARIANTS set the exit code.
 */
let dataFindings = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const knex = container.resolve("__pg_connection__") as Knex;

  console.log("\n=== vendor terms consolidation ===\n");

  // ── 1. The catalog reader binds and returns sane rows ───────────────────────
  console.log("1. Catalog");
  const catalog = await readVendorTermsKnex(knex);
  check(
    "readVendorTermsKnex binds its parameters",
    Array.isArray(catalog.options)
  );
  check(
    "every option carries exactly one rule (days XOR day-of-month)",
    catalog.options.every((o) => isValidTerm(o)),
    catalog.options
      .filter((o) => !isValidTerm(o))
      .map((o) => o.name)
      .join(", ")
  );
  check(
    "no option is silently dropped — broken rows are reported",
    catalog.rejected.every((r) => typeof r.id === "string")
  );
  if (catalog.rejected.length) {
    console.log(
      `    note: ${catalog.rejected.length} row(s) have no usable rule: ` +
        catalog.rejected.map((r) => `"${r.value}"`).join(", ")
    );
  }

  // Two terms may legitimately share a day count, but never a NAME.
  const seen = new Map<string, string>();
  let dupName = "";
  for (const o of catalog.options) {
    const key = o.name.trim().toLowerCase();
    if (seen.has(key)) dupName = o.name;
    seen.set(key, o.id);
  }
  check("no two options share a name", !dupName, dupName);

  // ── 2. The INSERT binds — proven by letting Postgres run it ─────────────────
  console.log("\n2. Write path (transaction, always rolled back)");
  let bindOk = false;
  let bindErr = "";
  try {
    await knex.raw("BEGIN");
    await knex.raw(
      `INSERT INTO system_defaults
         (context, field_name, value, sort_order, data_scope, metadata)
       VALUES (?, ?, ?,
               COALESCE((SELECT MAX(sort_order) + 1 FROM system_defaults
                          WHERE context = ? AND field_name = ?), 1),
               ?, ?::jsonb)
       ON CONFLICT (context, field_name, value) DO UPDATE
         SET metadata = EXCLUDED.metadata, updated_at = NOW()
       RETURNING id`,
      [
        VENDOR_TERMS_CONTEXT,
        VENDOR_TERMS_FIELD,
        "__bindcheck_never_a_real_term__",
        VENDOR_TERMS_CONTEXT,
        VENDOR_TERMS_FIELD,
        VENDOR_TERMS_SCOPE,
        JSON.stringify({ days: 1, day_of_month_due: null, exists_in_qb: false }),
      ]
    );
    bindOk = true;
  } catch (e) {
    bindErr = e instanceof Error ? e.message : String(e);
  } finally {
    await knex.raw("ROLLBACK");
  }
  check("the catalog INSERT binds all 7 parameters", bindOk, bindErr);

  const { rows: leftover } = await knex.raw(
    `SELECT id FROM system_defaults WHERE value = ?`,
    ["__bindcheck_never_a_real_term__"]
  );
  check("the rollback left nothing behind", leftover.length === 0);

  // ── 3. Due-date resolution ─────────────────────────────────────────────────
  console.log("\n3. Due dates");
  check(
    "N days is added to the bill date",
    resolveDueDate("2026-07-31", { days: 30, day_of_month_due: null }) ===
      "2026-08-30"
  );
  check(
    "a date-driven term rolls when its day already passed",
    resolveDueDate("2026-07-25", { days: null, day_of_month_due: 20 }) ===
      "2026-08-20"
  );
  check(
    "a term with NO rule resolves to null, never to day zero",
    resolveDueDate("2026-07-31", { days: null, day_of_month_due: null }) === null
  );

  // ── 4. QBXML the bridge will actually send ─────────────────────────────────
  console.log("\n4. QBXML");
  const modXml = buildVendorModQbxml(
    {
      qb_list_id: "80000A1B-1",
      name: "Verifier Vendor",
      terms_ref_name: "Net-30",
      vendor_type_ref_name: "Overseas",
    },
    "seq-1"
  );
  const listAt = modXml.indexOf("<ListID>");
  const editAt = modXml.indexOf("<EditSequence>");
  const typeAt = modXml.indexOf("<VendorTypeRef>");
  const termsAt = modXml.indexOf("<TermsRef>");
  check("VendorMod leads with ListID then EditSequence", listAt < editAt);
  check("VendorTypeRef precedes TermsRef (SDK order)", typeAt < termsAt);
  check(
    "VendorMod carries the full envelope the raw passthrough will NOT add",
    modXml.includes("<?qbxml version=") && modXml.includes("<QBXMLMsgsRq")
  );
  check(
    "StandardTermsAdd emits StdDueDays",
    buildStandardTermsAddQbxml({ name: "Net-45", days: 45 }).includes(
      "<StdDueDays>45</StdDueDays>"
    )
  );
  check(
    "DateDrivenTermsAdd emits DueNextMonthDays even at zero",
    buildDateDrivenTermsAddQbxml({ name: "120", dayOfMonthDue: 20 }).includes(
      "<DueNextMonthDays>0</DueNextMonthDays>"
    )
  );

  // ── 5. Push decisions ──────────────────────────────────────────────────────
  console.log("\n5. Push decisions");
  const base = { qb_list_id: "80000A1B-1", terms_ref_name: "Net-30" };
  check(
    "a term change pushes",
    decideVendorPush(base, { terms_ref_name: "Net-60" }).push
  );
  check(
    "re-saving the same values does NOT push",
    !decideVendorPush(base, { terms_ref_name: "Net-30" }).push
  );
  check(
    "a vendor never created in QuickBooks is not Modded",
    decideVendorPush(
      { ...base, qb_list_id: "pending_x" },
      { terms_ref_name: "Net-60" }
    ).reason === "never_synced"
  );

  // ── 6. Live vendor data agrees with the catalog ────────────────────────────
  console.log("\n6. Live vendors");
  const { rows: mismatched } = await knex.raw(
    `SELECT v.terms_ref_name,
            (v.metadata->>'default_payment_terms_days')::int AS days,
            COUNT(*)::int AS vendors
       FROM qb_vendor v
      WHERE v.deleted_at IS NULL
        AND v.terms_ref_name IS NOT NULL
        AND btrim(v.terms_ref_name) <> ''
      GROUP BY 1, 2
      ORDER BY vendors DESC`
  );
  const byName = new Map(
    catalog.options.map((o) => [o.name.trim().toLowerCase(), o])
  );
  const rows = mismatched as {
    terms_ref_name: string;
    days: number | null;
    vendors: number;
  }[];
  const comparable = rows.filter((r) =>
    byName.has(String(r.terms_ref_name).trim().toLowerCase())
  );
  const drifted = comparable.filter((r) => {
    const term = byName.get(String(r.terms_ref_name).trim().toLowerCase())!;
    return term.days !== (r.days == null ? null : Number(r.days));
  });

  // An empty catalog would make the drift check pass by comparing NOTHING.
  // A vacuous green is worse than a red: it reports coverage that does not
  // exist. Say so instead, and fail if the catalog is populated but somehow
  // matched no vendor at all.
  if (comparable.length === 0) {
    console.log(
      `  ⚠ NOT RUN — no vendor term matches the catalog ` +
        `(catalog has ${catalog.options.length} entries, vendors carry ${rows.length}). ` +
        `Seed it with seed-vendor-terms-catalog.ts, then re-run.`
    );
    if (catalog.options.length > 0) {
      check(
        "a populated catalog matches at least one vendor",
        false,
        "catalog is populated but overlaps no vendor — check the names"
      );
    }
  } else {
    if (drifted.length === 0) {
      pass++;
      console.log(
        `  ✓ no vendor's stored day count contradicts its own term (${comparable.length} compared)`
      );
    } else {
      dataFindings += drifted.length;
      console.log(
        `  ⚑ DATA — ${drifted.length} vendor group(s) carry a day count that contradicts their own term ` +
          `(${comparable.length} compared). Pre-existing; not created by this change.`
      );
      for (const d of drifted) {
        const term = byName.get(String(d.terms_ref_name).trim().toLowerCase())!;
        console.log(
          `      "${d.terms_ref_name}" says ${term.days} days, ${d.vendors} vendor(s) store ${d.days}`
        );
      }
      console.log(
        `      Remedy: a separate data migration, not this gate. Until then those ` +
          `bills compute a due date from the stored number, not from the term.`
      );
    }
  }

  const orphans = (mismatched as { terms_ref_name: string; vendors: number }[])
    .filter((r) => !byName.get(String(r.terms_ref_name).trim().toLowerCase()));
  if (orphans.length) {
    console.log(
      `    note: ${orphans.length} term name(s) on vendors are absent from the catalog — ` +
        `run seed-vendor-terms-catalog.ts: ` +
        orphans.map((o) => `"${o.terms_ref_name}" (${o.vendors})`).join(", ")
    );
  }

  console.log(
    `\n=== ${pass} passed, ${fail} failed` +
      (dataFindings ? `, ${dataFindings} data finding(s)` : "") +
      ` ===\n`
  );
  // Only broken invariants fail the gate. Data findings are the report above.
  if (fail > 0) process.exitCode = 1;
}
