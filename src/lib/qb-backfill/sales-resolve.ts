/**
 * src/lib/qb-backfill/sales-resolve.ts
 *
 * Lado VENTAS de `resolve.ts`: índice de clientes que el POS ya conoce, TxnIDs
 * de QB ya enlazados a los 4 tipos de documento de venta, `ensureCustomer`
 * (mismo patrón que `ensureVendor` en `ensure.ts` — SQL directo, sin module
 * service), y `classifySalesLine` (clasificador PURO de una línea de QB
 * contra el índice de ítems de `resolve.ts`).
 *
 * Union de TxnIDs conocidos por tipo — mismas columnas que
 * `lib/ledger/qb-import/pos-links.ts` usa para el lado que el libro postea,
 * separadas acá por tipo de documento porque cada bucket de venta se
 * clasifica de forma independiente:
 *
 *   invoice        → order.metadata->>'qb_invoice_txn_id' (flat)
 *                     order.metadata->'qb_invoices'[].txn_id (array)
 *                     qb_order_pipeline.qb_txn_id WHERE step='invoice'
 *   sales_receipt  → order.metadata->>'qb_sales_receipt_txn_id'
 *                     pos_invoice.metadata->>'qb_txn_id'
 *                     qb_order_pipeline.qb_txn_id WHERE step='sales_receipt'
 *   payment        → customer_payment.metadata->>'qb_txn_id'
 *                     customer_payment.qb->>'txn_id'
 *                     qb_order_pipeline.qb_txn_id WHERE step IN ('payment','apply_payment')
 *                     qb_legacy_payment.qb_txn_id SÓLO si su applied_payment_id es un
 *                     customer_payment vivo (una fila `pending` del staging NO es un pago
 *                     del POS: 67 pagos de 2026 se saltearon por contarla como conocida)
 *   credit_memo    → pos_credit_memo.qb_txn_id
 *                     qb_order_pipeline.qb_txn_id WHERE step='credit_memo'
 */
import { ulid } from "ulid";
import type { QbRef } from "./types";
import type { ItemIndex, ItemIndexEntry, QueryableDb } from "./resolve";
import { resolveItemRef } from "./resolve";
import type { QbSalesLine } from "./sales-types";

export interface CustomerIndexEntry {
  id: string;
  email: string | null;
  name: string;
}

export interface CustomerIndex {
  /** Keyeado por `metadata->>'qb_list_id'`. */
  byListId: Map<string, CustomerIndexEntry>;
  /** Keyeado por nombre normalizado (lowercase/trim) — SÓLO clientes sin `qb_list_id`. Reporte, nunca auto-match silencioso. */
  byName: Map<string, CustomerIndexEntry>;
}

/** Índice de `customer`, por `metadata->>'qb_list_id'` y por nombre normalizado. */
export async function loadCustomerIndex(db: QueryableDb): Promise<CustomerIndex> {
  const { rows } = await db.query(
    `SELECT id, email, metadata->>'qb_list_id' AS qb_list_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), ''), company_name, email, id) AS name
       FROM customer WHERE deleted_at IS NULL`
  );
  const byListId = new Map<string, CustomerIndexEntry>();
  const byName = new Map<string, CustomerIndexEntry>();
  for (const r of rows) {
    const entry: CustomerIndexEntry = {
      id: String(r.id),
      email: r.email ? String(r.email) : null,
      name: String(r.name),
    };
    const listId = r.qb_list_id ? String(r.qb_list_id) : null;
    if (listId) {
      byListId.set(listId, entry);
    } else {
      byName.set(entry.name.trim().toLowerCase(), entry);
    }
  }
  return { byListId, byName };
}

export interface CustomerResolution {
  id: string;
  how: "list_id" | "name";
}

/**
 * Resuelve un `CustomerRef` de QB contra el índice: por ListID primero, y
 * SÓLO si eso falla, por nombre normalizado (reportado con `how:'name'` —
 * el caller decide si confiar en ese match o tratarlo como faltante; nunca
 * se auto-asigna el ListID a la fila encontrada por nombre).
 */
