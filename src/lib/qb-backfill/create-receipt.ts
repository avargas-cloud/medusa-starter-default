/**
 * src/lib/qb-backfill/create-receipt.ts
 *
 * Fase 3 del plan `qb-docs-backfill-compras-20260911`: crea un
 * `purchase_order_receipt` + sus líneas para un `QbItemReceipt` que el POS
 * no conoce. UNA transacción por documento — el caller abre BEGIN/COMMIT/
 * ROLLBACK alrededor de `createReceiptFromQb`.
 *
 * `purchase_order_receipt` NO TIENE columna `metadata` (a diferencia de
 * `purchase_order`) — el marcador del run va en `notes`.
 *
 * NUNCA toca `inventory_level`/`stocked_quantity`: la recepción histórica es
 * SOLO documento. `stock_applied` queda `false` a propósito — Medusa nunca
 * aplicó el delta de esta recepción, y decir lo contrario (`true` sin el
 * movimiento real) sería falsificar el campo que otros lectores usan para
 * saber si el stock refleja este evento.
 */
import { ulid } from "ulid";
import { ensureItem, type EnsureLog, type QbItemLookup } from "./ensure";
import { resolveItemRef, type ItemIndex, type QueryableDb } from "./resolve";
import { matchPoLineForVariant, type OpenPoLine } from "./links";
import { businessInstant } from "./create-po";
import type { QbItemReceipt } from "./types";

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export type ReceiptDecisionReason = "already" | "create";

export interface ReceiptDecision {
  create: boolean;
  reason: ReceiptDecisionReason;
}

/** Política de alcance: un recibo ya enlazado se saltea; cualquier otro se crea. */
export function decideReceiptCreation(
  receipt: QbItemReceipt,
  knownTxnIds: ReadonlySet<string>
): ReceiptDecision {
  if (knownTxnIds.has(receipt.txn_id)) return { create: false, reason: "already" };
  return { create: true, reason: "create" };
}

export interface LocalPurchaseOrder {
  id: string;
  lines: OpenPoLine[];
}

export interface CreateReceiptOptions {
  runId: string;
  itemIndex: ItemIndex;
  ensureLog: EnsureLog;
  createdByUserId: string;
  stockLocationId: string;
  itemLookupFn?: (listId: string) => Promise<QbItemLookup | null>;
  /**
   * PO local al que este recibo enlaza (resuelto por el caller vía
   * `linkedTxnIdsOfType(receipt.linked_txns, "PurchaseOrder")` contra
   * `purchase_order.qb_purchase_order_list_id`). `purchase_order_id` es
   * NOT NULL en el modelo — sin PO resuelto, `createReceiptFromQb` tira y el
   * caller cuenta el documento como bloqueado.
   */
  localPo: LocalPurchaseOrder | null;
}

export interface CreateReceiptResult {
  purchase_order_receipt_id: string;
  number: string;
  total_lines: number;
}

/**
 * Crea el `purchase_order_receipt` + líneas para `receipt` dentro de la
 * transacción abierta por el caller. Cada línea se matchea GREEDY contra las
 * líneas abiertas del PO por variante — si una línea no matchea (ítem no
 * pedido en ese PO, o capacidad agotada), el documento entero se bloquea (no
 * hay `purchase_order_line_id` válido con el que insertar una fila parcial).
 */
