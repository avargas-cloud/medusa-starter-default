/**
 * Normalizes active FO, PO, Vendor Bill, and Inventory Transfer snapshots to
 * the canonical vendor display name: company_name -> full_name -> name -> id.
 *
 * Dry-run by default:
 *   yarn medusa exec src/scripts/fix/normalize-vendor-name-snapshots.ts
 * Apply:
 *   yarn medusa exec src/scripts/fix/normalize-vendor-name-snapshots.ts apply
 */
import type { ExecArgs } from "@medusajs/framework/types";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

const TABLES = [
  "factory_order",
  "purchase_order",
  "vendor_bill",
  "inventory_transfer",
] as const;
const APPLY = process.argv.includes("apply") || process.env.APPLY === "1";

function canonicalSql(alias: string): string {
  return `COALESCE(
    NULLIF(BTRIM(${alias}.company_name), ''),
    NULLIF(BTRIM(${alias}.full_name), ''),
    NULLIF(BTRIM(${alias}.name), ''),
    ${alias}.id
  )`;
}

export default async function normalizeVendorNameSnapshots({
  container,
}: ExecArgs): Promise<void> {
  const knex = container.resolve("__pg_connection__") as KnexLike;
  const plan: Array<{ table: string; count: number }> = [];

  for (const table of TABLES) {
    const result = await knex.raw(
      `SELECT COUNT(*)::int AS count
         FROM ${table} d
         JOIN qb_vendor v ON v.id = d.vendor_id AND v.deleted_at IS NULL
        WHERE d.deleted_at IS NULL
          AND d.vendor_name_snapshot IS DISTINCT FROM ${canonicalSql("v")}`
    );
    plan.push({ table, count: Number(result.rows[0]?.count ?? 0) });
  }

  console.table(plan);
  if (!APPLY) {
    console.log("DRY RUN — pass positional 'apply' to normalize these rows.");
    return;
  }

  const trx = await knex.transaction();
  try {
    for (const { table } of plan) {
      await trx.raw(
        `UPDATE ${table} d
            SET vendor_name_snapshot = ${canonicalSql("v")},
                updated_at = NOW()
           FROM qb_vendor v
          WHERE v.id = d.vendor_id
            AND v.deleted_at IS NULL
            AND d.deleted_at IS NULL
            AND d.vendor_name_snapshot IS DISTINCT FROM ${canonicalSql("v")}`
      );
    }
    await trx.commit();
    console.log("APPLY complete.");
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}
