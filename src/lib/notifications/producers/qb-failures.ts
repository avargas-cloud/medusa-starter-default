/**
 * Fila del pipeline QB en `failed` → SÓLO el owner (decisión del user 09/17).
 *
 * Se observa `qb_order_pipeline` (los documentos de venta) cada 5 min. La
 * huella del error entra en el dedupe: un retry que vuelve a fallar con el
 * MISMO error no re-avisa; uno que falla distinto sí, porque es otra noticia.
 * Ventana de 24 h por la misma razón que los pagos.
 */

import { createHash } from "node:crypto";

import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { truncate } from "./format";
import { SALES_SQL } from "../../quickbooks/pipeline-status";

export const QB_FAILURE_WINDOW_HOURS_DEFAULT = 24;

export interface QbFailedRow {
  id: string;
  order_id: string | null;
  step: string | null;
  reference_type: string | null;
  reference_id: string | null;
  medusa_ref_number: string | null;
  qb_ref_number: string | null;
  error: string | null;
  failed_at: string | Date | null;
  retry_count: number | null;
}

export function errorFingerprint(error: string | null | undefined): string {
  return createHash("md5").update((error ?? "").trim()).digest("hex").slice(0, 12);
}

export function qbFailureDedupeKey(rowId: string, error: string | null | undefined): string {
  return `qb_failed:${rowId}:${errorFingerprint(error)}`;
}

export const QB_FAILED_SCAN_SQL = `
  SELECT p.id::text AS id, p.order_id, p.step, p.reference_type, p.reference_id,
         p.medusa_ref_number, p.qb_ref_number, p.error, p.failed_at, p.retry_count
    FROM qb_order_pipeline p
   WHERE p.status IN (${SALES_SQL.failed})
     AND p.failed_at > NOW() - ($1::int * INTERVAL '1 hour')
     AND NOT EXISTS (
       SELECT 1 FROM pos_notification n
        WHERE n.dedupe_key = 'qb_failed:' || p.id::text || ':' || left(md5(COALESCE(btrim(p.error), '')), 12)
     )
   ORDER BY p.failed_at ASC
   LIMIT 100`;

export function buildQbFailureNotification(row: QbFailedRow) {
  const doc = row.medusa_ref_number ?? row.qb_ref_number ?? row.reference_id ?? row.id;
  return {
    kind: "qb_pipeline_failed" as const,
    severity: "critical" as const,
    title: `QB sync failed — ${row.step ?? "step"} ${doc}`,
    body: truncate(row.error, 240) ?? "No error message recorded",
    action_url: row.order_id ? `/orders/${row.order_id}` : "/quickbooks",
    entity_type: "qb_order_pipeline",
    entity_id: row.id,
    payload: {
      order_id: row.order_id,
      step: row.step,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
      retry_count: row.retry_count,
      fingerprint: errorFingerprint(row.error),
    },
    dedupe_key: qbFailureDedupeKey(row.id, row.error),
    occurred_at: row.failed_at,
    audiences: [{ kind: "owner" as const }],
  };
}

export async function produceQbFailureNotifications(
  db: Db,
  opts: { windowHours?: number } = {}
): Promise<{ scanned: number; created: number; results: PublishResult[] }> {
  const { rows } = await db.query<QbFailedRow>(QB_FAILED_SCAN_SQL, [
    opts.windowHours ?? QB_FAILURE_WINDOW_HOURS_DEFAULT,
  ]);
  const results: PublishResult[] = [];
  for (const row of rows) {
    results.push(await publishNotification(db, buildQbFailureNotification(row)));
  }
  return { scanned: rows.length, created: results.filter((r) => r.created).length, results };
}
