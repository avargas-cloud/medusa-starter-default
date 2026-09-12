/**
 * src/lib/qb-backfill/sales-context.ts
 *
 * Contexto compartido de los 4 creadores de ventas (`create-sales-*.ts`) y
 * helpers de escritura que todos repiten: marcador `qb_backfill`, fila de
 * `qb_order_pipeline` sembrada en `confirmed`/`skipped` (NUNCA despachable),
 * backdateo de `created_at`, costo promedio para snapshot de línea, y la
 * búsqueda de una factura del POS por TxnID de QB (por cualquiera de las
 * tres formas en que el POS guarda ese enlace).
 *
 * Los module services se reciben como interfaces ESTRUCTURALES mínimas
 * (`SalesServices`) — el script las resuelve del container y las castea una
 * sola vez; los specs las stubean sin levantar Medusa.
 */
import { ulid } from "ulid";

import { avgCostDollars } from "../cost/cost-sql";
import type { EnsureLog } from "./ensure";
import type { ItemIndex, QueryableDb } from "./resolve";
import type { QbRef } from "./types";

export function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

type Row = Record<string, unknown>;
type Created = { id: string };

export interface SalesServices {
  orderModule: {
    createOrders(data: Row): Promise<Created>;
    softDeleteOrders(ids: string[]): Promise<unknown>;
  };
  invoiceService: {
    createPosInvoices(data: Row): Promise<Created>;
    createPosInvoiceItems(data: Row[]): Promise<unknown>;
    createInvoicePayments(data: Row): Promise<Created>;
  };
  financeService: {
    createCustomerPayments(data: Row): Promise<Created | Created[]>;
    createPaymentApplications(data: Row): Promise<Created | Created[]>;
  };
  creditMemoService: {
    createPosCreditMemos(data: Row): Promise<Created | Created[]>;
    createPosCreditMemoItems(data: Row[]): Promise<unknown>;
  };
}

export function firstId(created: Created | Created[]): string {
  return Array.isArray(created) ? created[0]!.id : created.id;
}

export interface CustomerIndexEntry {
  id: string;
  email: string | null;
}

export interface SalesApplyContext {
  /** Conexión transaccional (`$1`) — el caller abre BEGIN/COMMIT por documento. */
  client: QueryableDb;
  services: SalesServices;
  runId: string;
  itemIndex: ItemIndex;
  /** `customer.metadata->>'qb_list_id'` → cliente del POS. */
  customerIndex: Map<string, CustomerIndexEntry>;
  ensureCustomer: (ref: QbRef) => Promise<string>;
  ensureLog: EnsureLog;
  log: (msg: string) => void;
  regionId: string;
  salesChannelId: string;
  goLiveDate: string;
}

export const BACKFILL_ACTOR = "QB Backfill (sales)";

export interface QbBackfillMarker {
  run_id: string;
  txn_id: string;
  txn_type: string;
  imported_at: string;
  via_link: boolean;
}

export function backfillMarker(runId: string, txnId: string, txnType: string, viaLink?: boolean): QbBackfillMarker {
  return { run_id: runId, txn_id: txnId, txn_type: txnType, imported_at: new Date().toISOString(), via_link: viaLink === true };
}

/** Índice `qb_list_id → {id, email}` de `customer`. */
export async function loadCustomerIndex(db: QueryableDb): Promise<Map<string, CustomerIndexEntry>> {
  const { rows } = await db.query(
    `SELECT id, email, metadata->>'qb_list_id' AS qb_list_id FROM customer
      WHERE deleted_at IS NULL AND metadata->>'qb_list_id' IS NOT NULL`
  );
  const map = new Map<string, CustomerIndexEntry>();
  for (const r of rows) map.set(String(r.qb_list_id), { id: String(r.id), email: r.email ? String(r.email) : null });
  return map;
}

/**
 * Política de faltantes (§1 del plan: crear desde QB): un `CustomerRef` que el
 * POS no conoce se crea con la forma mínima (nombre en `company_name`,
 * `metadata.qb_list_id`), sin cuenta ni email. Idempotente: relee antes.
 */
