/**
 * src/lib/qb-backfill/create-vendor-credit.ts
 *
 * Fase 3 del plan `qb-docs-backfill-compras-20260911`: crea un
 * `vendor_credit` + líneas para un `QbVendorCredit` que el POS no conoce.
 * `vendor_credit` NO TIENE columna `metadata` — el marcador va en `memo`.
 *
 * `stock_applied_at` queda NULL a propósito (misma regla que los recibos):
 * este backfill es sólo documento, nunca mueve stock.
 *
 * Línea de ítem enlazada a `purchase_order_line` sólo si `resolvedPoId`
 * resuelve Y la variante matchea una línea abierta del PO (greedy, igual que
 * receipts/bills) — si no, la línea se conserva SIN enlace, fiel al
 * documento QB (política aprobada del plan, a diferencia de la ruta nativa
 * que EXIGE PO para líneas de producto).
 */
import { ulid } from "ulid";
import { ensureVendor, ensureItem, type EnsureLog, type QbItemLookup } from "./ensure";
import { resolveItemRef, type ItemIndex, type QueryableDb, type VendorIndexEntry } from "./resolve";
import { matchPoLineForVariant, type OpenPoLine } from "./links";
import { businessInstant } from "./create-po";
import type { QbAccountLookupFn } from "./create-bill";
import type { QbVendorCredit } from "./types";

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export type CreditDecisionReason = "already" | "create";

export interface CreditDecision {
  create: boolean;
  reason: CreditDecisionReason;
}

export function decideCreditCreation(
  credit: QbVendorCredit,
  knownTxnIds: ReadonlySet<string>
): CreditDecision {
  if (knownTxnIds.has(credit.txn_id)) return { create: false, reason: "already" };
  return { create: true, reason: "create" };
}

/**
 * `applied_cents` = total − CreditRemaining de QB. QB no manda
 * `CreditRemaining` en `VendorCreditQueryRq` (no es un campo de esa
 * transacción — a diferencia de Bill/AmountDue): un vendor credit en QB
 * Desktop se aplica implícitamente al pagar el bill siguiente, no tiene
 * saldo propio expuesto por query. Sin esa señal, el backfill trae el
 * crédito con `applied_cents = 0` (todo el monto disponible) — es
 * responsabilidad de un paso POSTERIOR (fuera de este plan) reconciliar
 * aplicaciones reales contra `vendor_credit_application` si hicieran falta.
 */
export function deriveAppliedCents(): number {
  return 0;
}

export interface CreateVendorCreditOptions {
  runId: string;
  vendorIndex: Map<string, VendorIndexEntry>;
  itemIndex: ItemIndex;
  ensureLog: EnsureLog;
  itemLookupFn?: (listId: string) => Promise<QbItemLookup | null>;
  resolveQbAccount: QbAccountLookupFn;
  /** `purchase_order.id` local si `credit.linked_txns` resuelve a un PO conocido. */
  resolvedPoId: string | null;
  poLines: OpenPoLine[];
}

export interface CreateVendorCreditResult {
  vendor_credit_id: string;
  number: string;
  item_lines: number;
  expense_lines: number;
}

