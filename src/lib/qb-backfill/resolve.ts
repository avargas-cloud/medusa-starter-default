/**
 * src/lib/qb-backfill/resolve.ts
 *
 * Índices de lo que el POS YA conoce, cargados una vez por corrida:
 * vendors, ítems (variantes), cuentas bancarias, y los TxnID de QB que cada
 * tipo de documento ya tiene enlazado. Todo por consulta SQL directa (nunca
 * un module service) para poder correr fuera de `medusa exec`.
 *
 * `QueryableDb` es el subconjunto de `pg.Pool` que se usa acá — permite
 * fakes triviales en los specs unitarios sin levantar Postgres.
 */

export interface QueryableDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface VendorIndexEntry {
  id: string;
  qb_list_id: string;
  full_name: string;
}

/** Índice de `qb_vendor`, keyeado por ListID de QB. */
export async function loadVendorIndex(db: QueryableDb): Promise<Map<string, VendorIndexEntry>> {
  const { rows } = await db.query(
    `SELECT id, qb_list_id, full_name FROM qb_vendor WHERE deleted_at IS NULL AND qb_list_id IS NOT NULL`
  );
  const map = new Map<string, VendorIndexEntry>();
  for (const r of rows) {
    map.set(String(r.qb_list_id), {
      id: String(r.id),
      qb_list_id: String(r.qb_list_id),
      full_name: String(r.full_name),
    });
  }
  return map;
}

export interface ItemIndexEntry {
  variant_id: string;
  inventory_item_id: string | null;
  sku: string;
  quickbooks_id: string | null;
}

export interface ItemIndex {
  byQbId: Map<string, ItemIndexEntry>;
  bySku: Map<string, ItemIndexEntry>;
}

/**
 * Índice de variantes por `metadata->>'quickbooks_id'` y por `sku`
 * (fallback: la parte final de `ItemRef.FullName` de QB tras el último
 * `:`, cuando el ítem es hijo de un grupo/subitem).
 */
export async function loadItemIndex(db: QueryableDb): Promise<ItemIndex> {
  const { rows } = await db.query(
    `SELECT pv.id AS variant_id, pv.sku, pv.metadata->>'quickbooks_id' AS quickbooks_id,
            pvii.inventory_item_id
       FROM product_variant pv
       LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      WHERE pv.deleted_at IS NULL`
  );
  const byQbId = new Map<string, ItemIndexEntry>();
  const bySku = new Map<string, ItemIndexEntry>();
  for (const r of rows) {
    const entry: ItemIndexEntry = {
      variant_id: String(r.variant_id),
      inventory_item_id: r.inventory_item_id ? String(r.inventory_item_id) : null,
      sku: r.sku ? String(r.sku) : "",
      quickbooks_id: r.quickbooks_id ? String(r.quickbooks_id) : null,
    };
    if (entry.quickbooks_id) byQbId.set(entry.quickbooks_id, entry);
    if (entry.sku) bySku.set(entry.sku, entry);
  }
  return { byQbId, bySku };
}

/**
 * Resuelve un `ItemRef` de QB contra el índice: primero por ListID, luego
 * por SKU exacto, luego por el segmento final del FullName (tras el último
 * `:`, forma `Grupo:Item`). `null` = faltante, lo crea `ensure.ts`.
 */
export function resolveItemRef(
  index: ItemIndex,
  ref: { list_id: string; full_name: string } | null
): ItemIndexEntry | null {
  if (!ref) return null;
  const byId = index.byQbId.get(ref.list_id);
  if (byId) return byId;
  const bySku = index.bySku.get(ref.full_name);
  if (bySku) return bySku;
  const lastSegment = ref.full_name.includes(":") ? ref.full_name.split(":").pop()! : null;
  if (lastSegment) {
    const bySegment = index.bySku.get(lastSegment);
    if (bySegment) return bySegment;
  }
  return null;
}

export interface BankAccountIndexEntry {
  id: string;
  list_id: string;
  name: string;
}

/** Índice de `qb_bank_account`, keyeado por ListID de QB. */
export async function loadBankAccountIndex(db: QueryableDb): Promise<Map<string, BankAccountIndexEntry>> {
  const { rows } = await db.query(
    `SELECT id, list_id, name FROM qb_bank_account WHERE deleted_at IS NULL`
  );
  const map = new Map<string, BankAccountIndexEntry>();
  for (const r of rows) {
    map.set(String(r.list_id), { id: String(r.id), list_id: String(r.list_id), name: String(r.name) });
  }
  return map;
}

async function loadTxnIdSet(db: QueryableDb, sql: string): Promise<Set<string>> {
  const { rows } = await db.query(sql);
  return new Set(rows.map((r) => String(Object.values(r)[0])));
}

export const loadKnownPoTxnIds = (db: QueryableDb): Promise<Set<string>> =>
  loadTxnIdSet(
    db,
    `SELECT qb_purchase_order_list_id FROM purchase_order WHERE deleted_at IS NULL AND qb_purchase_order_list_id IS NOT NULL`
  );

export const loadKnownReceiptTxnIds = (db: QueryableDb): Promise<Set<string>> =>
  loadTxnIdSet(
    db,
    `SELECT qb_item_receipt_list_id FROM purchase_order_receipt WHERE deleted_at IS NULL AND qb_item_receipt_list_id IS NOT NULL`
  );

export const loadKnownBillTxnIds = (db: QueryableDb): Promise<Set<string>> =>
  loadTxnIdSet(db, `SELECT qb_txn_id FROM vendor_bill WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL`);

export const loadKnownCreditTxnIds = (db: QueryableDb): Promise<Set<string>> =>
  loadTxnIdSet(db, `SELECT qb_txn_id FROM vendor_credit WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL`);

export const loadKnownPaymentTxnIds = (db: QueryableDb): Promise<Set<string>> =>
  loadTxnIdSet(db, `SELECT qb_txn_id FROM vendor_bill_payment WHERE deleted_at IS NULL AND qb_txn_id IS NOT NULL`);
