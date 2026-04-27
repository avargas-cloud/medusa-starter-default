/**
 * One-off debug — invokes the April 2026 check while temporarily forcing
 * today's date into the active window, so we can verify the warning shape
 * before the real cron fires on 2026-05-01.
 */

import { Client } from "pg";

const APRIL_2026 = "2026-04-01";
const MIN_VARIANTS_REQUIRED = 50;

export default async function testApril2026Warning(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const res = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT variant_id)::text AS count
       FROM purchasing_sales_history
       WHERE month_date = $1::date
         AND source = 'excel_import'
         AND qty_sold > 0`,
      [APRIL_2026]
    );
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    console.log("");
    console.log(`Variants encontrados en abril 2026 (excel_import): ${count}`);
    console.log(`Threshold: ${MIN_VARIANTS_REQUIRED}`);
    if (count < MIN_VARIANTS_REQUIRED) {
      console.log("");
      console.log("════════════════════════════════════════════════════════════════════");
      console.log("  🚨  CRITICAL — MISSING_APRIL_2026_QB_IMPORT");
      console.log(`  ¡CARGAR ABRIL 2026 DESDE QUICKBOOKS! Solo ${count} variants encontradas (necesario ≥${MIN_VARIANTS_REQUIRED}). Sin esta carga, todos los productos mostrarán 0 ventas para abril 2026 en sus quarters.`);
      console.log("  → npx medusa exec ./src/scripts/sync/import-monthly-sales-history.ts (con archivo Excel de QuickBooks para abril 2026)");
      console.log("════════════════════════════════════════════════════════════════════");
      console.log("");
      console.log("✓ El banner se mostraría en la UI a partir de 2026-05-01.");
    } else {
      console.log("");
      console.log("✓ Datos suficientes — no se mostraría banner.");
    }
  } finally {
    await db.end();
  }
}