export function resolveCustomerRef(index: CustomerIndex, ref: QbRef | null): CustomerResolution | null {
  if (!ref) return null;
  const byId = index.byListId.get(ref.list_id);
  if (byId) return { id: byId.id, how: "list_id" };
  const byName = index.byName.get(ref.full_name.trim().toLowerCase());
  if (byName) return { id: byName.id, how: "name" };
  return null;
}

async function loadTxnIdSet(db: QueryableDb, sql: string, params: unknown[] = []): Promise<Set<string>> {
  const { rows } = await db.query(sql, params);
  return new Set(rows.map((r) => String(Object.values(r)[0])));
}

export interface KnownSalesTxnIds {
  invoices: Set<string>;
  sales_receipts: Set<string>;
  payments: Set<string>;
  credit_memos: Set<string>;
}

/** TxnIDs de QB ya enlazados a un documento de venta del POS, por tipo. */
export async function loadKnownSalesTxnIds(db: QueryableDb): Promise<KnownSalesTxnIds> {
  const [invoices, sales_receipts, payments, credit_memos] = await Promise.all([
    loadTxnIdSet(
      db,
      `SELECT DISTINCT t FROM (
         SELECT metadata->>'qb_invoice_txn_id' t FROM "order" WHERE deleted_at IS NULL AND metadata->>'qb_invoice_txn_id' IS NOT NULL
         UNION
         SELECT elem->>'txn_id' FROM "order", jsonb_array_elements(metadata->'qb_invoices') elem
          WHERE deleted_at IS NULL AND jsonb_typeof(metadata->'qb_invoices') = 'array'
         UNION
         SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'invoice' AND status NOT IN ('failed','skipped')
       ) u WHERE t IS NOT NULL AND t <> ''`
    ),
    loadTxnIdSet(
      db,
      `SELECT DISTINCT t FROM (
         SELECT metadata->>'qb_sales_receipt_txn_id' t FROM "order" WHERE deleted_at IS NULL AND metadata->>'qb_sales_receipt_txn_id' IS NOT NULL
         UNION
         SELECT metadata->>'qb_txn_id' FROM pos_invoice WHERE deleted_at IS NULL AND metadata->>'qb_txn_id' IS NOT NULL
         UNION
         SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'sales_receipt' AND status NOT IN ('failed','skipped')
       ) u WHERE t IS NOT NULL AND t <> ''`
    ),
    loadTxnIdSet(
      db,
      `SELECT DISTINCT t FROM (
         SELECT metadata->>'qb_txn_id' t FROM customer_payment WHERE deleted_at IS NULL AND metadata->>'qb_txn_id' IS NOT NULL
         UNION
         SELECT qb->>'txn_id' FROM customer_payment WHERE deleted_at IS NULL AND qb->>'txn_id' IS NOT NULL
         UNION
         SELECT qb_txn_id FROM qb_order_pipeline WHERE step IN ('payment', 'apply_payment') AND status NOT IN ('failed','skipped')
         UNION
         SELECT l.qb_txn_id FROM qb_legacy_payment l JOIN customer_payment cp ON cp.id = l.applied_payment_id AND cp.deleted_at IS NULL WHERE l.qb_txn_id IS NOT NULL
       ) u WHERE t IS NOT NULL AND t <> ''`
    ),
    loadTxnIdSet(
      db,
      `SELECT DISTINCT t FROM (
         SELECT qb_txn_id t FROM pos_credit_memo WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
         UNION
         SELECT qb_txn_id FROM qb_order_pipeline WHERE step = 'credit_memo' AND status NOT IN ('failed','skipped')
       ) u WHERE t IS NOT NULL AND t <> ''`
    ),
  ]);
  return { invoices, sales_receipts, payments, credit_memos };
}

/** Log de faltantes creados en esta corrida — mismo rol que `EnsureLog` (`ensure.ts`), sin tocar ese archivo (compartido con el lado compras). */
export interface SalesEnsureLog {
  customers_created: { qb_list_id: string; full_name: string; id: string }[];
}

