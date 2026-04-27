/**
 * Checks for monthly sales data that should be loaded but isn't, and returns
 * human-readable warnings. The April 2026 case is special: Medusa went live
 * 2026-04-14 so it can't generate a complete April from pos_invoice; we depend
 * on the QuickBooks Excel import for that one calendar month. If it's missing,
 * EVERY product will show 0 sales for that quarter slot — the warning is
 * critical so it stays loud through May–June 2026 until April is loaded.
 */

const APRIL_2026 = "2026-04-01";
const MIN_VARIANTS_REQUIRED = 50;

export interface DataWarning {
  level: "warning" | "critical";
  code: string;
  message: string;
  action?: string;
}

/** Minimal pg surface — accepts both pg.Client and pg.PoolClient. */
interface QueryRunner {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: T[] }>;
}

/** Returns warnings about missing or incomplete monthly sales data. */
export async function checkMissingSalesData(
  db: QueryRunner
): Promise<DataWarning[]> {
  const warnings: DataWarning[] = [];

  // Only check April 2026 between 2026-05-01 and 2026-06-30. Outside that
  // window the warning is either premature (April still has time) or stale
  // (the engine has moved past it via the rolling window).
  const todayET = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  if (todayET >= "2026-05-01" && todayET <= "2026-06-30") {
    const res = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT variant_id)::text AS count
       FROM purchasing_sales_history
       WHERE month_date = $1::date
         AND source = 'excel_import'
         AND qty_sold > 0`,
      [APRIL_2026]
    );
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    if (count < MIN_VARIANTS_REQUIRED) {
      warnings.push({
        level: "critical",
        code: "MISSING_APRIL_2026_QB_IMPORT",
        message: `¡CARGAR ABRIL 2026 DESDE QUICKBOOKS! Solo ${count} variants encontradas (necesario ≥${MIN_VARIANTS_REQUIRED}). Sin esta carga, todos los productos mostrarán 0 ventas para abril 2026 en sus quarters.`,
        action:
          "npx medusa exec ./src/scripts/sync/import-monthly-sales-history.ts (con archivo Excel de QuickBooks para abril 2026)",
      });
    }
  }

  return warnings;
}