export function makeEnsureCustomer(
  db: QueryableDb,
  index: Map<string, CustomerIndexEntry>,
  runId: string,
  onCreate: (ref: QbRef, id: string) => void
): (ref: QbRef) => Promise<string> {
  return async (ref) => {
    const known = index.get(ref.list_id);
    if (known) return known.id;
    const { rows } = await db.query(
      `SELECT id, email FROM customer WHERE metadata->>'qb_list_id' = $1 AND deleted_at IS NULL LIMIT 1`,
      [ref.list_id]
    );
    if (rows[0]) {
      const entry = { id: String(rows[0].id), email: rows[0].email ? String(rows[0].email) : null };
      index.set(ref.list_id, entry);
      return entry.id;
    }
    const id = makeId("cus");
    await db.query(
      `INSERT INTO customer (id, company_name, has_account, metadata, created_by, created_at, updated_at)
       VALUES ($1, $2, false, $3::jsonb, $4, now(), now())`,
      [id, ref.full_name, JSON.stringify({ qb_list_id: ref.list_id, qb_backfill_created: true, qb_backfill_run_id: runId }), BACKFILL_ACTOR]
    );
    index.set(ref.list_id, { id, email: null });
    onCreate(ref, id);
    return id;
  };
}

export interface PipelineSeed {
  orderId: string | null;
  referenceId: string | null;
  referenceType: string | null;
  step: string;
  status: "confirmed" | "skipped";
  qbTxnId: string | null;
  qbRefNumber: string | null;
  medusaRefNumber: string | null;
  payload: Record<string, unknown>;
  error?: string | null;
}

/** Fila terminal de `qb_order_pipeline`: el GL importer la reconoce por `qb_txn_id` y `QB_CREATE_STEPS` no la vuelve a encolar. */
export async function seedPipelineRow(db: QueryableDb, runId: string, seed: PipelineSeed): Promise<void> {
  await db.query(
    `INSERT INTO qb_order_pipeline
       (order_id, reference_id, reference_type, step, status, qb_txn_id, qb_ref_number,
        medusa_ref_number, payload, error, submitted_at, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
             CASE WHEN $5 = 'confirmed' THEN now() ELSE NULL END, now())`,
    [
      seed.orderId,
      seed.referenceId,
      seed.referenceType,
      seed.step,
      seed.status,
      seed.qbTxnId,
      seed.qbRefNumber,
      seed.medusaRefNumber,
      JSON.stringify({ backfilled: true, run_id: runId, ...seed.payload }),
      seed.error ?? null,
    ]
  );
}

/** Backdatea `created_at`/`updated_at` de filas ya escritas por un module service (que las fecha en `now()`). */
export async function backdateRows(db: QueryableDb, table: string, ids: string[], instant: string): Promise<void> {
  if (ids.length === 0) return;
  await db.query(`UPDATE ${table} SET created_at = $1::timestamptz, updated_at = $1::timestamptz WHERE id = ANY($2::text[])`, [instant, ids]);
}

/** Ídem para las filas hijas por FK (`pos_invoice_item.invoice_id`, …). */
export async function backdateChildren(db: QueryableDb, table: string, fkColumn: string, parentId: string, instant: string): Promise<void> {
  await db.query(`UPDATE ${table} SET created_at = $1::timestamptz, updated_at = $1::timestamptz WHERE ${fkColumn} = $2`, [instant, parentId]);
}

/**
 * Costo promedio ACTUAL (dólares) por variante para el snapshot
 * `average_unit_cost` de las líneas. Es una aproximación: el costo vigente hoy,
 * no el del día del documento (el POS no tiene historial de costo por fecha para
 * ítems de USA). Misma expresión canónica que los lectores de COGS (`avgCostDollars`).
 */
export async function loadAvgCostDollars(db: QueryableDb, variantIds: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (variantIds.length === 0) return map;
  const { rows } = await db.query(
    `SELECT pv.id, ${avgCostDollars("pv")} AS cost FROM product_variant pv WHERE pv.id = ANY($1::text[])`,
    [variantIds]
  );
  for (const r of rows) map.set(String(r.id), r.cost == null ? null : Number(r.cost));
  return map;
}

export interface PosInvoiceRef {
  invoice_id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string;
}

