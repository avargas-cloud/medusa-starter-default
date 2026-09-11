import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadPurchaseAccountMap } from "../accounts";
import { buildReceiptLines, ReceiptSnapshot } from "../lines/receipt";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { LedgerError, PostResult, ReverseResult } from "../types";

/** §6: `applied` es el único estado postable — `pending`/`error` no movieron stock aún. */
const POSTABLE_STATUSES = new Set(["applied", "synced"]);

type ReceiptHeader = {
  id: string;
  status: string;
  received_at: string;
  voided_at: string | null;
};

type ReceiptLineRow = {
  qty_received_now: number;
  unit_cost_cents_override: string | null;
  po_line_unit_cost_cents: string;
};

async function loadHeader(
  client: PoolClient,
  receiptId: string
): Promise<ReceiptHeader | null> {
  const { rows } = await client.query<ReceiptHeader>(
    `SELECT id, status, received_at::text, voided_at::text
     FROM purchase_order_receipt WHERE id = $1 AND deleted_at IS NULL`,
    [receiptId]
  );
  return rows[0] ?? null;
}

/**
 * §1: el costo efectivo es `unit_cost_cents_override ?? po_line.unit_cost_cents`
 * — se resuelve acá contra `purchase_order_line`, nunca se asume que la
 * columna de la línea de recepción ya lo trae resuelto.
 */
async function loadLines(
  client: PoolClient,
  receiptId: string
): Promise<ReceiptLineRow[]> {
  // `unit_cost_cents`/`unit_cost_cents_override` viven en columnas `float`
  // (Medusa `model.number()` no tiene un tipo entero estricto) — medido
  // contra `medusa_gl`: filas reales con `69.8`. `BigInt(69.8)` explota
  // (`RangeError`), así que el ROUND corre en SQL, nunca en JS.
  const { rows } = await client.query<ReceiptLineRow>(
    `SELECT rl.qty_received_now,
            ROUND(rl.unit_cost_cents_override::numeric)::bigint::text AS unit_cost_cents_override,
            ROUND(pol.unit_cost_cents::numeric)::bigint::text AS po_line_unit_cost_cents
     FROM purchase_order_receipt_line rl
     JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
     WHERE rl.purchase_order_receipt_id = $1
     ORDER BY rl.id`,
    [receiptId]
  );
  return rows;
}

export async function postReceipt(
  client: PoolClient,
  receiptId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, receiptId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { receiptId });
  if (header.voided_at) throw new LedgerError("GL_SOURCE_INVALID", { voided: true });
  if (!POSTABLE_STATUSES.has(header.status))
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });

  const lineRows = await loadLines(client, receiptId);
  const map = await loadPurchaseAccountMap(client);
  const snapshot: ReceiptSnapshot = {
    lines: lineRows.map((r) => ({
      qtyReceivedNow: r.qty_received_now,
      unitCostCents: BigInt(
        r.unit_cost_cents_override ?? r.po_line_unit_cost_cents
      ),
    })),
  };
  const lines = buildReceiptLines(snapshot, map);
  if (lines.length === 0) return { status: "skipped", reason: "zero_amount" };

  const day = getBusinessDateString(header.received_at);
  const sourceSnapshot = { header, lines: lineRows };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "po_receipt",
    source_id: receiptId,
    document_number: receiptId,
    day,
    reference: receiptId,
    description: `PO Receipt ${receiptId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

/**
 * §2/§5: reversa por void (`voided_at`) O por tombstone (`deletePurchaseOrderReceiptWorkflow`
 * hace SOFT delete — `deleted_at`, no un `status` propio). `loadHeader` filtra
 * `deleted_at IS NULL` a propósito (sólo sirve para postear); esta query NO
 * filtra por `deleted_at`, porque necesita seguir viendo la fila para
 * reversarla después de que el DELETE ya corrió.
 */
export async function reverseReceipt(
  client: PoolClient,
  receiptId: string,
  actorId: string,
  reason = "receipt voided or deleted"
): Promise<ReverseResult> {
  const { rows } = await client.query<{
    id: string;
    received_at: string;
    voided_at: string | null;
    updated_at: string;
  }>(
    `SELECT id, received_at::text, voided_at::text, updated_at::text
     FROM purchase_order_receipt WHERE id = $1`,
    [receiptId]
  );
  const header = rows[0];
  if (!header) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(header.voided_at ?? header.updated_at ?? header.received_at);
  return reverseDocumentJournal(client, {
    source_kind: "po_receipt",
    source_id: receiptId,
    day,
    reason,
    actor_id: actorId,
  });
}
