/**
 * src/lib/qb-backfill/create-po.ts
 *
 * Fase 2 del plan `qb-docs-backfill-compras-20260911`: crea un
 * `purchase_order` + sus líneas para un `QbPurchaseOrder` que el POS no
 * conoce. UNA transacción por documento — el caller (el script) abre
 * BEGIN/COMMIT/ROLLBACK alrededor de `createPurchaseOrderFromQb`.
 *
 * NO toca `inventory_level`/`reservation_item`/`stocked_quantity` — un PO no
 * mueve stock en este POS (sólo el receipt lo hace), así que fase 2 no lo
 * necesita.
 *
 * NO inserta en `qb_purchase_order_pipeline` — el documento nace con su
 * TxnID ya resuelto (`qb_purchase_order_list_id`), no hay nada que
 * despachar.
 */
import { ulid } from "ulid";
import { ensureVendor, ensureItem, type EnsureLog, type QbItemLookup } from "./ensure";
import { resolveItemRef, type ItemIndex, type QueryableDb, type VendorIndexEntry } from "./resolve";
import type { QbPurchaseOrder, QbPurchaseOrderLine } from "./types";

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

/** Mediodía ET (16:00 UTC) del día del documento — misma convención que backfill-qb-only-docs. */
export function businessInstant(txnDate: string): string {
  return `${txnDate}T16:00:00.000Z`;
}

export type PoDecisionReason = "already" | "closed_2025" | "create";

export interface PoDecision {
  create: boolean;
  reason: PoDecisionReason;
}

/**
 * Política de alcance (aprobada en el plan): un PO ya enlazado se saltea
 * (`already`). Un PO de 2025 que YA está fully-received o manually-closed
 * en QB se saltea (`closed_2025`) — no puede afectar los libros del período
 * abierto. Cualquier otro PO desconocido se crea, sin importar su año o
 * estado actual.
 */
/**
 * QB admite líneas de PO sin ítem: separadores o texto ("Order # 111-…") con
 * cantidad e importe vacíos (medido 2026-09-11: 10 POs bloqueados por eso).
 * No representan nada en el POS y se saltan; una línea SIN ítem pero CON
 * importe sí bloquea, porque sería plata sin dónde asentarla.
 */
export function isEmptyPoLine(line: QbPurchaseOrderLine): boolean {
  return !line.item_ref && !(line.quantity > 0) && !(line.amount_cents > 0) && !(line.rate_cents > 0);
}

export function decidePoCreation(po: QbPurchaseOrder, knownTxnIds: ReadonlySet<string>): PoDecision {
  if (knownTxnIds.has(po.txn_id)) return { create: false, reason: "already" };
  const year = po.txn_date.slice(0, 4);
  // Un PO de 2025 que llegó por ENLACE desde un recibo/bill de 2026 seguía vivo al
  // 31/12 por definición (lo recibieron o facturaron en 2026): se crea aunque HOY
  // figure totalmente recibido. Medido 2026-09-11: los 34 POs enlazados se saltaban
  // como "cerrados" y dejaban 22 recibos de 2026 sin PO local.
  if (year === "2025" && !po.via_link && (po.is_fully_received || po.is_manually_closed)) {
    return { create: false, reason: "closed_2025" };
  }
  return { create: true, reason: "create" };
}

/** Status del header derivado de las banderas/cantidades que trae QB. */
export function derivePoStatus(po: QbPurchaseOrder): string {
  if (po.is_fully_received) return "received";
  if (po.lines.some((l) => l.received_quantity > 0)) return "partially_received";
  if (po.is_manually_closed) return "closed";
  return "submitted";
}

/** Status de línea, misma convención que `purchase_order_line.status`. */
function deriveLineStatus(qtyOrdered: number, qtyReceived: number): string {
  if (qtyReceived <= 0) return "open";
  if (qtyReceived >= qtyOrdered) return "complete";
  return "partial";
}

export interface CreatePoOptions {
  runId: string;
  vendorIndex: Map<string, VendorIndexEntry>;
  itemIndex: ItemIndex;
  ensureLog: EnsureLog;
  stockLocationId: string;
  createdByUserId: string;
  itemLookupFn?: (listId: string) => Promise<QbItemLookup | null>;
}

export interface CreatePoResult {
  purchase_order_id: string;
  number: string;
  status: string;
  total_lines: number;
}

/**
 * Crea el `purchase_order` + líneas para `po` dentro de la transacción que
 * representa `client` (BEGIN ya abierto por el caller). No hace commit.
 */
