/**
 * verify-adopt-qb-bank-documents — invariantes de la adopción de documentos bancarios de
 * QuickBooks (plan adopt-qb-bank-documents-20260915), de sólo lectura. Sirve en el clon y en
 * producción (post-deploy: prueba que la migración llegó; post-apply: prueba el resultado).
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-adopt-qb-bank-documents.ts [--statements]
 *
 * `--statements` además recorre cada extracto CERRADO con `statementContext` y exige
 * `needs_review=false` y sin `BANKING_STATEMENT_MATCH_SOURCE_DRIFT` (lento: reconstruye el libro
 * de cada uno; en prod son decenas). Sale 1 si algo falla.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { statementContext } from "../../lib/banking/statement-read";
import { checkAdoptionInvariants } from "../../lib/ledger/adopt/invariants";

async function main(): Promise<void> {
  const client = await getDbPool().connect();
  try {
    const r = await checkAdoptionInvariants(client);
    console.log(`adoptados vivos: ${r.checks} gl_check · ${r.transfers} gl_transfer`);
    const failures = [...r.failures];
    if (process.argv.includes("--statements")) {
      const { rows } = await client.query<{ id: string; account_list_id: string; from_day: string; to_day: string }>(
        `SELECT id, account_list_id, from_day, to_day FROM bank_statement WHERE status='closed' AND deleted_at IS NULL ORDER BY account_list_id, from_day`
      );
      let clean = 0;
      for (const s of rows) {
        const ctx = await statementContext(client, s.id);
        const drift = ctx.blockers.includes("BANKING_STATEMENT_MATCH_SOURCE_DRIFT");
        if (ctx.needs_review || drift) failures.push(`f. extracto ${s.account_list_id} ${s.from_day}..${s.to_day}: needs_review=${ctx.needs_review} drift=${drift}`);
        else clean += 1;
      }
      console.log(`extractos cerrados limpios: ${clean}/${rows.length}`);
    }
    for (const f of failures) console.log(`  ✗ ${f}`);
    console.log(failures.length ? `verify-adopt-qb-bank-documents: ${failures.length} FALLARON` : "verify-adopt-qb-bank-documents: OK");
    process.exit(failures.length ? 1 : 0);
  } finally {
    client.release();
  }
}

main().catch((e: unknown) => {
  console.error("verify-adopt-qb-bank-documents:", e instanceof Error ? e.message : e);
  process.exit(1);
});
