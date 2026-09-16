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

  // 2026-09-16 (VB-1149): la selección de candidatos era `ORDER BY e.created_at
  // LIMIT 200` — con 282 asientos activos en prod, los 82 más nuevos jamás se
  // revisaban (VB-1149, editado el 09/15, seguía con el asiento del confirm
  // viejo). Ahora los candidatos son los asientos cuyo BILL cambió DESPUÉS de
  // postearse — por `updated_at` del bill o por una `vendor_bill_revision`
  // creada más tarde (reconfirm) — y se ordenan por lo más recién cambiado
  // primero, con `limit` como tope de SEGURIDAD (ya no de corte ciego).
  const { rows } = await client.query<{ source_id: string; source_hash: string }>(
    `SELECT e.source_id, e.source_hash
     FROM bank_journal_entry e
     JOIN vendor_bill b ON b.id = e.source_id AND b.deleted_at IS NULL
     WHERE e.kind = 'document' AND e.source_kind = 'vendor_bill'
       AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
       AND (
         b.updated_at > e.created_at
         OR EXISTS (
           SELECT 1 FROM vendor_bill_revision vr
            WHERE vr.vendor_bill_id = e.source_id AND vr.created_at > e.created_at
         )
       )
     ORDER BY b.updated_at DESC
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
