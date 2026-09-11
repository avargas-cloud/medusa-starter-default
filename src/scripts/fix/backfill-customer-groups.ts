/**
 * Backfill de membresías de customer group — el grupo `Wholesale` es la única
 * verdad del tier (regla del operador, 2026-09-10) y "sin grupo" = `Retail`.
 *
 * Add-only, mismo plan que el reconciliador en vivo
 * (`lib/customers/reconcile-customer-groups.ts`):
 *   - tier wholesale (metadata price_level/is_wholesale de QB) y NO está en
 *     Wholesale → se agrega a Wholesale;
 *   - sin ningún grupo → se agrega a Retail.
 * Nunca quita a nadie de un grupo.
 *
 * Gates de /safe-backfill:
 *   - dry-run y apply comparten `buildPlan`; la rama sólo cambia en la
 *     persistencia (`APPLY=true`).
 *   - snapshot agregado antes/después de lo que NO debe moverse
 *     (price, price_list, price_list_rule, customer sin la clave de auditoría,
 *     customer_group) → `diffSnapshot` exige cero diferencias.
 *   - una sola transacción; la auditoría (`customer.metadata.group_backfill`,
 *     write-once) va PRIMERO; el INSERT usa UNNEST en lotes de 500 y
 *     `NOT EXISTS` sobre la membresía viva (compare-and-swap).
 *   - idempotente: un segundo run del mismo plan escribe 0 filas.
 *
 * Run (siempre con env explícito):
 *   env DATABASE_URL=... yarn medusa exec ./src/scripts/fix/backfill-customer-groups.ts
 *   APPLY=true env DATABASE_URL=... yarn medusa exec ./src/scripts/fix/backfill-customer-groups.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateEntityId } from "@medusajs/utils";
import type { Knex } from "@mikro-orm/knex";

import { resolveCustomerTier } from "../../lib/customers/customer-tier";
import { planCustomerGroupReconcile } from "../../lib/customers/reconcile-customer-groups";

const BATCH = 500;
const AUDIT_KEY = "group_backfill";

interface CustomerRow {
  id: string;
  metadata: Record<string, unknown> | null;
  group_ids: string[] | null;
  group_names: string[] | null;
}

interface GroupIds {
  wholesale: string;
  retail: string;
}

export interface PlannedAdd {
  customer_id: string;
  group_id: string;
  reason: "wholesale_by_metadata" | "no_group";
}

/** Pure: same rule as the live reconciler, applied to every customer. */
export function buildPlan(rows: readonly CustomerRow[], groups: GroupIds): PlannedAdd[] {
  const adds: PlannedAdd[] = [];
  for (const row of rows) {
    const memberGroupIds = row.group_ids ?? [];
    const tier = resolveCustomerTier({
      groups: (row.group_names ?? []).map((name) => ({ name })),
      metadata: row.metadata,
    });
    const plan = planCustomerGroupReconcile({
      tier,
      memberGroupIds,
      wholesaleGroupId: groups.wholesale,
      retailGroupId: groups.retail,
    });
    for (const group_id of plan.add) {
      adds.push({
        customer_id: row.id,
        group_id,
        reason: group_id === groups.wholesale ? "wholesale_by_metadata" : "no_group",
      });
    }
  }
  return adds;
}

async function loadGroupIds(knex: Knex): Promise<GroupIds> {
  const rows = (await knex.raw(
    `SELECT id, name FROM customer_group WHERE deleted_at IS NULL AND lower(name) IN ('wholesale','retail')`
  )).rows as Array<{ id: string; name: string }>;
  const wholesale = rows.find((r) => r.name.toLowerCase() === "wholesale")?.id;
  const retail = rows.find((r) => r.name.toLowerCase() === "retail")?.id;
  if (!wholesale || !retail) {
    throw new Error(`customer groups missing: wholesale=${wholesale ?? "∅"} retail=${retail ?? "∅"}`);
  }
  return { wholesale, retail };
}

async function loadCustomers(knex: Knex): Promise<CustomerRow[]> {
  const res = await knex.raw(`
    SELECT c.id, c.metadata,
           array_remove(array_agg(cg.id), NULL)   AS group_ids,
           array_remove(array_agg(cg.name), NULL) AS group_names
    FROM customer c
    LEFT JOIN customer_group_customer cgc
      ON cgc.customer_id = c.id AND cgc.deleted_at IS NULL
    LEFT JOIN customer_group cg
      ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL
    WHERE c.deleted_at IS NULL
    GROUP BY c.id, c.metadata
    ORDER BY c.id
  `);
  return res.rows as CustomerRow[];
}

/** Aggregate snapshot of everything that must NOT move. */
async function snapshot(knex: Knex): Promise<string[]> {
  const q = async (label: string, sql: string): Promise<string> => {
    const r = await knex.raw(sql);
    return `${label}: ${JSON.stringify(r.rows[0])}`;
  };
  return Promise.all([
    q("price", `SELECT count(*) n, md5(string_agg(id||':'||coalesce(amount::text,'')||':'||coalesce(price_list_id,''), ',' ORDER BY id)) h FROM price WHERE deleted_at IS NULL`),
    q("price_list", `SELECT count(*) n, md5(string_agg(id||':'||status, ',' ORDER BY id)) h FROM price_list WHERE deleted_at IS NULL`),
    q("price_list_rule", `SELECT count(*) n, md5(string_agg(id||':'||coalesce(value::text,''), ',' ORDER BY id)) h FROM price_list_rule WHERE deleted_at IS NULL`),
    q("customer_group", `SELECT count(*) n, md5(string_agg(id||':'||name, ',' ORDER BY id)) h FROM customer_group WHERE deleted_at IS NULL`),
    q("customer(sin auditoría)", `SELECT count(*) n, md5(string_agg(id||':'||coalesce(email,'')||':'||coalesce((metadata - '${AUDIT_KEY}')::text,''), ',' ORDER BY id)) h FROM customer WHERE deleted_at IS NULL`),
    q("membresías vivas", `SELECT count(*) n FROM customer_group_customer WHERE deleted_at IS NULL`),
    q("membresías borradas", `SELECT count(*) n FROM customer_group_customer WHERE deleted_at IS NOT NULL`),
  ]);
}

