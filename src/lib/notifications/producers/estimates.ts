/**
 * Estimates sin seguimiento → el rep, 7 días después de la última actividad,
 * y de nuevo cada 7 días mientras siga abierto (decisión del owner 09/17: por
 * estimate y rolling, no una lista los lunes). Mark as read lo silencia hasta
 * la semana siguiente; el aviso expira a los 7 días para que no se acumulen.
 *
 * "Sin seguimiento" = ya se le ENTREGÓ al cliente (`Sent by Email` /
 * `Provided in Store`) y nadie lo movió: un `Created` que nunca salió es un
 * borrador, no una cotización esperando respuesta (y eran 167 en el sandbox:
 * avisarlos es la inundación que el owner no quiere). `Not Approved` lo trata
 * como cerrado la propia lista de estimates. Sin rep no hay a quién avisar.
 * Ventana 7–90 días: lo más viejo ya es historia.
 */

import { getBusinessDateString } from "../../date/et";
import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { customerLabel } from "./format";

export const ESTIMATE_STALE_DAYS = 7;
export const ESTIMATE_MAX_AGE_DAYS = 90;
export const ESTIMATE_HOUR = 8;
/** Estados que cuentan como "entregado al cliente y esperando" (lowercase). */
export const AWAITING_STATUSES = ["sent by email", "provided in store"];

interface EstimateRow {
  id: string;
  display_id: number | null;
  document_number: string | null;
  order_status: string | null;
  rep_initials: string | null;
  updated_at: string | Date;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

const STALE_SQL = `
  SELECT o.id, o.display_id, o.metadata->>'document_number' AS document_number,
         COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status') AS order_status,
         o.metadata->'sales_rep'->>'initials' AS rep_initials, o.updated_at,
         c.company_name, c.first_name, c.last_name, COALESCE(c.email, o.email) AS email
    FROM "order" o
    LEFT JOIN customer c ON c.id = o.customer_id
   WHERE o.deleted_at IS NULL AND o.status = 'draft' AND o.is_draft_order = true
     AND o.canceled_at IS NULL
     AND lower(COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '')) = ANY($3::text[])
     AND COALESCE(btrim(o.metadata->'sales_rep'->>'initials'), '') <> ''
     AND o.updated_at <= NOW() - ($1::int * INTERVAL '1 day')
     AND o.updated_at >  NOW() - ($2::int * INTERVAL '1 day')
   ORDER BY o.updated_at ASC
   LIMIT 300`;

/** Semana de negocio (ET) desde la época: cambia cada 7 días → re-avisa cada 7. */
export function weekBucket(now: Date = new Date()): number {
  const ymd = getBusinessDateString(now);
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / (7 * 86_400_000));
}

export function estimateDedupeKey(orderId: string, bucket: number): string {
  return `estimate_stale:${orderId}:${bucket}`;
}

export function daysSince(value: string | Date, now: Date = new Date()): number {
  return Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000);
}

export function buildEstimateNotification(row: EstimateRow, now: Date) {
  const doc = row.document_number ?? (row.display_id ? `E${row.display_id}` : row.id);
  const days = daysSince(row.updated_at, now);
  return {
    kind: "estimate_stale" as const,
    severity: "info" as const,
    title: `Estimate ${doc} — no activity for ${days} days`,
    body: `${customerLabel(row)}${row.order_status ? ` · ${row.order_status}` : ""} · follow up or void it`,
    action_url: `/estimates/${row.id}`,
    entity_type: "order",
    entity_id: row.id,
    payload: { order_id: row.id, days, order_status: row.order_status },
    dedupe_key: estimateDedupeKey(row.id, weekBucket(now)),
    occurred_at: now,
    expires_at: new Date(now.getTime() + ESTIMATE_STALE_DAYS * 86_400_000),
    audiences: [{ kind: "rep" as const, initials: row.rep_initials }],
  };
}

export async function produceStaleEstimates(
  db: Db,
  opts: { now?: Date } = {}
): Promise<{ scanned: number; created: number; results: PublishResult[] }> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query<EstimateRow>(STALE_SQL, [ESTIMATE_STALE_DAYS, ESTIMATE_MAX_AGE_DAYS, AWAITING_STATUSES]);
  const results: PublishResult[] = [];
  for (const row of rows) results.push(await publishNotification(db, buildEstimateNotification(row, now)));
  return { scanned: rows.length, created: results.filter((r) => r.created).length, results };
}
