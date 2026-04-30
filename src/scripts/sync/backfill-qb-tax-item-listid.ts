/**
 * backfill-qb-tax-item-listid.ts
 *
 * Backfills `metadata.qb_tax_item_listid` on existing documents (pos_invoice,
 * pos_credit_memo, order) where it is missing. The ListID is chosen by the
 * existing tax math: tax > 0 → QB_TAX_ITEM_LISTID_TAXED, else EXEMPT.
 *
 * Idempotent — re-running is a no-op once all rows are populated.
 * Default mode is `--dry-run` (counts only). Pass `--apply` to commit.
 *
 * Usage:
 *   npx ts-node src/scripts/sync/backfill-qb-tax-item-listid.ts            # dry-run
 *   npx ts-node src/scripts/sync/backfill-qb-tax-item-listid.ts --apply    # commit
 */

import { Client } from "pg";

import { getQbConfig } from "../../lib/quickbooks/qb-config";

interface TablePlan {
  table: string;
  /**
   * Strategy for deciding TAXED vs EXEMPT.
   *  - "tax_column": COALESCE(<col>, 0) > 0 → TAXED, else EXEMPT
   *  - "metadata_tax_mode": metadata->>'tax_mode' = 'florida' → TAXED,
   *                        metadata->>'tax_mode' = 'exempt' → EXEMPT,
   *                        else skip the row
   */
  strategy: "tax_column" | "metadata_tax_mode";
  taxColumn?: string;
  description: string;
}

const TABLES: TablePlan[] = [
  {
    table: "pos_invoice",
    strategy: "tax_column",
    taxColumn: "tax",
    description: "POS invoices",
  },
  {
    table: "pos_credit_memo",
    strategy: "tax_column",
    taxColumn: "tax",
    description: "POS credit memos",
  },
  {
    // Medusa order: tax math lives in order_summary view, not on the row.
    // We use metadata.tax_mode (set by the POS UI's compute-tax POST).
    // Orders without tax_mode are skipped — handler fallback to FullName covers them.
    table: '"order"',
    strategy: "metadata_tax_mode",
    description: "Medusa orders",
  },
];

interface RunOpts {
  apply: boolean;
}

function whereTaxed(plan: TablePlan): string {
  if (plan.strategy === "tax_column") {
    return `COALESCE(${plan.taxColumn}, 0) > 0`;
  }
  return `metadata->>'tax_mode' = 'florida'`;
}

function whereExempt(plan: TablePlan): string {
  if (plan.strategy === "tax_column") {
    return `COALESCE(${plan.taxColumn}, 0) = 0`;
  }
  return `metadata->>'tax_mode' = 'exempt'`;
}

async function countMissing(
  client: Client,
  plan: TablePlan
): Promise<{ taxedCount: number; exemptCount: number; alreadySet: number }> {
  const taxedRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM ${plan.table}
      WHERE (metadata IS NULL OR metadata->>'qb_tax_item_listid' IS NULL)
        AND ${whereTaxed(plan)}`
  );
  const exemptRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM ${plan.table}
      WHERE (metadata IS NULL OR metadata->>'qb_tax_item_listid' IS NULL)
        AND ${whereExempt(plan)}`
  );
  const alreadySetRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM ${plan.table}
      WHERE metadata->>'qb_tax_item_listid' IS NOT NULL`
  );
  return {
    taxedCount: parseInt(taxedRes.rows[0]?.count ?? "0", 10),
    exemptCount: parseInt(exemptRes.rows[0]?.count ?? "0", 10),
    alreadySet: parseInt(alreadySetRes.rows[0]?.count ?? "0", 10),
  };
}

async function applyBackfill(
  client: Client,
  plan: TablePlan,
  taxedListid: string,
  exemptListid: string
): Promise<{ taxedUpdated: number; exemptUpdated: number }> {
  const taxedRes = await client.query(
    `UPDATE ${plan.table}
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{qb_tax_item_listid}',
              to_jsonb($1::text)
            )
      WHERE (metadata IS NULL OR metadata->>'qb_tax_item_listid' IS NULL)
        AND ${whereTaxed(plan)}`,
    [taxedListid]
  );
  const exemptRes = await client.query(
    `UPDATE ${plan.table}
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{qb_tax_item_listid}',
              to_jsonb($1::text)
            )
      WHERE (metadata IS NULL OR metadata->>'qb_tax_item_listid' IS NULL)
        AND ${whereExempt(plan)}`,
    [exemptListid]
  );
  return {
    taxedUpdated: taxedRes.rowCount ?? 0,
    exemptUpdated: exemptRes.rowCount ?? 0,
  };
}

async function main(opts: RunOpts): Promise<void> {
  const config = await getQbConfig();
  const taxedListid = config.taxItemListidTaxed;
  const exemptListid = config.taxItemListidExempt;

  if (!taxedListid || !exemptListid) {
    console.error(
      `[backfill] FATAL: QB_TAX_ITEM_LISTID_TAXED and QB_TAX_ITEM_LISTID_EXEMPT must be set in env.\n` +
        `   QB_TAX_ITEM_LISTID_TAXED=${taxedListid ?? "(missing)"}\n` +
        `   QB_TAX_ITEM_LISTID_EXEMPT=${exemptListid ?? "(missing)"}`
    );
    process.exit(1);
  }

  console.log(`[backfill] Mode: ${opts.apply ? "APPLY" : "DRY RUN"}`);
  console.log(`[backfill] TAXED ListID:  ${taxedListid}`);
  console.log(`[backfill] EXEMPT ListID: ${exemptListid}`);
  console.log("");

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  let totalTaxed = 0;
  let totalExempt = 0;
  let totalAlreadySet = 0;

  try {
    for (const plan of TABLES) {
      const counts = await countMissing(client, plan);
      console.log(
        `[backfill] ${plan.table.padEnd(20)} (${plan.description})`
      );
      console.log(
        `             missing+taxed:  ${counts.taxedCount.toString().padStart(6)}`
      );
      console.log(
        `             missing+exempt: ${counts.exemptCount.toString().padStart(6)}`
      );
      console.log(
        `             already set:    ${counts.alreadySet.toString().padStart(6)}`
      );

      if (opts.apply && counts.taxedCount + counts.exemptCount > 0) {
        const result = await applyBackfill(
          client,
          plan,
          taxedListid,
          exemptListid
        );
        console.log(
          `             ✅ updated taxed:  ${result.taxedUpdated.toString().padStart(6)}`
        );
        console.log(
          `             ✅ updated exempt: ${result.exemptUpdated.toString().padStart(6)}`
        );
        totalTaxed += result.taxedUpdated;
        totalExempt += result.exemptUpdated;
      } else {
        totalTaxed += counts.taxedCount;
        totalExempt += counts.exemptCount;
      }
      totalAlreadySet += counts.alreadySet;
      console.log("");
    }

    console.log(`[backfill] ─────────────────────────────────────────`);
    console.log(
      `[backfill] Totals (${opts.apply ? "applied" : "would apply"}):`
    );
    console.log(`             taxed:       ${totalTaxed}`);
    console.log(`             exempt:      ${totalExempt}`);
    console.log(`             already set: ${totalAlreadySet}`);
    if (!opts.apply) {
      console.log(`\n[backfill] Re-run with --apply to commit changes.`);
    }
  } finally {
    await client.end();
  }
}

const apply = process.argv.includes("--apply");
main({ apply }).catch((err) => {
  console.error(`[backfill] FAILED:`, err);
  process.exit(1);
});
