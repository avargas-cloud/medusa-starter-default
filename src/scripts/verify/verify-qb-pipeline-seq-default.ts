/**
 * verify-qb-pipeline-seq-default.ts
 *
 * Gate for Migration20260910120000: inserting through the module service must
 * succeed on qb_item_pipeline AND qb_vendor_pipeline, and `seq` must come back
 * populated and increasing — even though the DML hook sends `seq = NULL`
 * (MikroORM 6.6 / Medusa 2.16). Without the trigger every item add/mod and
 * vendor create fails with "Cannot set field 'seq' of ... to null".
 *
 * Zero residue: every row it creates is hard-deleted in a finally block.
 * Mutation-tested: `drop trigger trg_qb_item_pipeline_seq_default` → FAIL.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-pipeline-seq-default.ts
 */

import type { ExecArgs } from "@medusajs/framework/types";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

type Catalog = {
  createQbItemPipelines: (d: Record<string, unknown>) => Promise<{ id: string }>;
  createQbVendorPipelines: (d: Record<string, unknown>) => Promise<{ id: string }>;
};
type Pg = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

const CASES = [
  {
    table: "qb_item_pipeline",
    create: "createQbItemPipelines",
    input: { variant_id: "variant_verify_seq", sku: "VERIFY-SEQ-DEFAULT", op_action: "add" },
  },
  {
    table: "qb_vendor_pipeline",
    create: "createQbVendorPipelines",
    input: { vendor_id: "qbven_verify_seq", vendor_name: "VERIFY SEQ DEFAULT", op_type: "create" },
  },
] as const;

export default async function verify({ container }: ExecArgs): Promise<void> {
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as unknown as Catalog;
  const pg = container.resolve("__pg_connection__") as unknown as Pg;

  const created: Array<{ table: string; id: string }> = [];
  const failures: string[] = [];

  try {
    for (const c of CASES) {
      const trigger = await pg.raw(
        `select 1 from pg_trigger where tgname = ? and not tgisinternal`,
        [`trg_${c.table}_seq_default`]
      );
      if (trigger.rows.length !== 1) {
        failures.push(`${c.table}: trigger trg_${c.table}_seq_default missing`);
      }

      const seqs: number[] = [];
      for (let i = 0; i < 2; i++) {
        try {
          const row = await catalog[c.create](c.input);
          created.push({ table: c.table, id: row.id });
          const { rows } = await pg.raw(`select seq from ${c.table} where id = ?`, [row.id]);
          const seq = Number(rows[0]?.seq);
          if (!Number.isFinite(seq) || seq <= 0) {
            failures.push(`${c.table}: row ${row.id} has seq=${String(rows[0]?.seq)}`);
          }
          seqs.push(seq);
        } catch (e) {
          failures.push(`${c.table}: insert threw — ${(e as Error).message}`);
        }
      }
      if (seqs.length === 2 && !(seqs[1] > seqs[0])) {
        failures.push(`${c.table}: seq not increasing (${seqs.join(", ")})`);
      }
      console.log(`${c.table}: seq ${seqs.join(" → ") || "n/a"}`);
    }
  } finally {
    for (const { table, id } of created) {
      await pg.raw(`delete from ${table} where id = ?`, [id]);
    }
  }

  if (failures.length) {
    console.error(`❌ verify-qb-pipeline-seq-default FAILED\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("✅ verify-qb-pipeline-seq-default PASSED (item + vendor pipeline inserts, seq auto-assigned)");
}
