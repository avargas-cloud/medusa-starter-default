/**
 * Qué claves de `product.metadata` pueden salir por el Store API.
 *
 * ## Por qué existe
 *
 * Las rutas de `/store/products*` pedían `"metadata"` a `query.graph` y
 * devolvían el producto entero. Medido contra la base de PRODUCCIÓN el
 * 2026-09-05, eso publicaba:
 *
 *     qb_income_account_full_name   2.225 productos
 *     qb_cogs_account_full_name     2.224
 *     vendor_full_name              2.222
 *     vendor_list_id                2.219
 *
 * O sea: de qué proveedor sale cada SKU y su mapeo de cuentas contables, a
 * disposición de cualquiera con la `x-publishable-api-key` — que es pública por
 * diseño, viaja en el bundle del storefront.
 *
 * ## Por qué ALLOWLIST y no denylist
 *
 * Una denylist protege lo que alguien se acordó de enumerar. Esta metadata la
 * escriben el POS, el pipeline de QuickBooks, el sync de China y los dos
 * proyectos de iluminación; la próxima clave interna la va a agregar alguien
 * que no está leyendo este archivo. Con allowlist, esa clave sale del lado
 * seguro sin que nadie haga nada — que es la única propiedad que sobrevive al
 * paso del tiempo.
 *
 * Agregar una clave acá es una decisión deliberada: preguntate si te molestaría
 * verla en un scrape del catálogo.
 *
 * ## Cómo se armó la lista
 *
 * Barriendo los lectores reales de `product.metadata` en `web/` (el ÚNICO
 * consumidor de `/store/products*`; Backlighting y Linear Lighting sincronizan
 * por rutas admin con su propia API key). Los seis primeros salen de ese
 * barrido; los últimos son campos de presentación del mismo grupo, sin valor
 * para un competidor.
 */

/** Claves de `product.metadata` que el storefront puede ver. */
export const PUBLIC_PRODUCT_METADATA_KEYS = [
  // Leídos hoy por web/ — cada uno con su callsite:
  "short_description", // components/product/ProductInfo.tsx
  "long_description", // layouts/MedusaProductLayout.astro
  "sku", // components/product/ProductInfo.tsx
  "related_products", // pages/product/[handle].astro
  "main_category_breadcrumbs", // pages/product/[handle].astro
  "prerender", // lib/medusa/product/product-static.ts
  // Presentación del catálogo, sin valor competitivo:
  "primary_category_id",
  "variant_attributes",
  "is_service",
  "shipping_type",
] as const;

const PUBLIC_KEY_SET: ReadonlySet<string> = new Set(
  PUBLIC_PRODUCT_METADATA_KEYS
);

/**
 * Devuelve sólo las claves publicables de un `metadata` de producto.
 *
 * `null` entra y sale `null`: el storefront distingue "sin metadata" de "objeto
 * vacío" en un par de lugares, así que no se normaliza a `{}`.
 */
export function pickPublicProductMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (PUBLIC_KEY_SET.has(key)) out[key] = metadata[key];
  }
  return out;
}

/**
 * Qué claves de `product_variant.metadata` pueden salir por el Store API.
 *
 * ## VACÍA, y es una decisión medida
 *
 * La metadata de VARIANTE es peor que la de producto. Medido en producción el
 * 2026-09-05:
 *
 *     average_cost      2.517 variantes   ← el COGS real por SKU
 *     purchase_cost     2.537             ← costo de fábrica
 *     qb_avg_cost       2.495
 *     vendor_list_id    2.490
 *
 * Y `/store/products*` pide `variants.*`, que expande metadata: confirmado
 * contra el sandbox, la respuesta pública traía 14 claves sensibles por
 * variante. O sea que filtrar sólo `product.metadata` cerraba la mitad menos
 * grave del agujero.
 *
 * Está vacía porque se contó: `web/` —el ÚNICO consumidor de estas rutas— no
 * lee NI UNA clave de metadata de variante (barrido de `variant.metadata`,
 * `selectedVariant.metadata` y `v.metadata` sobre todo `web/src`). Backlighting
 * y Linear Lighting sí leen `variant_metadata`, pero por rutas `/admin/*` con
 * su propia API key, que este filtro no toca.
 *
 * Si algún día el storefront necesita una, se agrega acá con su callsite. La
 * lista existe justamente para que agregarla sea una decisión y no un descuido.
 */
export const PUBLIC_VARIANT_METADATA_KEYS: readonly string[] = [];

const PUBLIC_VARIANT_KEY_SET: ReadonlySet<string> = new Set(
  PUBLIC_VARIANT_METADATA_KEYS
);

/** Igual que `pickPublicProductMetadata`, para variantes. */
export function pickPublicVariantMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    if (PUBLIC_VARIANT_KEY_SET.has(key)) out[key] = metadata[key];
  }
  return out;
}

/** Filtra la metadata de una variante ya proyectada, sin mutarla. */
export function withPublicVariantMetadata<T extends { metadata?: unknown }>(
  variant: T
): T {
  return {
    ...variant,
    metadata: pickPublicVariantMetadata(
      variant.metadata as Record<string, unknown> | null | undefined
    ),
  };
}

/**
 * Aplica el filtro a un producto SIN mutarlo: devuelve una copia nueva, con sus
 * VARIANTES también filtradas.
 *
 * Las variantes van adentro a propósito. Cuando esto filtraba sólo el nivel de
 * producto, las cuatro rutas seguían publicando el costo por SKU vía
 * `variants.*` y el verificador daba verde — el filtro estaba puesto en el
 * lugar que se había mirado, no en todos los que exponen. Un helper que cubre
 * un solo nivel invita exactamente a ese error.
 *
 * Trabaja sobre el objeto de respuesta y no sobre el `fields` de `query.graph`
 * a propósito. Sacar `"metadata"` del `fields` también funcionaría, pero deja
 * el filtro repartido en cuatro rutas y a merced de que la próxima lo copie
 * bien; acá el punto de salida es uno solo y es el que se puede verificar.
 */
export function withPublicProductMetadata<
  T extends { metadata?: unknown; variants?: unknown },
>(product: T): T {
  const variants = Array.isArray(product.variants)
    ? (product.variants as Array<{ metadata?: unknown }>).map(
        withPublicVariantMetadata
      )
    : product.variants;

  return {
    ...product,
    metadata: pickPublicProductMetadata(
      product.metadata as Record<string, unknown> | null | undefined
    ),
    ...(product.variants === undefined ? {} : { variants }),
  };
}
