/**
 * Orden web nueva → rep `WEB` + aviso a TODO el staff ("que estemos pendientes
 * y la preparemos", user 09/17).
 *
 * La única escritura fuera de las tablas de notificaciones: si la orden web
 * no trae rep, se le pone `metadata.sales_rep = {WEB, Web}` con el MISMO merge
 * atómico de JSONB que usa `document-number-subscriber` (`||`), y sólo si no
 * tenía (`WHERE` con guard): nunca pisa un rep real ni toca órdenes POS.
 */

import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { customerLabel } from "./format";

export const WEB_SALES_REP = { initials: "WEB", name: "Web" } as const;

export interface WebOrderRow {
  id: string;
  display_id: number | null;
  email: string | null;
  metadata: Record<string, unknown> | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  item_count: string | number | null;
}

export const WEB_ORDER_SQL = `
  SELECT o.id, o.display_id, o.email, o.metadata,
         c.company_name, c.first_name, c.last_name,
         (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_item oi
           WHERE oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL) AS item_count
    FROM "order" o
    LEFT JOIN customer c ON c.id = o.customer_id
   WHERE o.id = $1 AND o.deleted_at IS NULL`;

export function isPosCreated(metadata: Record<string, unknown> | null): boolean {
  return metadata?.pos_created === true;
}

export function hasSalesRep(metadata: Record<string, unknown> | null): boolean {
  const rep = metadata?.sales_rep as { initials?: unknown } | null | undefined;
  return typeof rep?.initials === "string" && rep.initials.trim().length > 0;
}

/** true ⇒ escribió el rep WEB; false ⇒ ya tenía uno (o la orden no existe). */
export async function assignWebRep(db: Db, orderId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE "order"
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE id = $1
        AND deleted_at IS NULL
        AND COALESCE(metadata->>'pos_created', 'false') <> 'true'
        AND COALESCE(btrim(metadata->'sales_rep'->>'initials'), '') = ''`,
    [orderId, JSON.stringify({ sales_rep: WEB_SALES_REP })]
  );
  return (rowCount ?? 0) > 0;
}

export function webOrderDedupeKey(orderId: string): string {
  return `web_order:${orderId}`;
}

export function buildWebOrderNotification(row: WebOrderRow) {
  const doc = (row.metadata?.document_number as string | undefined) ?? (row.display_id ? `#${row.display_id}` : row.id);
  const items = Number.parseInt(String(row.item_count ?? "0"), 10);
  const itemsLabel = items === 1 ? "1 item" : `${items} items`;
  return {
    kind: "web_order_placed" as const,
    severity: "info" as const,
    title: `New web order ${doc}`,
    body: `${customerLabel(row)} · ${itemsLabel} · rep WEB`,
    action_url: `/orders/${row.id}`,
    entity_type: "order",
    entity_id: row.id,
    payload: { order_id: row.id, display_id: row.display_id, item_count: items },
    dedupe_key: webOrderDedupeKey(row.id),
    audiences: [{ kind: "all" as const }],
  };
}

export async function produceWebOrderPlaced(
  db: Db,
  orderId: string
): Promise<{ skipped: "not_found" | "pos_order" | null; rep_assigned: boolean; result: PublishResult | null }> {
  const { rows } = await db.query<WebOrderRow>(WEB_ORDER_SQL, [orderId]);
  const row = rows[0];
  if (!row) return { skipped: "not_found", rep_assigned: false, result: null };
  if (isPosCreated(row.metadata)) return { skipped: "pos_order", rep_assigned: false, result: null };
  const repAssigned = hasSalesRep(row.metadata) ? false : await assignWebRep(db, orderId);
  const result = await publishNotification(db, buildWebOrderNotification(row));
  return { skipped: null, rep_assigned: repAssigned, result };
}
