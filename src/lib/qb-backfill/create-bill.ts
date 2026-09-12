/**
 * src/lib/qb-backfill/create-bill.ts
 *
 * Fase 3/4 del plan `qb-docs-backfill-compras-20260911`:
 *   - `createBillFromQb` crea un `vendor_bill` nativo (qb_source=NULL) +
 *     líneas para un `QbBill` que el POS no conoce.
 *   - `deAdoptBill` — fase 3 — convierte un `vendor_bill` con
 *     `qb_source='adopted'` en nativo: agrega sus líneas (si no las tiene) y
 *     limpia `qb_source`, preservando `qb_txn_id`/`qb_edit_sequence`/
 *     `qb_ref_number`.
 *
 * `vendor_bill` NO TIENE columna `metadata` — el marcador del run va en
 * `notes` (igual que `purchase_order_receipt`).
 *
 * Ítem lines: mismo patrón de `bill-match/adopt/route.ts` (qty/unit_cost_cents,
 * SIN tocar landed_unit_cost_cents/landed_total_cents — eso lo calcula sólo el
 * flujo `confirm`, que este backfill no corre). Expense lines: qty=1,
 * unit_cost_cents=landed_unit_cost_cents=amount_cents, mismo patrón que la
 * línea `freight_charge` del adopt route, con `line_kind='qb_account'`.
 */
import { ulid } from "ulid";
import { ensureVendor, ensureItem, type EnsureLog, type QbItemLookup } from "./ensure";
import { resolveItemRef, type ItemIndex, type QueryableDb, type VendorIndexEntry } from "./resolve";
import { matchPoLineForVariant, type OpenPoLine } from "./links";
import { businessInstant, POS_GO_LIVE_DATE } from "./create-po";
import type { QbBill } from "./types";

/**
 * Numeración de un bill del backfill (misma regla que `create-po.ts`, pedido
 * del operador 2026-09-11): antes del go-live del POS (`POS_GO_LIVE_DATE`)
 * va en el rango histórico `VB-0001..VB-0999`, en orden de creación (que es
 * cronológico), para quedar ANTES de los `VB-1000+` del POS; desde el go-live
 * toma `custom_vendor_bill_seq` como un bill nativo. Un bill sin número se
 * listaba por su `id` interno (`vb_01k…`), que no identifica nada.
 */
export async function nextBackfillBillNumber(client: QueryableDb, txnDate: string): Promise<string> {
  if (txnDate < POS_GO_LIVE_DATE) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(substring(number FROM 4)::int), 0) + 1 AS n
         FROM vendor_bill WHERE number ~ '^VB-0[0-9]{3}$'`
    );
    const n = Number((rows[0] as { n: string | number }).n);
    if (n > 999) throw new Error("rango histórico VB-0001..VB-0999 agotado");
    return `VB-${String(n).padStart(4, "0")}`;
  }
  const { rows } = await client.query(`SELECT nextval('custom_vendor_bill_seq') AS seq`);
  return `VB-${(rows[0] as { seq: string | number }).seq}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export type BillDecisionReason = "already" | "create";

export interface BillDecision {
  create: boolean;
  reason: BillDecisionReason;
}

export function decideBillCreation(bill: QbBill, knownTxnIds: ReadonlySet<string>): BillDecision {
  if (knownTxnIds.has(bill.txn_id)) return { create: false, reason: "already" };
  return { create: true, reason: "create" };
}

/** `bill_type` derivado: si el bill enlaza a un PO local, es un bill regular de compra; si no, es un gasto suelto. */
export function deriveBillType(resolvedPoId: string | null): "regular" | "expense" {
  return resolvedPoId ? "regular" : "expense";
}

export type QbAccountLookupFn = (
  listId: string
) => Promise<{ full_name: string; account_type: string } | null>;

export interface BillLineOptions {
  runId: string;
  itemIndex: ItemIndex;
  ensureLog: EnsureLog;
  itemLookupFn?: (listId: string) => Promise<QbItemLookup | null>;
  resolveQbAccount: QbAccountLookupFn;
  /** Líneas abiertas del PO local para matchear `purchase_order_line_id` de las líneas de ítem — `[]` si el bill no enlaza a ningún PO. */
  poLines: OpenPoLine[];
}