/**
 * Factura del POS enlazada a un TxnID de QB, por cualquiera de las tres vías:
 * `pos_invoice.metadata.qb_txn_id` (nativas y este backfill),
 * `order.metadata.qb_invoice_txn_id` (backfills anteriores) o el array
 * `order.metadata.qb_invoices[]` (flujo nativo multi-factura).
 */
export async function findPosInvoiceByQbTxnId(db: QueryableDb, txnId: string): Promise<PosInvoiceRef | null> {
  const { rows } = await db.query(
    `SELECT i.id AS invoice_id, i.invoice_number, i.order_id, i.customer_id
       FROM pos_invoice i
      WHERE i.deleted_at IS NULL AND i.metadata->>'qb_txn_id' = $1
     UNION
     SELECT i.id, i.invoice_number, i.order_id, i.customer_id
       FROM "order" o JOIN pos_invoice i ON i.order_id = o.id AND i.deleted_at IS NULL
      WHERE o.deleted_at IS NULL AND o.metadata->>'qb_invoice_txn_id' = $1
     UNION
     SELECT i.id, i.invoice_number, i.order_id, i.customer_id
       FROM "order" o
       JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.metadata->'qb_invoices') = 'array' THEN o.metadata->'qb_invoices' ELSE '[]'::jsonb END) e ON true
       JOIN pos_invoice i ON i.id = e->>'invoice_id' AND i.deleted_at IS NULL
      WHERE o.deleted_at IS NULL AND e->>'txn_id' = $1
     LIMIT 1`,
    [txnId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    invoice_id: String(r.invoice_id),
    invoice_number: String(r.invoice_number),
    order_id: String(r.order_id),
    customer_id: String(r.customer_id),
  };
}

export interface KnownSalesTxnIds {
  invoices: Set<string>;
  sales_receipts: Set<string>;
  receive_payments: Set<string>;
  credit_memos: Set<string>;
}

function toSet(rows: Record<string, unknown>[]): Set<string> {
  return new Set(rows.map((r) => String(r.t)).filter((t) => t && t !== "SYNCED_VIA_RECEIPT"));
}

/** TxnIDs de QB que el POS ya tiene enlazados, por tipo — la idempotencia del apply. */
export async function loadKnownSalesTxnIds(db: QueryableDb): Promise<KnownSalesTxnIds> {
  const inv = await db.query(
    `SELECT metadata->>'qb_txn_id' AS t FROM pos_invoice WHERE deleted_at IS NULL AND coalesce(metadata->>'is_sales_receipt','false') <> 'true'
     UNION SELECT metadata->>'qb_invoice_txn_id' FROM "order" WHERE deleted_at IS NULL
     UNION SELECT e->>'txn_id' FROM "order" o, jsonb_array_elements(CASE WHEN jsonb_typeof(o.metadata->'qb_invoices') = 'array' THEN o.metadata->'qb_invoices' ELSE '[]'::jsonb END) e WHERE o.deleted_at IS NULL
     UNION SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'invoice' AND status IN ('confirmed','fixed')`
  );
  const sr = await db.query(
    `SELECT metadata->>'qb_txn_id' AS t FROM pos_invoice WHERE deleted_at IS NULL AND metadata->>'is_sales_receipt' = 'true'
     UNION SELECT metadata->>'qb_sales_receipt_txn_id' FROM "order" WHERE deleted_at IS NULL
     UNION SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'sales_receipt' AND status IN ('confirmed','fixed')`
  );
  const pay = await db.query(
    `SELECT metadata->>'qb_txn_id' AS t FROM customer_payment WHERE deleted_at IS NULL
     UNION SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'payment' AND status IN ('confirmed','fixed')
     UNION SELECT l.qb_txn_id FROM qb_legacy_payment l JOIN customer_payment cp ON cp.id = l.applied_payment_id AND cp.deleted_at IS NULL`
  );
  const cm = await db.query(
    `SELECT qb_txn_id AS t FROM pos_credit_memo WHERE deleted_at IS NULL
     UNION SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'credit_memo' AND status IN ('confirmed','fixed')`
  );
  return { invoices: toSet(inv.rows), sales_receipts: toSet(sr.rows), receive_payments: toSet(pay.rows), credit_memos: toSet(cm.rows) };
}
