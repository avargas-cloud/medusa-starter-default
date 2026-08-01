import type { MedusaContainer } from "@medusajs/framework/types";
import { buildVendorModQbxml } from "../../lib/quickbooks/qb-vendor-mod";
import { toVendorSnapshot } from "../../lib/vendor-terms/push";
export default async function run({ container }: { container: MedusaContainer }): Promise<void> {
  const knex = container.resolve("__pg_connection__") as { raw: (s: string, b?: unknown[]) => Promise<{ rows: unknown[] }> };
  const { rows } = await knex.raw(`SELECT * FROM qb_vendor WHERE name LIKE 'SLT Ligthing%' AND deleted_at IS NULL`);
  const v = rows[0] as Record<string, unknown>;
  const xml = buildVendorModQbxml(toVendorSnapshot(v), "TESTSEQ");
  console.log("\n--- XML ---\n" + xml.replace(/></g, ">\n<"));
  const bad = [...Buffer.from(xml, "utf8")].filter(b => b < 0x20 && b !== 9 && b !== 10 && b !== 13);
  console.log("\nbytes ilegales en el XML entero:", bad.length);
}