/**
 * Inserta las líneas de `bill` (item + expense) para el `vendor_bill_id` ya
 * creado. Compartida por `createBillFromQb` (bill nuevo) y `deAdoptBill`
 * (bill adoptado que aún no tiene líneas locales). Lanza — bloqueando el
 * documento entero — si una línea de gasto referencia una cuenta QB que no
 * resuelve (`resolveQbAccount` devuelve null): fail-closed, mismo criterio
 * que `resolveQbAccountsByListId` en vendor-credits.
 */
export async function insertBillLines(
  client: QueryableDb,
  billId: string,
  bill: QbBill,
  opts: BillLineOptions
): Promise<{ item_lines: number; expense_lines: number }> {
  const assignedQtyByPoLine = new Map<string, number>();

  for (const line of bill.item_lines) {
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
      throw new Error(`Bill ${bill.txn_id} línea ${line.txn_line_id}: sin ItemRef resoluble`);
    }
    const qty = line.quantity != null ? Math.round(line.quantity) : 1;
    const unitCostCents =
      line.rate_cents != null ? line.rate_cents : qty > 0 ? Math.round(line.amount_cents / qty) : line.amount_cents;

    const openLines: OpenPoLine[] = opts.poLines.map((l) => ({
      ...l,
      already_matched: assignedQtyByPoLine.get(l.id) ?? 0,
    }));
    const matched = matchPoLineForVariant(openLines, item.variant_id, qty);
    if (matched) assignedQtyByPoLine.set(matched.id, (assignedQtyByPoLine.get(matched.id) ?? 0) + qty);

    await client.query(
      `INSERT INTO vendor_bill_line (
         id, vendor_bill_id, purchase_order_line_id, product_variant_id,
         line_type, line_kind, sku, description, qty, unit_cost_cents,
         qb_txn_line_id, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'product','po_item',$5,$6,$7,$8,$9,now(),now())`,
      [
        makeId("vbl"),
        billId,
        matched?.id ?? null,
        item.variant_id,
        item.sku || line.item_ref?.full_name || "",
        line.description ?? item.sku ?? "(item)",
        qty,
        unitCostCents,
        line.txn_line_id,
      ]
    );
  }

  for (const line of bill.expense_lines) {
    if (!line.account_ref) {
      throw new Error(`Bill ${bill.txn_id} línea ${line.txn_line_id}: ExpenseLine sin AccountRef`);
    }
    const account = await opts.resolveQbAccount(line.account_ref.list_id);
    if (!account) {
      throw new Error(
        `Bill ${bill.txn_id} línea ${line.txn_line_id}: cuenta QB ${line.account_ref.list_id} (${line.account_ref.full_name}) no resuelve en qb_account`
      );
    }
    await client.query(
      // Tres placeholders SEPARADOS para el mismo valor a propósito:
      // unit_cost_cents/landed_unit_cost_cents son `double precision` y
      // amount_cents es `integer` — reusar un solo `$N` entre columnas de
      // tipo SQL distinto hace que pg falle con "inconsistent types deduced
      // for parameter $N" (sondeado corriendo el backfill real, fase 3).
      `INSERT INTO vendor_bill_line (
         id, vendor_bill_id, line_type, line_kind, sku, description, qty,
         unit_cost_cents, landed_unit_cost_cents, amount_cents,
         qb_account_list_id, qb_account_full_name, qb_account_type,
         qb_txn_line_id, created_at, updated_at
       ) VALUES ($1,$2,'qb_account','qb_account',$3,$4,1,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
      [
        makeId("vbl"),
        billId,
        (account.full_name || "EXPENSE").slice(0, 100),
        line.description || account.full_name || "Expense",
        line.amount_cents,
        line.amount_cents,
        line.amount_cents,
        line.account_ref.list_id,
        account.full_name,
        account.account_type,
        line.txn_line_id,
      ]
    );
  }

  return { item_lines: bill.item_lines.length, expense_lines: bill.expense_lines.length };
}

export interface CreateBillOptions extends BillLineOptions {
  vendorIndex: Map<string, VendorIndexEntry>;
  /** `purchase_order.id` local si `bill.linked_txns` resuelve a un PO conocido — `null` si es un gasto suelto. */
  resolvedPoId: string | null;
}

export interface CreateBillResult {
  vendor_bill_id: string;
  number: string;
  item_lines: number;
  expense_lines: number;
}

/**
 * Crea el `vendor_bill` NATIVO (qb_source=NULL) + líneas para `bill` dentro
 * de la transacción del caller. `status='synced'` — el documento ya está
 * confirmado y sincronizado en QB; este backfill no corre el flujo `confirm`
 * (no calcula landed cost) porque ya trae sus montos definitivos de QB.
 */
export async function createBillFromQb(
  client: QueryableDb,
  bill: QbBill,
  opts: CreateBillOptions
): Promise<CreateBillResult> {
  if (!bill.vendor_ref) {
    throw new Error(`Bill ${bill.txn_id}: sin VendorRef — no se puede crear sin vendor`);
  }
  const knownVendor = opts.vendorIndex.get(bill.vendor_ref.list_id);
  const vendorId = knownVendor ? knownVendor.id : await ensureVendor(client, bill.vendor_ref, opts.runId, opts.ensureLog);
  const vendorNameSnapshot = knownVendor?.full_name ?? bill.vendor_ref.full_name;

  const billId = makeId("vb");
  const businessAt = businessInstant(bill.txn_date);
  const dueAt = bill.due_date ? businessInstant(bill.due_date) : null;
  const notes =
    `[qb_backfill run=${opts.runId} txn=${bill.txn_id}${bill.via_link ? " via_link" : ""}]` +
    (bill.memo ? ` ${bill.memo}` : "");
  const billType = deriveBillType(opts.resolvedPoId);
  const number = await nextBackfillBillNumber(client, bill.txn_date);

  await client.query(
    `INSERT INTO vendor_bill (
       id, purchase_order_id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
       bill_type, status, qb_source, qb_txn_id, qb_edit_sequence, qb_ref_number, reference_id,
       document_date, due_date, qb_is_paid, qb_synced_at, number, notes, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, 'synced', NULL, $7, $8, $9, $9,
       $10, $11, $12, $10, $14, $13, $10, $10
     )`,
    [
      billId,
      opts.resolvedPoId,
      vendorId,
      vendorNameSnapshot,
      bill.vendor_ref.list_id,
      billType,
      bill.txn_id,
      bill.edit_sequence,
      bill.ref_number,
      businessAt,
      dueAt,
      bill.is_paid,
      notes,
      number,
    ]
  );

  const { item_lines, expense_lines } = await insertBillLines(client, billId, bill, opts);
  return { vendor_bill_id: billId, number, item_lines, expense_lines };
}

export interface DeAdoptOptions extends BillLineOptions {
  vendorBillId: string;
  hasExistingLines: boolean;
}

export interface DeAdoptResult {
  vendor_bill_id: string;
  lines_added: number;
}

/**
 * Fase 3: convierte un `vendor_bill` adoptado en nativo. Idempotente por
 * construcción — el caller ya filtró por `qb_source='adopted'`; si además
 * `hasExistingLines` es true no se re-insertan líneas (evita duplicar en un
 * re-run tras un fallo parcial).
 */
export async function deAdoptBill(
  client: QueryableDb,
  bill: QbBill,
  opts: DeAdoptOptions
): Promise<DeAdoptResult> {
  let linesAdded = 0;
  if (!opts.hasExistingLines) {
    const { item_lines, expense_lines } = await insertBillLines(client, opts.vendorBillId, bill, opts);
    linesAdded = item_lines + expense_lines;
  }

  await client.query(
    `UPDATE vendor_bill
        SET qb_source = NULL,
            qb_edit_sequence = $2,
            notes = COALESCE(notes, '') || $3,
            updated_at = now()
      WHERE id = $1`,
    [opts.vendorBillId, bill.edit_sequence, ` [qb_backfill de_adopted run=${opts.runId}]`]
  );

  return { vendor_bill_id: opts.vendorBillId, lines_added: linesAdded };
}