export async function createVendorCreditFromQb(
  client: QueryableDb,
  credit: QbVendorCredit,
  opts: CreateVendorCreditOptions
): Promise<CreateVendorCreditResult> {
  if (!credit.vendor_ref) {
    throw new Error(`VendorCredit ${credit.txn_id}: sin VendorRef — no se puede crear sin vendor`);
  }
  const knownVendor = opts.vendorIndex.get(credit.vendor_ref.list_id);
  const vendorId = knownVendor
    ? knownVendor.id
    : await ensureVendor(client, credit.vendor_ref, opts.runId, opts.ensureLog);
  const vendorNameSnapshot = knownVendor?.full_name ?? credit.vendor_ref.full_name;

  const numRes = await client.query(`SELECT 'VC-' || nextval('custom_vendor_credit_seq')::text AS number`);
  const number = (numRes.rows[0] as { number: string }).number;

  const id = makeId("vcr");
  const businessAt = businessInstant(credit.txn_date);
  const memo = `[qb_backfill run=${opts.runId} txn=${credit.txn_id}]` + (credit.memo ? ` ${credit.memo}` : "");
  const appliedCents = deriveAppliedCents();
  // VendorCreditRet NO trae TotalAmount (medido 2026-09-11: 46 créditos con total 0 quedaban
  // GL_UNBALANCED_DOCUMENT en el replay, porque el builder debita AP por `total_cents`).
  // El total es la suma de sus líneas; el de QB, si viene, sólo confirma.
  const linesTotalCents = [...credit.item_lines, ...credit.expense_lines].reduce((sum: number, l) => sum + l.amount_cents, 0);
  const totalCents = credit.amount_cents > 0 ? credit.amount_cents : linesTotalCents;

  await client.query(
    // `credit_date` es `date`; `qb_synced_at`/`posted_at`/`created_at`/
    // `updated_at` son `timestamptz` — reusar un solo `$N` entre ambos tipos
    // falla con "inconsistent types deduced for parameter $N" (sondeado).
    `INSERT INTO vendor_credit (
       id, number, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
       purchase_order_id, credit_date, memo, status, total_cents, applied_cents,
       qb_txn_id, qb_edit_sequence, qb_synced_at, posted_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posted',$9,$10,$11,$12,$13,$13,$13,$13)`,
    [
      id,
      number,
      vendorId,
      vendorNameSnapshot,
      credit.vendor_ref.list_id,
      opts.resolvedPoId,
      businessAt,
      memo,
      totalCents,
      appliedCents,
      credit.txn_id,
      credit.edit_sequence,
      businessAt,
    ]
  );

  const assignedQtyByPoLine = new Map<string, number>();
  let sort = 0;

  for (const line of credit.item_lines) {
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
      throw new Error(`VendorCredit ${credit.txn_id} línea ${line.txn_line_id}: sin ItemRef resoluble`);
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
      `INSERT INTO vendor_credit_line (
         id, credit_id, sort, line_type, variant_id, purchase_order_line_id,
         sku, description, qty, unit_cost_cents, amount_cents, created_at, updated_at
       ) VALUES ($1,$2,$3,'product',$4,$5,$6,$7,$8,$9,$10,now(),now())`,
      [
        makeId("vcrl"),
        id,
        sort++,
        item.variant_id,
        matched?.id ?? null,
        item.sku || line.item_ref?.full_name || "",
        line.description ?? item.sku ?? "(item)",
        qty,
        unitCostCents,
        line.amount_cents,
      ]
    );
  }

  for (const line of credit.expense_lines) {
    if (!line.account_ref) {
      throw new Error(`VendorCredit ${credit.txn_id} línea ${line.txn_line_id}: ExpenseLine sin AccountRef`);
    }
    const account = await opts.resolveQbAccount(line.account_ref.list_id);
    if (!account) {
      throw new Error(
        `VendorCredit ${credit.txn_id} línea ${line.txn_line_id}: cuenta QB ${line.account_ref.list_id} no resuelve en qb_account`
      );
    }
    await client.query(
      `INSERT INTO vendor_credit_line (
         id, credit_id, sort, line_type, description, amount_cents,
         qb_account_list_id, qb_account_full_name, qb_account_type, created_at, updated_at
       ) VALUES ($1,$2,$3,'qb_account',$4,$5,$6,$7,$8,now(),now())`,
      [
        makeId("vcrl"),
        id,
        sort++,
        line.description || account.full_name || "Expense",
        line.amount_cents,
        line.account_ref.list_id,
        account.full_name,
        account.account_type,
      ]
    );
  }

  return { vendor_credit_id: id, number, item_lines: credit.item_lines.length, expense_lines: credit.expense_lines.length };
}
