/**
 * number-adopted-vendor-bills.ts
 *
 * Asigna `VB-####` a los vendor bills que quedaron SIN `number`: la tanda
 * adoptada desde QuickBooks el 07/24–07/28/2026 es anterior a la regla de
 * numeración del backfill (`nextBackfillBillNumber`, 09/11/2026) y el POS los
 * listaba por su id interno (`vb_01k…`), que no identifica nada.
 *
 * Usa la MISMA regla que el importador: antes del go-live del POS va al rango
 * histórico `VB-0001..0999`; desde el go-live toma `custom_vendor_bill_seq`.
 * Orden: `document_date, created_at` (cronológico). Sólo bills vivos: un bill
 * borrado no consume secuencia. `bank_journal_entry` NO se toca — reference /
 * description entran en el `input_hash` de extractos cerrados, y el guard de
 * renumber sólo admite bank_check/bank_transfer.
 *
 * DRY RUN por default; `APPLY=true` escribe, todo en UNA transacción, y falla
 * ruidosamente (rollback) si alguna fila no matchea `number IS NULL`.
 *
 * Usage:
 *   cd backend
 *   env DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/fix/number-adopted-vendor-bills.ts
 *   env DATABASE_URL=… APPLY=true ./node_modules/.bin/tsx src/scripts/fix/number-adopted-vendor-bills.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { nextBackfillBillNumber } from "../../lib/qb-backfill/create-bill";

const APPLY = process.env.APPLY === "true";

interface UnnumberedBill {
  id: string;
  bill_type: string;
  status: string;
  document_date: string;
  reference_id: string | null;
  qb_ref_number: string | null;
  qb_source: string | null;
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log(
      `\n⚙️  number-adopted-vendor-bills — ${APPLY ? "⚡ APPLY" : "DRY RUN (no writes)"}\n`
    );

    const { rows: bills } = await client.query<UnnumberedBill>(
      `SELECT id, bill_type, status, to_char(document_date, 'YYYY-MM-DD') AS document_date,
              reference_id, qb_ref_number, qb_source
         FROM vendor_bill
        WHERE number IS NULL AND deleted_at IS NULL
        ORDER BY document_date, created_at`
    );
    const { rows: seqRows } = await client.query<{ last_value: string }>(
      `SELECT last_value FROM custom_vendor_bill_seq`
    );
    const { rows: maxRows } = await client.query<{ max_n: string | null }>(
      `SELECT max(substring(number FROM '[0-9]+$')::bigint) AS max_n
         FROM vendor_bill WHERE number ~ '^VB-[1-9][0-9]{3,}$'`
    );
    const seqLast = Number(seqRows[0].last_value);
    const maxN = Number(maxRows[0].max_n ?? 0);
    console.log(`Bills sin número (vivos): ${bills.length}`);
    console.log(`custom_vendor_bill_seq.last_value = ${seqLast} · max(VB-####) en tabla = ${maxN}`);
    if (seqLast < maxN) {
      console.error(`❌ La secuencia (${seqLast}) va DETRÁS del máximo usado (${maxN}) — chocaría. Abort.`);
      process.exit(1);
    }
    if (bills.length === 0) {
      console.log("✅ Nada que numerar.");
      return;
    }

    await client.query("BEGIN");
    const assigned: Array<{ id: string; number: string; document_date: string; reference_id: string | null }> = [];
    for (const bill of bills) {
      // nextval() consume la secuencia aunque la tx haga rollback: en dry run
      // no se llama, se proyecta desde last_value.
      const number = APPLY
        ? await nextBackfillBillNumber(client, bill.document_date)
        : `VB-${seqLast + assigned.length + 1}${bill.document_date < "2026-04-14" ? " (rango histórico!)" : ""}`;
      if (APPLY) {
        const res = await client.query(
          `UPDATE vendor_bill SET number = $1, updated_at = now()
            WHERE id = $2 AND number IS NULL AND deleted_at IS NULL`,
          [number, bill.id]
        );
        if (res.rowCount !== 1) {
          throw new Error(`UPDATE de ${bill.id} afectó ${res.rowCount} filas (esperaba 1) — rollback`);
        }
      }
      assigned.push({ id: bill.id, number, document_date: bill.document_date, reference_id: bill.reference_id });
    }

    console.table(assigned);

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("\n🧪 Dry run — nada escrito. Re-correr con APPLY=true para aplicar.");
      return;
    }

    // Post-check dentro de la tx: cero vivos sin número, cero duplicados.
    const { rows: leftover } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM vendor_bill WHERE number IS NULL AND deleted_at IS NULL`
    );
    const { rows: dups } = await client.query<{ number: string; n: string }>(
      `SELECT number, count(*)::text AS n FROM vendor_bill WHERE number IS NOT NULL GROUP BY number HAVING count(*) > 1`
    );
    if (leftover[0].n !== "0" || dups.length > 0) {
      await client.query("ROLLBACK");
      console.error(`❌ Post-check falló: sin número=${leftover[0].n}, duplicados=${JSON.stringify(dups)} — rollback`);
      process.exit(1);
    }
    await client.query("COMMIT");
    console.log(`\n✅ ${assigned.length} bills numerados (${assigned[0].number} … ${assigned[assigned.length - 1].number}).`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
