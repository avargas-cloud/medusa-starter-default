/**
 * detect-customer-vendor-links.ts — candidatos a link customer↔vendor.
 *
 * Detecta clientes del POS que probablemente YA tengan una cuenta de vendor en
 * QuickBooks (misma persona en las dos listas — la identidad que necesita el
 * pago de comisiones), y opcionalmente crea el `customer_vendor_link`.
 *
 * Matching CONSERVADOR por niveles — un link equivocado manda un cheque a
 * nombre de otra persona, así que acá no se adivina:
 *   1. EMAIL exacto (señal fuerte: la misma casilla en ambas listas)
 *   2. NOMBRE exacto normalizado (case/espacios; la puntuación interna NO se
 *      ignora — lección de los payment terms: "Net 30" y "Net-30" son dos
 *      entidades)
 *   3. NOMBRE + sufijo " (Comm)" (vendors espejo creados por esta feature)
 *   4. PUNTUACIÓN FINAL: mismo nombre salvo un `.`/`,`/`;` colgando al final
 *      ("AAF ELECTRICAL SOLUTION." ↔ "AAF Electrical Solution") — el contador
 *      remata nombres con punto en QB; solo el FINAL, nunca puntuación interna
 *
 * Un nombre que matchea a MÁS de un customer o más de un vendor se reporta
 * como ambiguo y NUNCA se linkea solo.
 *
 * Uso:
 *   dry-run (reporte):
 *     env DATABASE_URL=... ./node_modules/.bin/tsx src/scripts/checks/detect-customer-vendor-links.ts
 *   aplicar (crea los links de nivel email+nombre, nunca los ambiguos):
 *     env DATABASE_URL=... APPLY=true ./node_modules/.bin/tsx ...
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";

const APPLY = process.env.APPLY === "true";

interface CustomerRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
}
interface VendorRow {
  id: string;
  qb_list_id: string;
  full_name: string;
  email: string | null;
}
interface Candidate {
  tier: "email" | "name" | "comm_suffix" | "trailing_punct";
  customer: CustomerRow;
  vendor: VendorRow;
}

const norm = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Nivel 4: además de norm(), pela `.`/`,`/`;` SOLO del final. */
const normTrailing = (s: string | null | undefined): string =>
  norm(s).replace(/[.,;]+$/, "").trim();

const customerNames = (c: CustomerRow): string[] => {
  const names = new Set<string>();
  const full = norm(`${c.first_name ?? ""} ${c.last_name ?? ""}`);
  if (full) names.add(full);
  const company = norm(c.company_name);
  if (company) names.add(company);
  return [...names];
};

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL requerido.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url, max: 2,
    ssl: url.includes("railway") ? { rejectUnauthorized: false } : undefined });

  const { rows: customers } = await pool.query<CustomerRow>(
    `SELECT id, email, first_name, last_name, company_name
       FROM customer WHERE deleted_at IS NULL`
  );
  const { rows: vendors } = await pool.query<VendorRow>(
    `SELECT id, qb_list_id, full_name, email
       FROM qb_vendor
      WHERE deleted_at IS NULL AND is_active = true
        AND qb_list_id NOT LIKE 'pending_%'`
  );
  const { rows: links } = await pool.query<{ customer_id: string; qb_vendor_id: string }>(
    `SELECT customer_id, qb_vendor_id FROM customer_vendor_link WHERE deleted_at IS NULL`
  );
  const linkedCustomers = new Set(links.map((l) => l.customer_id));
  const linkedVendors = new Set(links.map((l) => l.qb_vendor_id));

  console.log(
    `customers: ${customers.length} · vendors activos: ${vendors.length} · links existentes: ${links.length}\n`
  );

  // Índices de vendors (con conteo para detectar ambigüedad).
  const byEmail = new Map<string, VendorRow[]>();
  const byName = new Map<string, VendorRow[]>();
  const byTrailing = new Map<string, VendorRow[]>();
  for (const v of vendors) {
    const e = norm(v.email);
    if (e) (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(v);
    const n = norm(v.full_name);
    if (n) (byName.get(n) ?? byName.set(n, []).get(n)!).push(v);
    const t = normTrailing(v.full_name);
    if (t) (byTrailing.get(t) ?? byTrailing.set(t, []).get(t)!).push(v);
  }

  const candidates: Candidate[] = [];
  const ambiguous: string[] = [];
  const claimedVendor = new Set<string>();

  for (const c of customers) {
    if (linkedCustomers.has(c.id)) continue;

    let match: { tier: Candidate["tier"]; list: VendorRow[] } | null = null;
    const email = norm(c.email);
    if (email && byEmail.has(email)) match = { tier: "email", list: byEmail.get(email)! };
    if (!match) {
      for (const name of customerNames(c)) {
        if (byName.has(name)) { match = { tier: "name", list: byName.get(name)! }; break; }
        const withSuffix = `${name} (comm)`;
        if (byName.has(withSuffix)) { match = { tier: "comm_suffix", list: byName.get(withSuffix)! }; break; }
        const trailing = normTrailing(name);
        if (trailing && byTrailing.has(trailing)) {
          match = { tier: "trailing_punct", list: byTrailing.get(trailing)! };
          break;
        }
      }
    }
    if (!match) continue;

    if (match.list.length > 1) {
      ambiguous.push(
        `AMBIGUO (${match.tier}): customer ${c.id} "${customerNames(c).join(" / ")}" matchea ${match.list.length} vendors: ${match.list.map((v) => v.full_name).join(" · ")}`
      );
      continue;
    }
    const vendor = match.list[0]!;
    if (linkedVendors.has(vendor.id) || claimedVendor.has(vendor.id)) {
      ambiguous.push(
        `CONFLICTO: vendor "${vendor.full_name}" ya linkeado/reclamado — customer ${c.id} queda fuera`
      );
      continue;
    }
    claimedVendor.add(vendor.id);
    candidates.push({ tier: match.tier, customer: c, vendor });
  }

  for (const tier of ["email", "name", "comm_suffix", "trailing_punct"] as const) {
    const group = candidates.filter((x) => x.tier === tier);
    console.log(`── nivel ${tier}: ${group.length} candidato(s)`);
    for (const x of group) {
      console.log(
        `   ${x.customer.email ?? "(sin email)"} | "${customerNames(x.customer).join(" / ")}" ↔ vendor "${x.vendor.full_name}" (${x.vendor.qb_list_id})`
      );
    }
  }
  if (ambiguous.length) {
    console.log(`\n── ambiguos / conflictos (NUNCA se auto-linkean): ${ambiguous.length}`);
    for (const a of ambiguous) console.log(`   ${a}`);
  }

  if (!APPLY) {
    console.log(`\nDry-run: nada escrito. APPLY=true crea los ${candidates.length} links de arriba.`);
  } else {
    let created = 0;
    for (const x of candidates) {
      try {
        await pool.query(
          `INSERT INTO customer_vendor_link (id, customer_id, qb_vendor_id, vendor_full_name, created_by)
           VALUES ($1,$2,$3,$4,'detect-customer-vendor-links')`,
          [`cvl_${randomUUID().replace(/-/g, "")}`, x.customer.id, x.vendor.id, x.vendor.full_name]
        );
        created++;
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505") {
          console.log(`   skip (ya linkeado): ${x.vendor.full_name}`);
        } else {
          throw err;
        }
      }
    }
    console.log(`\nAPPLY: ${created} link(s) creados.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
