/**
 * Consolida ESP-ECA40W0830-L / 0840-L / 0860-L como las 3 variantes del producto
 * padre ESP-ECA40W08-L (prod_01KK53MR87D80KQDC5Q4K28QEY).
 *
 * QUÉ PASÓ: 0840-L y 0860-L se crearon como productos INDEPENDIENTES (junio 2026)
 * en vez de como variantes del padre. El 2026-08-31 se agregaron al padre 3
 * variantes con SKU `…-L1` (sufijo 1 porque los SKU reales estaban tomados), que
 * nacieron VACÍAS: precio 0, sin inventory item, sin QuickBooks, sin historia.
 *
 * POR QUÉ RE-PARENTAR Y NO COPIAR: cada variante vieja carga su identidad de
 * QuickBooks (`quickbooks_id`), su costo (average_cost / purchase_cost), sus
 * precios (retail 250 / wholesale 199), su inventory item con stock y reservas
 * vivas, y es referenciada por 8 líneas de orden, 8 líneas de PO y 7 líneas de
 * pos_invoice. Copiar esos datos a las `-L1` obligaría a recrear inventory items,
 * re-linkear QuickBooks y dejar toda esa historia apuntando a variantes borradas.
 * Mover la FILA (cambiar `product_id` + su link de opción) lo preserva todo sin
 * tocar una sola tabla de inventario, de órdenes ni de QuickBooks.
 *
 * EFECTOS EXTERNOS: ninguno. No emite nada a QuickBooks. No toca precios,
 * inventory_item, inventory_level, reservation_item, order_line_item,
 * purchase_order_line ni qb_item_pipeline.
 *
 * Todo corre en UNA transacción. `snapshot-before.json` (tomado aparte) permite
 * revertir: los soft-delete con `deleted_at = NULL`, el re-parent restaurando
 * `product_id`.
 *
 * Dry-run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/fix/consolidate-eca40w08l-variants.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true npx medusa exec ...
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { getDbPool } from "../../api/utils/db-pool";

const PARENT_PRODUCT_ID = "prod_01KK53MR87D80KQDC5Q4K28QEY";
const PARENT_TITLE = "ESP-ECA40W08-L";
const PARENT_HANDLE = "esp-eca40w08-l";

/** El producto hermano SIN `-L`. Nunca se toca; sólo se lee para asertar que no cambió. */
const SIBLING_PRODUCT_ID = "prod_01KK5CFJVF0KXM6JEHCZ6PSJWP";

interface KeepSpec {
  /** SKU real, el que queda. Nunca se reescribe. */
  sku: string;
  /** Valor de la opción "Color Options" al que se engancha. */
  optionValue: string;
  /** `metadata.variation` del sistema de atributos (slug del valor). */
  variation: string;
  /** Producto del que sale, o `null` si ya está en el padre. */
  fromProductId: string | null;
  rank: number;
}

/** Las 3 variantes que SOBREVIVEN, con toda su historia intacta. */
const KEEP: KeepSpec[] = [
  {
    sku: "ESP-ECA40W0830-L",
    optionValue: "3000K",
    variation: "3000k",
    fromProductId: null, // ya vive en el padre, sólo le falta el link de opción
    rank: 0,
  },
  {
    sku: "ESP-ECA40W0840-L",
    optionValue: "4000K",
    variation: "4000k",
    fromProductId: "prod_01KVE3K0PRPH41EW13WRXPQ0XK",
    rank: 1,
  },
  {
    sku: "ESP-ECA40W0860-L",
    optionValue: "6000K",
    variation: "6000k",
    fromProductId: "prod_01KVE3YWBRRH9VE84A4GSDCHWA",
    rank: 2,
  },
];

/** Las 3 cáscaras vacías creadas el 2026-08-31. Se retiran. */
const DROP_SKUS = [
  "ESP-ECA40W0830-L1",
  "ESP-ECA40W0840-L1",
  "ESP-ECA40W0860-L1",
];

