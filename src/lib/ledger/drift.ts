import type { PoolClient } from "pg";

import { getBusinessDateString } from "../date/et";

import { currentVendorBillSourceHash, postVendorBill, reverseVendorBill } from "./documents/vendor-bill";
import { LedgerError } from "./types";

export interface DriftReport {
  checked: number;
  drifted: number;
  reversed: number;
  reposted: number;
  blocked: Array<{ source_id: string; code: string }>;
}

const DRIFT_ACTOR = "ledger-reconciler";
const BLOCK_CAP = 200;

/**
 * gl-purchases-v2 §5: SÓLO `vendor_bill` tiene semántica de "reconfirm" —
 * reopen reescribe costos/revisión y el hash del snapshot cambia sin que
 * ningún estado terminal (status) haya cambiado. `po_receipt`/`vendor_credit`/
 * `vendor_bill_payment` no se reconfirman (una vez posteados sus hechos no
 * se reescriben), así que el reconciler los cubre enteramente con
 * `replayLedger` (post/reverse por terminalidad) — este helper es sólo para
 * el kind que puede quedar VIVO con una entrada activa cuyo hash ya no
 * coincide con el snapshot actual.
 *
 * Para cada entrada `document` activa de `vendor_bill`: si el hash actual
 * difiere del guardado → `reverseVendorBill` (día = HOY ET, no el `updated_at`
 * del bill — §5 lo especifica así porque el drift se DETECTA hoy, aunque el
 * bill se haya reconfirmado ayer) + `postVendorBill` (día = su propio
 * `document_date`/`confirmed_at`, ya lo resuelve el loader). Cada bill corre
 * en su propio SAVEPOINT: un bloqueo (período cerrado, cuenta faltante) no
 * tumba el resto de la corrida.
 */
export async function reconcilePurchaseDrift(
  client: PoolClient,
  options: { limit?: number } = {}
): Promise<DriftReport> {
  const limit = options.limit ?? 200;
  const today = getBusinessDateString();

  const { rows } = await client.query<{ source_id: string; source_hash: string }>(
    `SELECT e.source_id, e.source_hash
     FROM bank_journal_entry e
     WHERE e.kind = 'document' AND e.source_kind = 'vendor_bill'
       AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
     ORDER BY e.created_at
     LIMIT $1`,
    [limit]
  );

  const report: DriftReport = { checked: 0, drifted: 0, reversed: 0, reposted: 0, blocked: [] };

  for (const row of rows) {
    report.checked++;
    const currentHash = await currentVendorBillSourceHash(client, row.source_id);
    // `null` = el bill ya no está en un status que postee/reverse (raro:
    // cambió a un status intermedio inesperado) — no es drift, se saltea.
    if (currentHash === null || currentHash === row.source_hash) continue;

    report.drifted++;
    const savepoint = `gl_drift_${Math.random().toString(36).slice(2, 12)}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const reversal = await reverseVendorBill(
        client,
        row.source_id,
        DRIFT_ACTOR,
        "drift: snapshot hash changed since posting",
        today
      );
      if (reversal.status === "reversed") report.reversed++;
      const repost = await postVendorBill(client, row.source_id, DRIFT_ACTOR);
      if (repost.status === "posted") report.reposted++;
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      report.blocked.push({
        source_id: row.source_id,
        code: err instanceof LedgerError ? err.code : "GL_SOURCE_INVALID",
      });
      if (report.blocked.length > BLOCK_CAP) report.blocked.shift();
    }
  }

  return report;
}
