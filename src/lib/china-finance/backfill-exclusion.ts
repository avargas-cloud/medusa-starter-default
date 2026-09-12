/**
 * China Finance es un control interno del saldo con el agente de compras
 * (VEETECH). El backfill QB→POS de compras (`docs/QB_DOCUMENTS_BACKFILL.md`,
 * plan `qb-docs-backfill-compras-20260911`) creó `vendor_bill` NATIVOS
 * (`qb_source IS NULL`) para documentos que YA estaban pagados y conciliados
 * en QuickBooks — nunca deberían entrar a China Finance como pendientes.
 *
 * `vendor_bill` no tiene columna `metadata` (a diferencia de `order`, que sí
 * la usa para su propio marcador `metadata->'qb_backfill'->>'run_id'` — ver
 * `lib/qb-backfill/sales-order-money.ts` / `reprice-backfilled-qb-orders.ts`).
 * El único marcador que `createBillFromQb`/`deAdoptBill`
 * (`lib/qb-backfill/create-bill.ts`) escriben en un bill del backfill es el
 * prefijo en `notes`:
 *
 *   [qb_backfill run=<run_id> txn=<qb_txn_id>[ via_link]] <memo opcional>
 *
 * Mismo prefijo en `purchase_order_receipt.notes` y `vendor_credit.notes`
 * (no aplica acá: ninguna ruta de China Finance registra recibos ni créditos
 * VEETECH automáticamente — ver auditoría en el script de datos).
 *
 * `qb_order_pipeline.metadata.qb_backfill.run_id` NO cubre compras: ese insert
 * sólo lo hace `lib/qb-backfill/sales-context.ts`, para el backfill de VENTAS.
 * No existe una fila de pipeline por bill/receipt/credit del backfill de
 * compras — `notes` es la única fuente.
 */

/** Prefijo literal que `create-bill.ts` escribe en `vendor_bill.notes`. */
export const QB_BACKFILL_NOTES_PREFIX = "[qb_backfill run=";

/**
 * Fragmento SQL (no parametrizado — el prefijo es una constante de este
 * archivo, no un input externo) que es TRUE cuando `<alias>.notes` NO lleva
 * el marcador del backfill. Se usa en el WHERE de toda query que decida si
 * un `vendor_bill` de VEETECH entra a China Finance.
 */
export function vendorBillNotBackfilledSql(alias: string): string {
  return `(${alias}.notes IS NULL OR ${alias}.notes NOT LIKE '${QB_BACKFILL_NOTES_PREFIX}%')`;
}

/** Inverso: TRUE cuando el bill SÍ es del backfill — para queries de detección/limpieza. */
export function vendorBillIsBackfilledSql(alias: string): string {
  return `(${alias}.notes LIKE '${QB_BACKFILL_NOTES_PREFIX}%')`;
}

type NotesQueryable = {
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  raw?: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

async function runQuery(
  db: NotesQueryable,
  sql: string,
  params: unknown[]
): Promise<{ rows: unknown[] }> {
  if (db.query) return db.query(sql, params);
  if (db.raw) return db.raw(sql, params);
  throw new Error("backfill-exclusion: db client sin query()/raw()");
}

/**
 * `true` si el `vendor_bill_id` dado pertenece al backfill (su `notes` lleva
 * el marcador). `false` también cuando el bill no existe — el llamador ya
 * validó existencia antes de preguntar esto.
 */
export async function isVendorBillFromBackfill(
  db: NotesQueryable,
  vendorBillId: string
): Promise<boolean> {
  const { rows } = await runQuery(
    db,
    `SELECT 1 FROM vendor_bill WHERE id = $1 AND ${vendorBillIsBackfilledSql("vendor_bill")} LIMIT 1`,
    [vendorBillId]
  );
  return rows.length > 0;
}

export class VendorBillIsBackfilledError extends Error {
  constructor(public readonly vendorBillId: string) {
    super(
      `El vendor bill ${vendorBillId} viene del backfill de QuickBooks (ya estaba pagado/conciliado en QB) ` +
        `y no puede entrar a China Finance — es un control interno con VEETECH, no un libro de compras.`
    );
    this.name = "VendorBillIsBackfilledError";
  }
}

/** Tira `VendorBillIsBackfilledError` si el bill es del backfill. Úsese antes de cualquier INSERT manual que reciba un `vendor_bill_id` explícito. */
export async function assertVendorBillNotBackfilled(
  db: NotesQueryable,
  vendorBillId: string
): Promise<void> {
  if (await isVendorBillFromBackfill(db, vendorBillId)) {
    throw new VendorBillIsBackfilledError(vendorBillId);
  }
}