export async function createReceiptFromQb(
  client: QueryableDb,
  receipt: QbItemReceipt,
  opts: CreateReceiptOptions
): Promise<CreateReceiptResult> {
  if (!opts.localPo) {
    throw new Error(
      `Receipt ${receipt.txn_id}: no resuelve a ningún purchase_order local (LinkedTxn PurchaseOrder ausente o PO desconocido) — purchase_order_id es obligatorio`
    );
  }

  const seqRes = await client.query(`SELECT nextval('custom_po_receipt_seq') AS seq`);
  const seq = Number((seqRes.rows[0] as { seq: string | number }).seq);
  const number = `RCP-${seq}`;
  const businessAt = businessInstant(receipt.txn_date);
  const id = makeId("por");
  const notes =
    `[qb_backfill run=${opts.runId} txn=${receipt.txn_id}${receipt.via_link ? " via_link" : ""}]` +
    (receipt.memo ? ` ${receipt.memo}` : "");

  // Resuelve cada línea contra ítem + línea de PO abierta ANTES de escribir
  // nada — si alguna no matchea, el documento entero se bloquea limpio.
  const assignedQtyByPoLine = new Map<string, number>();
  const resolvedLines: {
    poLineId: string;
    variantId: string;
    inventoryItemId: string;
    sku: string;
    description: string;
    qbItemListId: string | null;
    qty: number;
  }[] = [];

  for (const line of receipt.lines) {
    // QB admite líneas de recibo con cantidad 0 (medido: 1BDD82, LUX-LR23756 qty 0):
    // no reciben nada, así que no exigen línea de PO ni se escriben.
    if (!(line.quantity > 0)) continue;
    let item = resolveItemRef(opts.itemIndex, line.item_ref);
    if (!item && line.item_ref) {
      const created = await ensureItem(client, line.item_ref, opts.runId, opts.ensureLog, opts.itemLookupFn);
      item = {
        variant_id: created.variantId,
        inventory_item_id: created.inventoryItemId,
        sku: line.item_ref.full_name,
        quickbooks_id: line.item_ref.list_id,
      };
    }
    if (!item) {
      throw new Error(`Receipt ${receipt.txn_id} línea ${line.txn_line_id}: sin ItemRef resoluble`);
    }
    if (!item.inventory_item_id) {
      throw new Error(`Receipt ${receipt.txn_id} línea ${line.txn_line_id}: variante ${item.variant_id} sin inventory_item_id`);
    }
    const openLines: OpenPoLine[] = opts.localPo.lines.map((l) => ({
      ...l,
      already_matched: assignedQtyByPoLine.get(l.id) ?? 0,
    }));
    const matched = matchPoLineForVariant(openLines, item.variant_id, line.quantity);
    if (!matched) {
      throw new Error(
        `Receipt ${receipt.txn_id} línea ${line.txn_line_id}: ninguna línea abierta del PO ${opts.localPo.id} matchea la variante ${item.variant_id} (ítem no pedido en este PO o capacidad agotada)`
      );
    }
    assignedQtyByPoLine.set(matched.id, (assignedQtyByPoLine.get(matched.id) ?? 0) + line.quantity);
    resolvedLines.push({
      poLineId: matched.id,
      variantId: item.variant_id,
      inventoryItemId: item.inventory_item_id,
      sku: item.sku || line.item_ref?.full_name || "",
      description: line.description ?? "",
      qbItemListId: line.item_ref?.list_id ?? null,
      qty: line.quantity,
    });
  }

  await client.query(
    `INSERT INTO purchase_order_receipt (
       id, purchase_order_id, number, seq, status, received_at, received_by_user_id,
       stock_location_id, notes, qb_item_receipt_list_id, qb_item_receipt_txn_number,
       qb_edit_sequence, qb_synced_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,'synced',$5,$6,$7,$8,$9,NULL,$10,$5,$5,$5)`,
    [
      id,
      opts.localPo.id,
      number,
      seq,
      businessAt,
      opts.createdByUserId,
      opts.stockLocationId,
      notes,
      receipt.txn_id,
      receipt.edit_sequence,
    ]
  );

  for (const l of resolvedLines) {
    await client.query(
      `INSERT INTO purchase_order_receipt_line (
         id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
         product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
         qb_item_list_id_snapshot, qty_received_now, stock_applied, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$11)`,
      [
        makeId("porl"),
        id,
        l.poLineId,
        opts.localPo.id,
        l.variantId,
        l.inventoryItemId,
        l.sku,
        l.description,
        l.qbItemListId,
        Math.round(l.qty),
        businessAt,
      ]
    );
  }

  return { purchase_order_receipt_id: id, number, total_lines: receipt.lines.length };
}