export function newSalesEnsureLog(): SalesEnsureLog {
  return { customers_created: [] };
}

function slugifyListId(listId: string): string {
  return (
    listId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/**
 * Crea (o devuelve) el `customer` para un `CustomerRef` de QB ausente del
 * índice. Política igual a `ensureVendor`: FALTANTE → crear, nunca bloquear.
 * Email sintético `qb-<listid>@backfill.local` (nunca se manda correo real a
 * esa dirección — es sólo la clave única que Medusa exige) y
 * `has_account=false` (el cliente del backfill no puede loguearse).
 */
export async function ensureCustomer(
  db: QueryableDb,
  ref: QbRef,
  runId: string,
  log: SalesEnsureLog
): Promise<string> {
  const existing = await db.query(
    `SELECT id FROM customer WHERE metadata->>'qb_list_id' = $1 AND deleted_at IS NULL LIMIT 1`,
    [ref.list_id]
  );
  const existingRow = existing.rows[0];
  if (existingRow) return String(existingRow.id);

  const id = `cus_${ulid().toLowerCase()}`;
  const email = `qb-${slugifyListId(ref.list_id)}@backfill.local`;
  const metadata = JSON.stringify({ qb_list_id: ref.list_id, qb_backfill: { run_id: runId, created: true } });
  await db.query(
    `INSERT INTO customer (id, email, first_name, has_account, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, false, $4::jsonb, now(), now())`,
    [id, email, ref.full_name, metadata]
  );
  log.customers_created.push({ qb_list_id: ref.list_id, full_name: ref.full_name, id });
  return id;
}

export type SalesLineKind = "product" | "discount" | "shipping" | "subtotal" | "sales_tax" | "unknown_item";

export interface ClassifiedSalesLine {
  kind: SalesLineKind;
  variant?: ItemIndexEntry;
}

const SHIPPING_RE = /^(shipping|freight|delivery)/i;
const TAX_RE = /sales\s*tax|tax/i;
const SUBTOTAL_RE = /^subtotal$/i;

function lastSegment(fullName: string): string {
  return fullName.includes(":") ? fullName.split(":").pop()! : fullName;
}

/**
 * Clasifica una línea de venta contra el índice de ítems. Orden de checks
 * (primer match gana):
 *
 *   1. `product`     — `resolveItemRef` resuelve el ítem (mismo fallback
 *                       ListID → SKU → segmento final que compras).
 *   2. `subtotal`     — el segmento final del `FullName` es "Subtotal"
 *                       (case-insensitive), o la línea no trae cantidad/rate
 *                       y su monto iguala `runningSum` (suma acumulada de las
 *                       líneas previas — el caller la lleva; `undefined` si
 *                       no se provee, y ese ramal queda inerte).
 *   3. `discount`     — monto negativo y sin cantidad.
 *   4. `shipping`     — segmento final matchea `/^(shipping|freight|delivery)/i`.
 *   5. `sales_tax`    — sin cantidad y el segmento final matchea `/sales tax|tax/i`.
 *   6. `unknown_item` — nada de lo anterior; el caller decide (`ensureItem`).
 */
export function classifySalesLine(line: QbSalesLine, itemIndex: ItemIndex, runningSum?: number): ClassifiedSalesLine {
  const variant = resolveItemRef(itemIndex, line.item_ref);
  if (variant) return { kind: "product", variant };

  const seg = line.item_ref ? lastSegment(line.item_ref.full_name) : "";
  const hasNoQtyOrRate = line.quantity == null && line.rate_cents == null;

  if (SUBTOTAL_RE.test(seg)) return { kind: "subtotal" };
  if (hasNoQtyOrRate && runningSum !== undefined && line.amount_cents === runningSum) return { kind: "subtotal" };
  if (line.amount_cents < 0 && line.quantity == null) return { kind: "discount" };
  if (SHIPPING_RE.test(seg)) return { kind: "shipping" };
  if (line.quantity == null && TAX_RE.test(seg)) return { kind: "sales_tax" };
  return { kind: "unknown_item" };
}