function diffSnapshot(before: string[], after: string[], expectedNewMemberships: number): string[] {
  const problems: string[] = [];
  before.forEach((line, i) => {
    const other = after[i];
    if (line.startsWith("membresías vivas")) {
      const n0 = Number(JSON.parse(line.slice(line.indexOf(":") + 1)).n);
      const n1 = Number(JSON.parse(other.slice(other.indexOf(":") + 1)).n);
      if (n1 - n0 !== expectedNewMemberships) {
        problems.push(`membresías vivas: esperado +${expectedNewMemberships}, fue +${n1 - n0}`);
      }
      return;
    }
    if (line !== other) problems.push(`MOVIÓ: ${line}  →  ${other}`);
  });
  return problems;
}

async function applyPlan(knex: Knex, adds: readonly PlannedAdd[], runId: string): Promise<number> {
  let inserted = 0;
  await knex.transaction(async (trx) => {
    // 1. Auditoría primero, write-once: la clave nunca se reescribe.
    const customerIds = [...new Set(adds.map((a) => a.customer_id))];
    for (let i = 0; i < customerIds.length; i += BATCH) {
      const slice = customerIds.slice(i, i + BATCH);
      const audit = slice.map((cid) => JSON.stringify({
        run_id: runId,
        at: new Date().toISOString(),
        added: adds.filter((a) => a.customer_id === cid).map((a) => ({ group_id: a.group_id, reason: a.reason })),
      }));
      await trx.raw(
        `UPDATE customer c
            SET metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('${AUDIT_KEY}', u.audit::jsonb),
                updated_at = now()
           FROM unnest(?::text[], ?::text[]) AS u(id, audit)
          WHERE c.id = u.id AND c.deleted_at IS NULL
            AND (c.metadata IS NULL OR c.metadata -> '${AUDIT_KEY}' IS NULL)`,
        [slice, audit]
      );
    }
    // 2. Membresías: INSERT sólo si no existe una viva (compare-and-swap).
    for (let i = 0; i < adds.length; i += BATCH) {
      const slice = adds.slice(i, i + BATCH);
      const ids = slice.map(() => generateEntityId("", "cusgc"));
      const res = await trx.raw(
        `INSERT INTO customer_group_customer (id, customer_id, customer_group_id, created_at, updated_at, metadata)
         SELECT u.id, u.customer_id, u.group_id, now(), now(), jsonb_build_object('backfill_run_id', ?::text)
           FROM unnest(?::text[], ?::text[], ?::text[]) AS u(id, customer_id, group_id)
          WHERE NOT EXISTS (
                  SELECT 1 FROM customer_group_customer x
                   WHERE x.customer_id = u.customer_id
                     AND x.customer_group_id = u.group_id
                     AND x.deleted_at IS NULL)`,
        [runId, ids, slice.map((a) => a.customer_id), slice.map((a) => a.group_id)]
      );
      inserted += Number(res.rowCount ?? 0);
    }
  });
  return inserted;
}

export default async function backfillCustomerGroups({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve<Knex>(ContainerRegistrationKeys.PG_CONNECTION);
  const apply = process.env.APPLY === "true";
  const runId = `cgbf_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

  const groups = await loadGroupIds(knex);
  const rows = await loadCustomers(knex);
  const adds = buildPlan(rows, groups);
  const byReason = adds.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.reason]: (acc[a.reason] ?? 0) + 1 }), {});
  console.log(`[${runId}] clientes=${rows.length} plan=${adds.length} ${JSON.stringify(byReason)} apply=${apply}`);
  console.log(`  primeros 5: ${JSON.stringify(adds.slice(0, 5))}`);

  if (!apply) {
    console.log("DRY-RUN — nada escrito. APPLY=true para aplicar.");
    return;
  }
  if (adds.length === 0) {
    console.log("Plan vacío — punto fijo, nada que aplicar.");
    return;
  }

  const before = await snapshot(knex);
  const inserted = await applyPlan(knex, adds, runId);
  const after = await snapshot(knex);
  const problems = diffSnapshot(before, after, inserted);
  console.log(`insertadas=${inserted} (plan ${adds.length})`);
  if (inserted !== adds.length) {
    problems.push(`insertadas ${inserted} ≠ plan ${adds.length} (¿otro proceso agregó membresías en el medio?)`);
  }
  if (problems.length > 0) {
    console.error("SNAPSHOT DIFF — revisar:");
    problems.forEach((p) => console.error("  " + p));
    process.exitCode = 1;
    return;
  }
  const replan = buildPlan(await loadCustomers(knex), groups);
  console.log(`re-plan tras aplicar: ${replan.length} (esperado 0)`);
  if (replan.length !== 0) process.exitCode = 1;
}
