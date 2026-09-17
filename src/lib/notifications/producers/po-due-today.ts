/**
 * Purchase orders que deben llegar HOY → admins, a las 7 am hora del negocio.
 *
 * "Hoy" = fecha en `America/New_York` (BUSINESS_TIMEZONE), nunca UTC: un cron
 * a hora fija en UTC se corre una hora con el DST. Por eso el job corre cada
 * hora y ESTE módulo decide si es la hora (`isSevenAm`).
 *
 * Cuenta como "llega hoy" un PO abierto (submitted / partially_received) cuya
 * `expected_at` cae hoy, o que tenga una guía sin entregar con ETA hoy
 * (`carrier_eta` gana sobre `manual_eta`, como en el tracking del PO).
 *
 * UNA notificación agrupada por día (dedupe `po_due_today:YYYY-MM-DD`): ocho
 * POs no son ocho campanazos. El detalle va en `payload.purchase_orders`.
 */

import { BUSINESS_TIMEZONE, getBusinessDateString } from "../../date/et";
import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

export const PO_DUE_HOUR = 7;

export function businessHour(now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  // "24" aparece en algunos runtimes para medianoche con hour12:false.
  return Number.parseInt(hour, 10) % 24;
}

export function isPoDueHour(now: Date = new Date()): boolean {
  return businessHour(now) === PO_DUE_HOUR;
}

export interface PoDueRow {
  id: string;
  number: string | null;
  vendor_name_snapshot: string | null;
  status: string;
  expected_today: boolean;
  eta_sources: string | null; // "ups,fedex" — proveedores con ETA hoy
}

export const PO_DUE_SQL = `
  SELECT po.id, po.number, po.vendor_name_snapshot, po.status,
         (po.expected_at IS NOT NULL
           AND (po.expected_at AT TIME ZONE $2)::date = $1::date) AS expected_today,
         (SELECT string_agg(DISTINCT n.provider, ',' ORDER BY n.provider)
            FROM purchase_order_tracking_number n
           WHERE n.purchase_order_id = po.id
             AND n.deleted_at IS NULL
             AND COALESCE(n.carrier_status, '') <> 'delivered'
             AND COALESCE(n.carrier_eta, n.manual_eta) = $1::text) AS eta_sources
    FROM purchase_order po
   WHERE po.deleted_at IS NULL
     AND po.status IN ('submitted', 'partially_received')
     AND (
       (po.expected_at IS NOT NULL AND (po.expected_at AT TIME ZONE $2)::date = $1::date)
       OR EXISTS (
         SELECT 1 FROM purchase_order_tracking_number n
          WHERE n.purchase_order_id = po.id
            AND n.deleted_at IS NULL
            AND COALESCE(n.carrier_status, '') <> 'delivered'
            AND COALESCE(n.carrier_eta, n.manual_eta) = $1::text
       )
     )
   ORDER BY po.number ASC NULLS LAST, po.id ASC
   LIMIT 100`;

export function poDueDedupeKey(ymd: string): string {
  return `po_due_today:${ymd}`;
}

function describe(row: PoDueRow): string {
  const label = row.number ?? row.id;
  const vendor = row.vendor_name_snapshot ? ` · ${row.vendor_name_snapshot}` : "";
  const carriers = (row.eta_sources ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => (p === "auto" ? "carrier" : p.toUpperCase()))
    .join("/");
  const via = carriers
    ? ` (${carriers} ETA)`
    : row.expected_today
      ? " (expected date)"
      : "";
  return `${label}${vendor}${via}`;
}

export function buildPoDueNotification(ymd: string, rows: PoDueRow[]) {
  const n = rows.length;
  return {
    kind: "po_due_today" as const,
    severity: "info" as const,
    title: n === 1 ? "1 purchase order expected today" : `${n} purchase orders expected today`,
    body: rows.map(describe).join("\n"),
    action_url: "/purchase-orders",
    entity_type: "po_due_day",
    entity_id: ymd,
    payload: {
      date: ymd,
      purchase_orders: rows.map((r) => ({
        id: r.id,
        number: r.number,
        vendor: r.vendor_name_snapshot,
        expected_today: r.expected_today,
        eta_sources: r.eta_sources,
      })),
    },
    dedupe_key: poDueDedupeKey(ymd),
    audiences: [{ kind: "admins" as const }],
  };
}

/**
 * `force` saltea el guard de hora (runner de debug / E2E). En producción el
 * job lo llama cada hora y sólo produce a las 7; el dedupe diario hace que
 * las otras 23 corridas —y un segundo nodo— no dupliquen.
 */
export async function producePoDueToday(
  db: Db,
  opts: { now?: Date; force?: boolean } = {}
): Promise<{ skipped: boolean; ymd: string; matched: number; result: PublishResult | null }> {
  const now = opts.now ?? new Date();
  const ymd = getBusinessDateString(now);
  if (!opts.force && !isPoDueHour(now)) {
    return { skipped: true, ymd, matched: 0, result: null };
  }
  const { rows } = await db.query<PoDueRow>(PO_DUE_SQL, [ymd, BUSINESS_TIMEZONE]);
  if (rows.length === 0) return { skipped: false, ymd, matched: 0, result: null };
  const result = await publishNotification(db, buildPoDueNotification(ymd, rows));
  return { skipped: false, ymd, matched: rows.length, result };
}
