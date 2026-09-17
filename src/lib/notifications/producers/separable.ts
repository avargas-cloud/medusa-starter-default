/**
 * Recibo de PO → órdenes que AHORA se pueden separar (llamar al cliente).
 *
 * No re-implementa la aritmética de separación: `loadSeparationPending` es la
 * MISMA función que pinta `To Separate` en la lista de órdenes y la que usa el
 * modal. Este módulo sólo la corre DOS veces —antes y después del recibo— y
 * avisa las órdenes que cruzaron de "sin stock" a "hay stock" (available 0 → >0).
 * Sin el antes/después avisaría de órdenes separables desde hace semanas.
 *
 * Candidatas = órdenes abiertas con reserva sobre los ítems recibidos, más las
 * `linked_order_ids` del PO. Acotado a ellas: la función de disponibilidad es
 * cara y el recibo es un request del operador.
 */

import {
  loadSeparationPending,
  type SeparationPending,
} from "../../../api/admin/orders/_lib/separation-availability";
import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { customerLabel } from "./format";

/** knex (`__pg_connection__`): placeholders `?`. */
export interface RawSql {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const OPEN_ORDER_STATUSES = ["pending"];

export function parseLinkedOrderIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Órdenes abiertas que reservan alguno de los ítems (versión vigente). */
export async function candidateOrdersForItems(
  pg: RawSql,
  inventoryItemIds: string[],
  linkedOrderIds: string[] = []
): Promise<string[]> {
  const ids = new Set<string>(linkedOrderIds);
  if (inventoryItemIds.length > 0) {
    const { rows } = await pg.raw(
      `SELECT DISTINCT o.id
         FROM reservation_item ri
         JOIN order_item oi ON oi.item_id = ri.line_item_id AND oi.deleted_at IS NULL
         JOIN "order" o ON o.id = oi.order_id AND o.version = oi.version AND o.deleted_at IS NULL
        WHERE ri.deleted_at IS NULL
          AND ri.inventory_item_id = ANY(?::text[])
          AND o.status::text = ANY(?::text[])
          AND o.is_draft_order = false`,
      [inventoryItemIds, OPEN_ORDER_STATUSES]
    );
    for (const r of rows as { id: string }[]) ids.add(r.id);
  }
  return [...ids];
}

export async function snapshotSeparation(pg: RawSql, orderIds: string[]): Promise<Map<string, SeparationPending>> {
  return loadSeparationPending(pg, orderIds);
}

/** Las que pasaron de "nada disponible" a "algo disponible" — y siguen con pendiente. */
export function newlySeparable(
  before: Map<string, SeparationPending>,
  after: Map<string, SeparationPending>
): string[] {
  const out: string[] = [];
  for (const [orderId, now] of after) {
    if (now.pending <= 0 || now.available <= 0) continue;
    const prev = before.get(orderId);
    if (prev && prev.available > 0) continue;
    out.push(orderId);
  }
  return out;
}

interface OrderRow {
  id: string;
  display_id: number | null;
  document_number: string | null;
  rep_initials: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export function separableDedupeKey(receiptId: string, orderId: string): string {
  return `separable:${receiptId}:${orderId}`;
}

export function buildSeparableNotification(
  row: OrderRow,
  pending: SeparationPending,
  receipt: { id: string; number: string | null; po_number: string | null }
) {
  const doc = row.document_number ?? (row.display_id ? `#${row.display_id}` : row.id);
  const units = pending.available === 1 ? "1 unit" : `${pending.available} units`;
  const source = receipt.po_number ? ` — ${receipt.po_number} received` : "";
  return {
    kind: "order_separable" as const,
    severity: "info" as const,
    title: `Order ${doc} can be separated${source}`,
    body: `${customerLabel(row)} · ${units} now available of ${pending.pending} pending · call the customer for pickup`,
    action_url: `/orders/${row.id}`,
    entity_type: "order",
    entity_id: row.id,
    payload: { order_id: row.id, receipt_id: receipt.id, receipt_number: receipt.number, available: pending.available, pending: pending.pending },
    dedupe_key: separableDedupeKey(receipt.id, row.id),
    audiences: [{ kind: "admins" as const }, { kind: "rep" as const, initials: row.rep_initials }],
  };
}

export async function produceSeparableAfterReceipt(
  db: Db,
  pg: RawSql,
  input: {
    receipt: { id: string; number: string | null; po_number: string | null };
    before: Map<string, SeparationPending>;
    orderIds: string[];
  }
): Promise<{ crossed: string[]; results: PublishResult[] }> {
  if (input.orderIds.length === 0) return { crossed: [], results: [] };
  const after = await snapshotSeparation(pg, input.orderIds);
  const crossed = newlySeparable(input.before, after);
  if (crossed.length === 0) return { crossed, results: [] };
  const { rows } = await db.query<OrderRow>(
    `SELECT o.id, o.display_id, o.metadata->>'document_number' AS document_number,
            o.metadata->'sales_rep'->>'initials' AS rep_initials,
            c.company_name, c.first_name, c.last_name, COALESCE(c.email, o.email) AS email
       FROM "order" o
       LEFT JOIN customer c ON c.id = o.customer_id
      WHERE o.id = ANY($1::text[])`,
    [crossed]
  );
  const results: PublishResult[] = [];
  for (const row of rows) {
    const pending = after.get(row.id);
    if (!pending) continue;
    results.push(await publishNotification(db, buildSeparableNotification(row, pending, input.receipt)));
  }
  return { crossed, results };
}
