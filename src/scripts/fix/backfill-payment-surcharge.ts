/**
 * Backfill `customer_payment.surcharge_cents` from metadata for payments
 * written before the column existed (`dejavoo_surcharge_cents` terminal /
 * `bams_surcharge_fee_cents` online — see `lib/finance/payment-surcharge.ts`,
 * the same helper `FinanceModuleService.createCustomerPayments` uses going
 * forward). `amount` is NEVER touched.
 *
 * USAGE
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/backfill-payment-surcharge.ts
 *
 *   APPLY=true   write surcharge_cents for the found set
 *   REVERT=true  set surcharge_cents back to 0 for the same set (undo)
 */
import { surchargeCentsFromMetadata } from "../../lib/finance/payment-surcharge";

interface SurchargeRow {
  id: string;
  metadata: Record<string, unknown> | null;
  received_at: string;
  amount: string;
}

/** Cardinality guard: measured at 672 candidates on 2026-09-14. */
const EXPECTED_MAX = 800;

const SELECT_SQL = `
  SELECT id, metadata, received_at::text, amount::text
    FROM customer_payment
   WHERE deleted_at IS NULL
     AND surcharge_cents = 0
     AND (
       COALESCE((metadata->>'dejavoo_surcharge_cents')::numeric, 0) > 0
       OR COALESCE((metadata->>'bams_surcharge_fee_cents')::numeric, 0) > 0
     )
   ORDER BY received_at
`;

const dollars = (cents: number): string => (cents / 100).toFixed(2);

export default async function backfillPaymentSurcharge({
  container,
}: {
  container: { resolve: (key: string) => unknown };
}) {
  const knex = container.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: any[]; rowCount?: number }>;
    transaction: <T>(handler: (trx: any) => Promise<T>) => Promise<T>;
  };

  const apply = process.env.APPLY === "true";
  const revert = process.env.REVERT === "true";

  const { rows } = await knex.raw(SELECT_SQL);
  const candidates = rows as SurchargeRow[];
  const withSurcharge = candidates
    .map((row) => ({ row, cents: surchargeCentsFromMetadata(row.metadata) }))
    .filter((c) => c.cents > 0);

  console.log("═".repeat(94));
  console.log("  BACKFILL customer_payment.surcharge_cents");
  console.log("═".repeat(94));
  console.log(`  modo    ${revert ? "REVERT" : apply ? "APPLY" : "DRY RUN"}`);
  console.log(`  found   ${withSurcharge.length} payments`);

  if (withSurcharge.length === 0) {
    console.log("  Nada que hacer.");
    return { found: 0, updated: 0 };
  }

  const total = withSurcharge.reduce((sum, c) => sum + c.cents, 0);
  const dates = withSurcharge.map((c) => c.row.received_at).sort();
  console.log(`  total   $${dollars(total)}`);
  console.log(`  rango   ${dates[0]} … ${dates[dates.length - 1]}`);
  console.log("");
  console.log("  top 5:");
  for (const c of withSurcharge.slice(0, 5)) {
    console.log(
      `    ${c.row.id}  ${c.row.received_at}  surcharge $${dollars(c.cents)}  amount $${dollars(Number(c.row.amount))}`
    );
  }

  if (revert) {
    if (!apply) {
      console.log("");
      console.log("DRY RUN — REVERT=true sin APPLY=true no escribe nada.");
      return { found: withSurcharge.length, updated: 0, dryRun: true };
    }
    const ids = withSurcharge.map((c) => c.row.id);
    const result = await knex.raw(
      `UPDATE customer_payment SET surcharge_cents = 0, updated_at = NOW()
        WHERE id = ANY(?::text[])`,
      [ids]
    );
    console.log("");
    console.log(`↩ ${result.rowCount ?? 0} payments revertidos a surcharge_cents = 0.`);
    return { found: withSurcharge.length, updated: result.rowCount ?? 0, reverted: true };
  }

  if (!apply) {
    console.log("");
    console.log("DRY RUN — no se escribió nada. APPLY=true para aplicar.");
    return { found: withSurcharge.length, updated: 0, dryRun: true };
  }

  if (withSurcharge.length > EXPECTED_MAX) {
    throw new Error(
      `${withSurcharge.length} candidatos supera el piso esperado (${EXPECTED_MAX}, medido 672 el 2026-09-14). ` +
        `Revisar antes de aplicar — no es un guardrail decorativo.`
    );
  }

  const updated = await knex.transaction(async (trx) => {
    const result = await trx.raw(
      `UPDATE customer_payment AS t
          SET surcharge_cents = u.cents, updated_at = NOW()
         FROM UNNEST(?::text[], ?::int[]) AS u(id, cents)
        WHERE t.id = u.id AND t.deleted_at IS NULL AND t.surcharge_cents = 0`,
      [withSurcharge.map((c) => c.row.id), withSurcharge.map((c) => c.cents)]
    );
    const applied = result.rowCount ?? 0;
    if (applied !== withSurcharge.length) {
      throw new Error(
        `Se esperaba actualizar ${withSurcharge.length} pagos, coincidieron ${applied}. ` +
          `Alguno cambió después de leer el plan — rollback.`
      );
    }
    return applied;
  });

  console.log("");
  console.log(`✅ ${updated} pagos con surcharge_cents backfilled.`);
  return { found: withSurcharge.length, updated };
}
