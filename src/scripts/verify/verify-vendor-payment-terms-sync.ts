/**
 * Verify the vendor payment-terms resync (Settings → QuickBooks Sync →
 * "Resync Payment Terms") WITHOUT writing anything.
 *
 * Pulls the live QB Terms list, joins it against every vendor's stored
 * `terms_ref_name`, and reports exactly what a run would do: how many vendors
 * get a due-days number, which term names QB can't resolve, how many are held
 * back by a manual POS override, and how many already carry the value.
 *
 * Read-only against both QuickBooks and Postgres. Safe to run against prod.
 *
 * Usage:
 *   cd backend
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/verify/verify-vendor-payment-terms-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { fetchQbTermsMap, normalizeTermsKey } from "../../lib/quickbooks/qb-terms";

interface VendorRow {
  id: string;
  full_name: string | null;
  terms_ref_name: string | null;
  stored_days: number | null;
  is_manual: boolean;
}

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: VendorRow[]; rowCount?: number }>;
}

export default async function verifyVendorPaymentTermsSync({
  container,
}: ExecArgs): Promise<void> {
  const pg = container.resolve("__pg_connection__") as unknown as KnexLike;

  console.log("Querying the QuickBooks Terms list (ActiveStatus=All)…");
  const termsMap = await fetchQbTermsMap();
  const termsCount = Object.keys(termsMap).length;
  console.log(`  ${termsCount} terms returned by QuickBooks\n`);

  if (termsCount === 0) {
    console.log("FAIL — QuickBooks returned no terms; a resync would be a no-op.");
    return;
  }

  const { rows: vendors } = await pg.raw(`
    SELECT id,
           full_name,
           terms_ref_name,
           (metadata->>'default_payment_terms_days')::int AS stored_days,
           COALESCE((metadata->>'default_payment_terms_days_manual')::boolean, false) AS is_manual
      FROM qb_vendor
     WHERE deleted_at IS NULL`);

  let wouldWrite = 0;
  let alreadyCorrect = 0;
  let heldByManual = 0;
  let noTermInQb = 0;
  const unresolved = new Map<string, number>();

  for (const v of vendors) {
    const name = v.terms_ref_name?.trim();
    if (!name) {
      noTermInQb++;
      continue;
    }
    if (v.is_manual) {
      heldByManual++;
      continue;
    }
    const entry = termsMap[normalizeTermsKey(name)];
    if (!entry) {
      unresolved.set(name, (unresolved.get(name) ?? 0) + 1);
      continue;
    }
    if (entry.days !== null && v.stored_days === entry.days) alreadyCorrect++;
    else wouldWrite++;
  }

  console.log(`Vendors: ${vendors.length}`);
  console.log(`  would get / refresh due-days   : ${wouldWrite}`);
  console.log(`  already match QuickBooks       : ${alreadyCorrect}`);
  console.log(`  held back by a manual override : ${heldByManual}`);
  console.log(`  no term set in QuickBooks      : ${noTermInQb}`);
  console.log(`  term name QB can't resolve     : ${[...unresolved.values()].reduce((a, b) => a + b, 0)}`);

  if (unresolved.size > 0) {
    console.log("\nUnresolved term names (vendor has it, QB Terms list doesn't):");
    for (const [name, count] of [...unresolved].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(4)}  ${name}`);
    }
  }

  const dateDriven = Object.values(termsMap).filter((t) => t.days === null);
  if (dateDriven.length > 0) {
    console.log(
      `\nDate-driven terms (no day count — vendors on these fall back to the ` +
        `system default): ${dateDriven.map((t) => t.name).join(", ")}`
    );
  }

  console.log(
    unresolved.size === 0
      ? "\nPASS — every stored term name resolves against the QuickBooks Terms list."
      : "\nCHECK — the names above stay untouched until they exist in QB's Terms list."
  );
}
