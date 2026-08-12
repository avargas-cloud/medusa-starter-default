/**
 * Sección del digest para el drift de reservas — la clase de daño detrás del
 * incidente S11179 (2026-08-12). Dos detectores, ambos READ-ONLY:
 *
 *  A. CACHE DRIFT — `inventory_level.reserved_quantity` ≠ SUM de las
 *     `reservation_item` vivas de ese (item, location). Lo produce la carrera
 *     del módulo de inventario de Medusa (read-modify-write con escritura
 *     absoluta, sin lock) bajo los flujos delete-then-create del POS
 *     (allocate-items, void-restore, close-release, pickup-dedup).
 *
 *  B. CONTADOR ENVENENADO — `order_item.fulfilled_quantity` (numérico) ≠ su
 *     espejo `raw_fulfilled_quantity` en la versión VIGENTE de la orden. Es la
 *     firma exacta que hizo que el repair script clasificara como huérfano el
 *     apartado real de S11179: el numérico decía 6, el raw (y los fulfillments
 *     vivos) decían 3.
 *
 * ESTA SECCIÓN REPORTA Y NO REPARA, a propósito. La reparación de reservas
 * borra datos de negocio y el 2026-08-12 un borrado automático se llevó un
 * apartado legítimo — desde entonces toda deleción de reservas exige ojos
 * humanos (`scripts/fix/repair-reservation-integrity.ts`, dry-run primero, y
 * su regla de huérfanas exige que numérico Y fulfillments vivos coincidan).
 *
 * Sin dedup: el estado estacionario es cero filas, el silencio significa limpio
 * (mismo criterio que la sección del índice orders). Fail-isolated: un error
 * devuelve null y el digest sale igual. Filename con `_`: el JobLoader excluye
 * por FILENAME, no por directorio.
 */

interface KnexRaw {
  raw: <T = { rows: unknown[] }>(sql: string, bindings?: unknown[]) => Promise<T>;
}

interface SectionRow {
  id: string;
  medusa_ref: string;
  qb_ref: string;
  step: string;
  error: string;
  retries: number;
  status: string;
  created_at: string | Date;
}

export interface ReservationDriftSection {
  title: string;
  description: string;
  admin_path: string;
  rows: SectionRow[];
}

interface CacheDriftRow {
  sku: string | null;
  location_name: string | null;
  inventory_item_id: string;
  cached: string;
  real: string;
}

interface PoisonedCounterRow {
  doc: string | null;
  sku: string | null;
  item_id: string;
  numeric_value: string;
  raw_value: string | null;
}

export async function collectReservationDriftSection(
  knex: KnexRaw,
  logger: { warn: (m: string) => void }
): Promise<ReservationDriftSection | null> {
  try {
    const cacheRes = await knex.raw<{ rows: CacheDriftRow[] }>(`
      SELECT pv.sku,
             sl.name AS location_name,
             il.inventory_item_id,
             il.reserved_quantity::text AS cached,
             COALESCE(r.sum_qty, 0)::text AS real
      FROM inventory_level il
      LEFT JOIN (
        SELECT inventory_item_id, location_id, SUM(quantity) AS sum_qty
        FROM reservation_item
        WHERE deleted_at IS NULL
        GROUP BY inventory_item_id, location_id
      ) r ON r.inventory_item_id = il.inventory_item_id
         AND r.location_id = il.location_id
      LEFT JOIN product_variant_inventory_item pvii
        ON pvii.inventory_item_id = il.inventory_item_id
      LEFT JOIN product_variant pv ON pv.id = pvii.variant_id
      LEFT JOIN stock_location sl ON sl.id = il.location_id
      WHERE il.deleted_at IS NULL
        AND il.reserved_quantity <> COALESCE(r.sum_qty, 0)
      ORDER BY pv.sku NULLS LAST
      LIMIT 40
    `);

    const poisonedRes = await knex.raw<{ rows: PoisonedCounterRow[] }>(`
      SELECT COALESCE(o.metadata->>'document_number', '#' || o.display_id::text) AS doc,
             pv.sku,
             oi.item_id,
             oi.fulfilled_quantity::text AS numeric_value,
             oi.raw_fulfilled_quantity->>'value' AS raw_value
      FROM order_item oi
      JOIN "order" o ON o.id = oi.order_id
        AND o.version = oi.version
        AND o.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id
      LEFT JOIN product_variant pv ON pv.id = oli.variant_id
      WHERE oi.deleted_at IS NULL
        AND oi.fulfilled_quantity::text <> COALESCE(oi.raw_fulfilled_quantity->>'value', '')
      ORDER BY 1
      LIMIT 40
    `);

    const cacheRows = cacheRes.rows;
    const poisonedRows = poisonedRes.rows;
    if (cacheRows.length === 0 && poisonedRows.length === 0) return null;

    const now = new Date();
    const rows: SectionRow[] = [
      ...cacheRows.map((r) => ({
        id: r.inventory_item_id,
        medusa_ref: r.sku ?? r.inventory_item_id,
        qb_ref: r.location_name ?? "",
        step: "reserved cache != live reservations",
        error: `cache=${r.cached} vs live rows=${r.real} — run repair-reservation-integrity.ts (dry-run first)`,
        retries: 0,
        status: "cache_drift",
        created_at: now,
      })),
      ...poisonedRows.map((r) => ({
        id: r.item_id,
        medusa_ref: `${r.doc ?? ""} ${r.sku ?? ""}`.trim() || r.item_id,
        qb_ref: "",
        step: "fulfilled_quantity numeric != raw mirror",
        error: `numeric=${r.numeric_value} vs raw=${r.raw_value ?? "∅"} — poisoned counter (S11179 class); verify against LIVE fulfillments before trusting either`,
        retries: 0,
        status: "poisoned_counter",
        created_at: now,
      })),
    ];

    return {
      title: "Reservation drift (cache + poisoned counters)",
      description:
        "Read-only report — NOTHING was auto-repaired. Cache drift: the reserved " +
        "counter disagrees with the live reservation rows (Medusa module race). " +
        "Poisoned counter: fulfilled_quantity disagrees with its raw mirror on the " +
        "CURRENT order version — the exact class that mislabeled a real backorder " +
        "as an orphan on S11179. Fix by hand via repair-reservation-integrity.ts " +
        "(dry-run first); deleting reservations requires human eyes. Repeats daily " +
        "while the drift exists.",
      admin_path: "/purchasing-analysis?tab=openorders",
      rows,
    };
  } catch (e) {
    logger.warn(
      `[digest] reservation-drift section failed (digest continues): ${(e as Error).message}`
    );
    return null;
  }
}