/** Productos que quedan vacíos al mudar su única variante. Se retiran. */
const RETIRE_PRODUCT_IDS = KEEP.map((k) => k.fromProductId).filter(
  (id): id is string => id !== null
);

const OPTION_TITLE = "Color Options";

interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  title: string;
  variant_rank: number | null;
  metadata: Record<string, unknown> | null;
}

interface InventoryFingerprint {
  sku: string;
  inventory_item_id: string;
  location_id: string;
  stocked_quantity: string;
  reserved_quantity: string;
  incoming_quantity: string;
}

function fail(msg: string): never {
  throw new Error(`[consolidate-eca40w08l] PRECONDICIÓN FALLIDA: ${msg}`);
}

export default async function run({ container: _container }: ExecArgs) {
  const apply = process.env.APPLY === "1" || process.env.APPLY === "true";
  const pool = getDbPool();
  const client = await pool.connect();

  const allSkus = [...KEEP.map((k) => k.sku), ...DROP_SKUS];

  try {
    // ---------------------------------------------------------------- PREFLIGHT
    // Todo lo que sigue es fail-closed: si el mundo no está exactamente como el
    // plan dice, el script no escribe nada. Un "casi igual" es un mundo distinto.

    const { rows: variants } = await client.query<VariantRow>(
      `SELECT id, product_id, sku, title, variant_rank, metadata
         FROM product_variant
        WHERE sku = ANY($1::text[]) AND deleted_at IS NULL`,
      [allSkus]
    );

    if (variants.length !== 6) {
      fail(
        `esperaba 6 variantes vivas (${allSkus.join(", ")}), encontré ${variants.length}: ` +
          variants.map((v) => v.sku).join(", ")
      );
    }

    const bySku = new Map(variants.map((v) => [v.sku, v]));

    // Las que se retiran tienen que estar REALMENTE vacías. Si alguna adquirió
    // un inventory item, un precio distinto de 0 o una línea de orden desde que
    // se escribió este script, borrarla dejaría de ser inocuo.
    const dropIds = DROP_SKUS.map((s) => bySku.get(s)!.id);

    const { rows: dropInv } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product_variant_inventory_item
        WHERE variant_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [dropIds]
    );
    if (dropInv[0].n !== "0") {
      fail(
        `una variante -L1 tiene inventory item (${dropInv[0].n}) — ya no es una cáscara vacía, abortar`
      );
    }

    const { rows: dropRefs } = await client.query<{
      order_lines: string;
      po_lines: string;
      invoice_lines: string;
      qb_rows: string;
    }>(
      `SELECT
         (SELECT count(*) FROM order_line_item        WHERE variant_id         = ANY($1::text[]))::text AS order_lines,
         (SELECT count(*) FROM purchase_order_line    WHERE product_variant_id = ANY($1::text[]))::text AS po_lines,
         (SELECT count(*) FROM pos_invoice_item       WHERE variant_id         = ANY($1::text[]))::text AS invoice_lines,
         (SELECT count(*) FROM qb_item_pipeline       WHERE variant_id         = ANY($1::text[]))::text AS qb_rows`,
      [dropIds]
    );
    const r = dropRefs[0];
    if (
      r.order_lines !== "0" ||
      r.po_lines !== "0" ||
      r.invoice_lines !== "0" ||
      r.qb_rows !== "0"
    ) {
      fail(
        `una variante -L1 ya tiene historia (órdenes ${r.order_lines}, PO ${r.po_lines}, ` +
          `invoices ${r.invoice_lines}, QB ${r.qb_rows}) — abortar`
      );
    }

    const { rows: dropPrices } = await client.query<{ amount: string }>(
      `SELECT pz.amount::text AS amount
         FROM product_variant_price_set pvps
         JOIN price pz ON pz.price_set_id = pvps.price_set_id AND pz.deleted_at IS NULL
        WHERE pvps.variant_id = ANY($1::text[]) AND pvps.deleted_at IS NULL`,
      [dropIds]
    );
    const nonZero = dropPrices.filter((p) => Number(p.amount) !== 0);
    if (nonZero.length > 0) {
      fail(
        `una variante -L1 tiene precio distinto de 0 (${nonZero.map((p) => p.amount).join(", ")}) — abortar`
      );
    }

    // Las que se conservan tienen que llevar su identidad de QuickBooks: es la
    // prueba de que estamos mudando la variante REAL y no una cáscara.
    for (const spec of KEEP) {
      const v = bySku.get(spec.sku)!;
      const qbId = (v.metadata ?? {})["quickbooks_id"];
      if (typeof qbId !== "string" || qbId.length === 0) {
        fail(`${spec.sku} no tiene metadata.quickbooks_id — no es la variante real`);
      }
      const expectedProduct = spec.fromProductId ?? PARENT_PRODUCT_ID;
      if (v.product_id !== expectedProduct) {
        fail(
          `${spec.sku} está en ${v.product_id}, esperaba ${expectedProduct} — el mundo cambió`
        );
      }
    }

    // La opción destino y sus 3 valores.
    const { rows: optRows } = await client.query<{ id: string }>(
      `SELECT id FROM product_option
        WHERE product_id = $1 AND title = $2 AND deleted_at IS NULL`,
      [PARENT_PRODUCT_ID, OPTION_TITLE]
    );
    if (optRows.length !== 1) {
      fail(
        `esperaba exactamente 1 opción "${OPTION_TITLE}" en el padre, encontré ${optRows.length}`
      );
    }
    const optionId = optRows[0].id;

    const { rows: optValRows } = await client.query<{
      id: string;
      value: string;
    }>(
      `SELECT id, value FROM product_option_value
        WHERE option_id = $1 AND deleted_at IS NULL`,
      [optionId]
    );
    const valueToId = new Map(optValRows.map((o) => [o.value, o.id]));
    for (const spec of KEEP) {
      if (!valueToId.has(spec.optionValue)) {
        fail(
          `la opción "${OPTION_TITLE}" no tiene el valor "${spec.optionValue}" (tiene: ${optValRows.map((o) => o.value).join(", ")})`
        );
      }
    }

    // Los productos a retirar quedan con CERO variantes vivas después de mudar.
    for (const pid of RETIRE_PRODUCT_IDS) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM product_variant
          WHERE product_id = $1 AND deleted_at IS NULL AND sku <> ALL($2::text[])`,
        [pid, KEEP.map((k) => k.sku)]
      );
      if (rows[0].n !== "0") {
        fail(
          `el producto ${pid} conserva ${rows[0].n} variante(s) además de la que se muda — no se puede retirar`
        );
      }
    }

    // El handle destino tiene que estar libre (índice único parcial).
    const { rows: handleClash } = await client.query<{ id: string }>(
      `SELECT id FROM product WHERE handle = $1 AND deleted_at IS NULL AND id <> $2`,
      [PARENT_HANDLE, PARENT_PRODUCT_ID]
    );
    if (handleClash.length > 0) {
      fail(`el handle "${PARENT_HANDLE}" ya lo usa ${handleClash[0].id}`);
    }

    // ------------------------------------------------- HUELLA DE NO-REGRESIÓN
    // Se captura ANTES y se re-lee DESPUÉS dentro de la misma transacción. Si
    // el inventario, QuickBooks o los precios de las variantes conservadas se
    // movieron aunque sea un dígito, la transacción se revierte entera.
    const keepIds = KEEP.map((k) => bySku.get(k.sku)!.id);

    const inventoryFingerprint = async (): Promise<InventoryFingerprint[]> => {
      const { rows } = await client.query<InventoryFingerprint>(
        `SELECT v.sku,
                pvii.inventory_item_id,
                il.location_id,
                il.stocked_quantity::text  AS stocked_quantity,
                il.reserved_quantity::text AS reserved_quantity,
                il.incoming_quantity::text AS incoming_quantity
           FROM product_variant v
           JOIN product_variant_inventory_item pvii
             ON pvii.variant_id = v.id AND pvii.deleted_at IS NULL
           JOIN inventory_level il
             ON il.inventory_item_id = pvii.inventory_item_id AND il.deleted_at IS NULL
          WHERE v.id = ANY($1::text[])
          ORDER BY v.sku, il.location_id`,
        [keepIds]
      );
      return rows;
    };

    const moneyFingerprint = async (): Promise<string[]> => {
      const { rows } = await client.query<{ k: string }>(
        `SELECT v.sku || '|' || COALESCE(pz.price_list_id, 'base') || '|' ||
                pz.amount::text || '|' || pz.currency_code AS k
           FROM product_variant v
           JOIN product_variant_price_set pvps
             ON pvps.variant_id = v.id AND pvps.deleted_at IS NULL
           JOIN price pz
             ON pz.price_set_id = pvps.price_set_id AND pz.deleted_at IS NULL
          WHERE v.id = ANY($1::text[])
          ORDER BY 1`,
        [keepIds]
      );
      return rows.map((x) => x.k);
    };

    const qbFingerprint = async (): Promise<string[]> => {
      const { rows } = await client.query<{ k: string }>(
        `SELECT sku || '|' || COALESCE(metadata->>'quickbooks_id', '-') || '|' ||
                COALESCE(metadata->>'average_cost', '-') || '|' ||
                COALESCE(metadata->>'purchase_cost', '-') || '|' ||
                COALESCE(metadata->>'mpn', '-') AS k
           FROM product_variant WHERE id = ANY($1::text[]) ORDER BY 1`,
        [keepIds]
      );
      return rows.map((x) => x.k);
    };

    const invBefore = await inventoryFingerprint();
    const moneyBefore = await moneyFingerprint();
    const qbBefore = await qbFingerprint();

    // ------------------------------------------------------------- PREVIEW
    console.log("\n=== WRITE SET ===\n");
    console.log("product_variant — re-parent + opción + rank + merge de metadata:");
    for (const spec of KEEP) {
      const v = bySku.get(spec.sku)!;
      const move =
        spec.fromProductId === null
          ? "(ya en el padre)"
          : `${spec.fromProductId} → ${PARENT_PRODUCT_ID}`;
      console.log(
        `  ${spec.sku.padEnd(18)} ${v.id}  ${move}  title "${v.title}" → "${spec.optionValue}"  rank ${spec.rank}`
      );
    }
    console.log("\nproduct_variant — soft-delete de las cáscaras vacías:");
    for (const sku of DROP_SKUS) {
      console.log(`  ${sku.padEnd(18)} ${bySku.get(sku)!.id}`);
    }
    console.log("\nproduct:");
    console.log(
      `  ${PARENT_PRODUCT_ID}  title → "${PARENT_TITLE}"  handle → "${PARENT_HANDLE}"`
    );
    for (const pid of RETIRE_PRODUCT_IDS) {
      console.log(`  ${pid}  soft-delete (queda sin variantes)`);
    }
    console.log("\nHuella que NO se puede mover:");
    for (const f of invBefore) {
      console.log(
        `  inv  ${f.sku.padEnd(18)} ${f.inventory_item_id} @ ${f.location_id}  stocked=${f.stocked_quantity} reserved=${f.reserved_quantity} incoming=${f.incoming_quantity}`
      );
    }
    for (const k of moneyBefore) console.log(`  price ${k}`);
    for (const k of qbBefore) console.log(`  qb    ${k}`);

    if (!apply) {
      console.log("\n[DRY-RUN] nada escrito. APPLY=1 para ejecutar.\n");
      return;
    }

    // ---------------------------------------------------------------- APPLY
    await client.query("BEGIN");

    // 1) Las cáscaras -L1 salen primero: liberan sus links de opción y sus
    //    price sets. Sus SKU no se reusan, así que el índice único no importa,
    //    pero el soft-delete es lo que las saca del POS y del admin.
    await client.query(
      `DELETE FROM product_variant_option WHERE variant_id = ANY($1::text[])`,
      [dropIds]
    );
    await client.query(
      `UPDATE product_variant_price_set SET deleted_at = now(), updated_at = now()
        WHERE variant_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [dropIds]
    );
    await client.query(
      `UPDATE product_variant SET deleted_at = now(), updated_at = now()
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [dropIds]
    );

    // 2) Las variantes reales se mudan al padre y se enganchan a su valor de
    //    opción. El SKU, el metadata de QuickBooks, los precios, el inventory
    //    item y toda la historia viajan con la fila sin tocarse.
    for (const spec of KEEP) {
      const v = bySku.get(spec.sku)!;
      const optionValueId = valueToId.get(spec.optionValue)!;

      await client.query(
        `DELETE FROM product_variant_option WHERE variant_id = $1`,
        [v.id]
      );
      await client.query(
        `INSERT INTO product_variant_option (variant_id, option_value_id) VALUES ($1, $2)`,
        [v.id, optionValueId]
      );

      // jsonb || jsonb es merge shallow: agrega las claves del sistema de
      // atributos sin borrar quickbooks_id, average_cost, mpn ni ninguna otra.
      await client.query(
        `UPDATE product_variant
            SET product_id   = $2,
                title        = $3,
                variant_rank = $4,
                metadata     = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                updated_at   = now()
          WHERE id = $1`,
        [
          v.id,
          PARENT_PRODUCT_ID,
          spec.optionValue,
          spec.rank,
          JSON.stringify({
            managed_by: "attributes",
            variation: spec.variation,
          }),
        ]
      );
    }

    // 3) El padre toma el nombre de la familia.
    await client.query(
      `UPDATE product SET title = $2, handle = $3, updated_at = now() WHERE id = $1`,
      [PARENT_PRODUCT_ID, PARENT_TITLE, PARENT_HANDLE]
    );

    // 4) Los productos que quedaron vacíos se retiran, junto con su opción
    //    "Item"/Default —que ya no cuelga de ninguna variante— y su fila en los
    //    grupos de purchasing analysis, que si no queda huérfana.
    await client.query(
      `UPDATE product_option_value SET deleted_at = now(), updated_at = now()
        WHERE option_id IN (SELECT id FROM product_option WHERE product_id = ANY($1::text[]))
          AND deleted_at IS NULL`,
      [RETIRE_PRODUCT_IDS]
    );
    await client.query(
      `UPDATE product_option SET deleted_at = now(), updated_at = now()
        WHERE product_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [RETIRE_PRODUCT_IDS]
    );
    await client.query(
      `UPDATE purchasing_analysis_group_product SET deleted_at = now(), updated_at = now()
        WHERE product_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [RETIRE_PRODUCT_IDS]
    );
    await client.query(
      `UPDATE product SET deleted_at = now(), updated_at = now()
        WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [RETIRE_PRODUCT_IDS]
    );

    // ------------------------------------------- ASSERTS DENTRO DE LA TX
    // Lo que tiene que haber cambiado.
    const { rows: after } = await client.query<{
      sku: string;
      product_id: string;
      title: string;
      value: string;
    }>(
      `SELECT v.sku, v.product_id, v.title, ov.value
         FROM product_variant v
         LEFT JOIN product_variant_option pvo ON pvo.variant_id = v.id
         LEFT JOIN product_option_value ov ON ov.id = pvo.option_value_id
        WHERE v.product_id = $1 AND v.deleted_at IS NULL
        ORDER BY v.variant_rank`,
      [PARENT_PRODUCT_ID]
    );
    if (after.length !== 3) {
      throw new Error(
        `post: el padre quedó con ${after.length} variantes, esperaba 3`
      );
    }
    for (const spec of KEEP) {
      const row = after.find((a) => a.sku === spec.sku);
      if (!row) throw new Error(`post: ${spec.sku} no quedó bajo el padre`);
      if (row.value !== spec.optionValue) {
        throw new Error(
          `post: ${spec.sku} quedó con opción "${row.value}", esperaba "${spec.optionValue}"`
        );
      }
    }

    // Lo que NO tiene que haber cambiado. Estos son los asserts que valen:
    // si el enfoque de re-parenting estuviera mal, se ponen rojos acá y la
    // transacción se revierte sola.
    const invAfter = await inventoryFingerprint();
    const moneyAfter = await moneyFingerprint();
    const qbAfter = await qbFingerprint();

    const same = (a: unknown, b: unknown) =>
      JSON.stringify(a) === JSON.stringify(b);

    if (!same(invBefore, invAfter)) {
      throw new Error(
        `post: el inventario SE MOVIÓ.\nantes: ${JSON.stringify(invBefore)}\ndespués: ${JSON.stringify(invAfter)}`
      );
    }
    if (!same(moneyBefore, moneyAfter)) {
      throw new Error(
        `post: los precios SE MOVIERON.\nantes: ${JSON.stringify(moneyBefore)}\ndespués: ${JSON.stringify(moneyAfter)}`
      );
    }
    if (!same(qbBefore, qbAfter)) {
      throw new Error(
        `post: la identidad de QuickBooks / los costos SE MOVIERON.\nantes: ${JSON.stringify(qbBefore)}\ndespués: ${JSON.stringify(qbAfter)}`
      );
    }

    // Las líneas de orden, PO e invoice siguen resolviendo a una variante viva.
    const { rows: histRows } = await client.query<{
      order_lines: string;
      po_lines: string;
      invoice_lines: string;
    }>(
      `SELECT
         (SELECT count(*) FROM order_line_item     WHERE variant_id         = ANY($1::text[]))::text AS order_lines,
         (SELECT count(*) FROM purchase_order_line WHERE product_variant_id = ANY($1::text[]))::text AS po_lines,
         (SELECT count(*) FROM pos_invoice_item    WHERE variant_id         = ANY($1::text[]))::text AS invoice_lines`,
      [keepIds]
    );
    const h = histRows[0];
    console.log(
      `\npost: historia preservada → órdenes ${h.order_lines}, PO ${h.po_lines}, invoices ${h.invoice_lines}`
    );

    // El producto hermano sin `-L` no se tocó.
    const { rows: sib } = await client.query<{ n: string; title: string }>(
      `SELECT (SELECT count(*) FROM product_variant WHERE product_id = $1 AND deleted_at IS NULL)::text AS n,
              (SELECT title FROM product WHERE id = $1) AS title`,
      [SIBLING_PRODUCT_ID]
    );
    if (sib[0].n !== "3") {
      throw new Error(
        `post: el producto hermano ${SIBLING_PRODUCT_ID} quedó con ${sib[0].n} variantes, esperaba 3`
      );
    }
    console.log(
      `post: hermano intacto → ${SIBLING_PRODUCT_ID} "${sib[0].title}" con ${sib[0].n} variantes`
    );

    await client.query("COMMIT");
    console.log("\n[APPLY] COMMIT ok.\n");
    for (const a of after) {
      console.log(`  ${a.value.padEnd(6)} ${a.sku.padEnd(18)} ${a.product_id}`);
    }
    console.log(
      `\nFalta aparte: limpiar los docs de MeiliSearch de ${RETIRE_PRODUCT_IDS.join(", ")} y resyncear el padre.\n`
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
      console.error("[ROLLBACK] nada quedó aplicado.");
    } catch {
      // sin transacción abierta (falló el preflight) — no hay nada que revertir
    }
    throw err;
  } finally {
    client.release();
  }
}