export async function createPurchaseOrderFromQb(
  client: QueryableDb,
  po: QbPurchaseOrder,
  opts: CreatePoOptions
): Promise<CreatePoResult> {
  if (!po.vendor_ref) {
    throw new Error(`PO ${po.txn_id}: sin VendorRef — no se puede crear sin vendor`);
  }

  const knownVendor = opts.vendorIndex.get(po.vendor_ref.list_id);
  const vendorId = knownVendor
    ? knownVendor.id
    : await ensureVendor(client, po.vendor_ref, opts.runId, opts.ensureLog);
  const vendorNameSnapshot = knownVendor?.full_name ?? po.vendor_ref.full_name;

  // Numeración HISTÓRICA (decisión del operador 2026-09-11): los POs traídos de QB van en el
  // rango 1..999 como `PO-0001`… en orden de creación (el script recorre ventanas cronológicas),
  // así quedan ANTES de los del POS (seq ≥ 1000) en el orden "By PO #" y no consumen la
  // secuencia `custom_purchase_order_seq` de los POs reales.
  const seqRes = await client.query(
    `SELECT coalesce(max(seq), 0) + 1 AS seq FROM purchase_order WHERE deleted_at IS NULL AND seq BETWEEN 1 AND 999`
  );
  const seq = Number((seqRes.rows[0] as { seq: string | number }).seq);
  if (seq > 999) throw new Error(`PO ${po.txn_id}: se agotó el rango histórico PO-0001..PO-0999`);
  const number = `PO-${String(seq).padStart(4, "0")}`;

  const status = derivePoStatus(po);
  const businessAt = businessInstant(po.txn_date);
  const dueAt = po.due_date ? businessInstant(po.due_date) : null;
  const expectedAt = po.expected_date ? businessInstant(po.expected_date) : null;

  const subtotalCents = po.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  const otherFeesCents = po.total_amount_cents - subtotalCents;
  const totalUnitsOrdered = po.lines.reduce((sum, l) => sum + l.quantity, 0);
  const totalUnitsReceived = po.lines.reduce((sum, l) => sum + l.received_quantity, 0);

  const poId = makeId("po");
  const metadata = JSON.stringify({
    qb_backfill: {
      run_id: opts.runId,
      txn_id: po.txn_id,
      txn_type: "PurchaseOrder",
      imported_at: new Date().toISOString(),
      // `true` cuando este PO entró por `follow-links.ts` (2025 fuera del rango
      // descargado, resuelto por LinkedTxn de un documento de 2026).
      via_link: po.via_link === true,
    },
  });

  await client.query(
    `INSERT INTO purchase_order (
       id, number, seq, status, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
       stock_location_id, ordered_at, expected_at, subtotal_cents, tax_cents, shipping_cents,
       other_fees_cents, total_cents, currency_code, reference_number, created_by_user_id,
       submitted_at, submitted_by_user_id, total_lines, total_units_ordered, total_units_received,
       qb_purchase_order_list_id, qb_purchase_order_txn_number, qb_synced_at, qb_edit_sequence,
       metadata, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, $11, 0, 0,
       $12, $13, 'usd', $14, $15,
       $9, $15, $16, $17, $18,
       $19, $20, $9, $21,
       $22::jsonb, $9, $9
     )`,
    [
      poId, // 1
      number, // 2
      seq, // 3
      status, // 4
      vendorId, // 5
      vendorNameSnapshot, // 6
      po.vendor_ref.list_id, // 7
      opts.stockLocationId, // 8
      businessAt, // 9
      expectedAt, // 10
      subtotalCents, // 11
      otherFeesCents, // 12
      po.total_amount_cents, // 13
      po.ref_number, // 14
      opts.createdByUserId, // 15
      po.lines.filter((l) => !isEmptyPoLine(l)).length, // 16 — sin las líneas de texto
      totalUnitsOrdered, // 17
      totalUnitsReceived, // 18
      po.txn_id, // 19
      po.txn_number, // 20
      po.edit_sequence, // 21
      metadata, // 22
    ]
  );
  void dueAt; // DueDate de QB no tiene columna propia en purchase_order; queda documentado, no se pierde (memo/metadata podría sumarse si un caller lo pide).

  for (let i = 0; i < po.lines.length; i++) {
    const line = po.lines[i];
    if (!line || isEmptyPoLine(line)) continue; // línea de texto/vacía de QB (sin ítem, sin cantidad, sin importe)
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
      throw new Error(`PO ${po.txn_id} línea ${line.txn_line_id}: sin ItemRef, no se puede crear la línea`);
    }
    const lineId = makeId("pol");
    const lineStatus = deriveLineStatus(line.quantity, line.received_quantity);
    await client.query(
      `INSERT INTO purchase_order_line (
         id, purchase_order_id, product_variant_id, inventory_item_id, sku_snapshot,
         description_snapshot, qb_item_list_id_snapshot, qty_ordered, qty_received,
         unit_cost_cents, total_cents, status, line_order, qb_txn_line_id,
         created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [
        lineId,
        poId,
        item.variant_id,
        item.inventory_item_id,
        item.sku || line.item_ref?.full_name || "",
        line.description ?? line.manufacturer_part_number ?? "",
        line.item_ref?.list_id ?? null,
        line.quantity,
        line.received_quantity,
        line.rate_cents,
        line.amount_cents,
        lineStatus,
        i,
        line.txn_line_id,
        businessAt,
      ]
    );
  }

  return { purchase_order_id: poId, number, status, total_lines: po.lines.length };
}
