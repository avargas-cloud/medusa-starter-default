import type { MedusaContainer } from "@medusajs/framework/types";
import { fetchQbTermsMap } from "../../lib/quickbooks/qb-terms";
export default async function run({ container }: { container: MedusaContainer }): Promise<void> {
  const knex = container.resolve("__pg_connection__") as { raw: (s: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  const map = await fetchQbTermsMap();
  const all = Object.values(map);
  const inactive = all.filter((t) => !t.is_active);
  console.log(`\nQB tiene ${all.length} terms: ${all.length - inactive.length} ACTIVOS, ${inactive.length} INACTIVOS\n`);
  const { rows } = await knex.raw(
    `SELECT terms_ref_name AS name, COUNT(*)::int AS n FROM qb_vendor
      WHERE deleted_at IS NULL AND terms_ref_name IS NOT NULL GROUP BY 1`);
  const byName = new Map((rows as {name:string;n:number}[]).map(r => [r.name.trim().toLowerCase(), r.n]));
  console.log("INACTIVOS EN QB pero asignados a vendors vivos:");
  let tot = 0;
  for (const t of inactive) {
    const n = byName.get(t.name.trim().toLowerCase()) ?? 0;
    if (n > 0) { console.log(`  ${t.name.padEnd(34)} ${String(n).padStart(3)} vendors`); tot += n; }
  }
  console.log(`\n  --> ${tot} vendors dependen de un term inactivo`);
  console.log("\nINACTIVOS sin ningun vendor (el dropdown no deberia ofrecerlos):");
  console.log("  " + inactive.filter(t => !(byName.get(t.name.trim().toLowerCase()) ?? 0)).map(t => t.name).join(" · "));
}
