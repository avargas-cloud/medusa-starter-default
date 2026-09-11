/**
 * src/lib/qb-backfill/ensure.ts
 *
 * Política de faltantes del plan `qb-docs-backfill-compras-20260911`: un
 * vendor o ítem que QB referencia y el POS no conoce SE CREA, no se
 * bloquea. `ensureVendor`/`ensureItem` son idempotentes (releen antes de
 * insertar) y devuelven el id ya existente si otra fila del mismo run ya lo
 * creó.
 *
 * Escritura SOLO SQL directo — sin module service, sin workflow, sin
 * evento. `ensureItem` crea el producto DESCONTINUADO (`metadata.discontinued
 * = true`, convención de `build-inventory-docs.ts`) con la forma mínima que
 * usa `repair-unlinked-inventory-items.ts`: product + option "Title" +
 * option_value "Default Title" + variant + product_variant_option +
 * inventory_item + product_variant_inventory_item. NUNCA toca
 * `inventory_level` — el ítem nace sin stock en ningún location.
 */
import { ulid } from "ulid";
import type { QbRef } from "./types";
import type { QueryableDb } from "./resolve";

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

function slugify(str: string): string {
  return (
    str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

export interface EnsureLog {
  vendors_created: { qb_list_id: string; full_name: string; id: string }[];
  items_created: { qb_list_id: string; full_name: string; sku: string; variant_id: string }[];
}

export function newEnsureLog(): EnsureLog {
  return { vendors_created: [], items_created: [] };
}

/**
 * Crea (o devuelve) el `qb_vendor` para un `VendorRef` de QB. La política
 * aprobada: FALTANTE → crear con ListID + FullName, `is_active=true`,
 * `metadata.qb_backfill_created=true` como marcador de origen.
 */
export async function ensureVendor(
  db: QueryableDb,
  ref: QbRef,
  runId: string,
  log: EnsureLog
): Promise<string> {
  const existing = await db.query(
    `SELECT id FROM qb_vendor WHERE qb_list_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [ref.list_id]
  );
  const existingRow = existing.rows[0];
  if (existingRow) return String(existingRow.id);

  const id = makeId("qbvnd");
  await db.query(
    `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, is_active, metadata, last_synced_at, created_at, updated_at)
     VALUES ($1, $2, $3, $3, true, $4::jsonb, now(), now(), now())`,
    [id, ref.list_id, ref.full_name, JSON.stringify({ qb_backfill_created: true, qb_backfill_run_id: runId })]
  );
  log.vendors_created.push({ qb_list_id: ref.list_id, full_name: ref.full_name, id });
  return id;
}

export interface QbItemLookup {
  /** `PurchaseCost`/`Cost` en cents, si el `ItemQueryRq` lo trajo. */
  average_cost_cents: number | null;
}

/**
 * Crea (o devuelve) la variante para un `ItemRef` de QB ausente del índice.
 * `itemLookupFn` es opcional (`ItemQueryRq` por ListID, sólo lectura) para
 * poblar `metadata.average_cost`; si no se provee o QB no devuelve costo, el
 * producto nace sin costo (0), igual que un ítem creado a mano sin precio.
 */
export async function ensureItem(
  db: QueryableDb,
  ref: QbRef,
  runId: string,
  log: EnsureLog,
  itemLookupFn?: (listId: string) => Promise<QbItemLookup | null>
): Promise<{ variantId: string; inventoryItemId: string }> {
  const skuGuess = ref.full_name.includes(":") ? ref.full_name.split(":").pop()! : ref.full_name;

  const existing = await db.query(
    `SELECT pv.id AS variant_id, pvii.inventory_item_id
       FROM product_variant pv
       LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      WHERE (pv.metadata->>'quickbooks_id' = $1 OR pv.sku = $2) AND pv.deleted_at IS NULL
      LIMIT 1`,
    [ref.list_id, skuGuess]
  );
  const existingRow = existing.rows[0];
  if (existingRow && existingRow.inventory_item_id) {
    return {
      variantId: String(existingRow.variant_id),
      inventoryItemId: String(existingRow.inventory_item_id),
    };
  }

  const lookup = itemLookupFn ? await itemLookupFn(ref.list_id) : null;

  const prodId = makeId("prod");
  const optId = makeId("opt");
  const optValId = makeId("optval");
  const variantId = makeId("variant");
  const invItemId = makeId("iitem");
  const pviiId = makeId("pvitem");
  const handle = `${slugify(skuGuess)}-${prodId.slice(-6)}`;

  const metadata = JSON.stringify({
    quickbooks_id: ref.list_id,
    discontinued: true,
    qb_backfill_created: true,
    qb_backfill_run_id: runId,
    ...(lookup?.average_cost_cents != null
      ? { average_cost: lookup.average_cost_cents / 100 }
      : {}),
  });

  await db.query(
    `INSERT INTO product (id, title, handle, status, is_giftcard, discountable, metadata, created_at, updated_at)
     VALUES ($1, $2, $3, 'draft', false, true, $4::jsonb, now(), now())`,
    [prodId, ref.full_name, handle, metadata]
  );
  await db.query(
    `INSERT INTO product_option (id, title, product_id, created_at, updated_at)
     VALUES ($1, 'Title', $2, now(), now())`,
    [optId, prodId]
  );
  await db.query(
    `INSERT INTO product_option_value (id, value, option_id, created_at, updated_at)
     VALUES ($1, 'Default Title', $2, now(), now())`,
    [optValId, optId]
  );
  await db.query(
    `INSERT INTO product_variant (id, title, sku, product_id, manage_inventory, metadata, created_at, updated_at)
     VALUES ($1, 'Default Title', $2, $3, true, $4::jsonb, now(), now())`,
    [variantId, skuGuess, prodId, metadata]
  );
  await db.query(
    `INSERT INTO product_variant_option (variant_id, option_value_id)
     VALUES ($1, $2)`,
    [variantId, optValId]
  );
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $2, now(), now())`,
    [invItemId, skuGuess]
  );
  await db.query(
    `INSERT INTO product_variant_inventory_item (id, variant_id, inventory_item_id, required_quantity)
     VALUES ($1, $2, $3, 1)`,
    [pviiId, variantId, invItemId]
  );

  log.items_created.push({ qb_list_id: ref.list_id, full_name: ref.full_name, sku: skuGuess, variant_id: variantId });
  return { variantId, inventoryItemId: invItemId };
}
