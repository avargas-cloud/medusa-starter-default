/**
 * Publica en Medusa los productos que los catálogos ACTIVOS de Backlighting y
 * Linear Lighting usan, y los suma al sales channel de la web.
 *
 * Por qué: `POST /store/carts/:id/sync-bom` (Add to Cart desde las apps
 * embebidas) resuelve un SKU SÓLO contra variantes de productos `published`
 * del sales channel del carrito — decisión del operador 2026-09-11: el filtro
 * se queda y lo que se publica son los componentes que las apps cotizan. Sin
 * esto, "Add to Cart" devuelve esas líneas como `unresolved` (lo que se vio
 * con EMSH4V160D30WRW3 y ECNA-LENU-3TO3).
 *
 * Qué hace (idempotente; una segunda corrida planea 0/0):
 *   1. SKUs = todos los ítems con `sku` de los arrays del snapshot activo de
 *      `bl_catalog_snapshot` + `products[].variants[].sku` del activo de
 *      `lld_catalog_snapshot` (las tablas de las apps viven en la misma Postgres).
 *   2. Los resuelve a productos por `product_variant.sku`.
 *   3. Plan: productos en `draft` → `published` (sólo draft: un `proposed` o
 *      `rejected` es una decisión del catálogo y se REPORTA, no se pisa), y
 *      productos sin fila viva en `product_sales_channel` para el canal → link.
 *   4. Con APPLY=true escribe por los workflows nativos (`updateProductsWorkflow`
 *      + `linkProductsToSalesChannelWorkflow`): emiten `product.updated`, así
 *      Meili y los links se mantienen por los caminos de siempre. Después
 *      RE-LEE y afirma que el plan quedó en 0/0.
 *
 * Canal: `SALES_CHANNEL_ID` si viene; si no, el ÚNICO canal vinculado a una
 * publishable key viva (la de la web). Dos o ninguno = se detiene y lista.
 *
 * Dry-run por defecto. Aplicar:
 *   sandbox:  APPLY=true
 *   prod:     APPLY=true CONFIRM_PROD=<host de DATABASE_URL>   (cardinalidad en el dry-run)
 *
 * Correr (env explícito SIEMPRE — el shell puede filtrar una DATABASE_URL ajena):
 *   env DATABASE_URL=… ./node_modules/.bin/medusa exec ./src/scripts/fix/publish-app-catalog-products.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  linkProductsToSalesChannelWorkflow,
  updateProductsWorkflow,
} from "@medusajs/core-flows";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

interface ResolvedProduct {
  product_id: string;
  title: string;
  status: string;
  skus: string[];
  linked: boolean;
}

const BATCH = 50;

function dbHost(): string {
  const url = process.env.DATABASE_URL ?? "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function appSkus(knex: Knex): Promise<{ bl: string[]; ll: string[] }> {
  const bl = await knex.raw(
    `SELECT DISTINCT it->>'sku' AS sku
       FROM bl_catalog_snapshot s,
            jsonb_each(s.catalog) cat,
            jsonb_array_elements(cat.value) it
      WHERE s.is_active
        AND jsonb_typeof(cat.value) = 'array'
        AND jsonb_typeof(it) = 'object'
        AND COALESCE(it->>'sku', '') <> ''`,
  );
  const ll = await knex.raw(
    `SELECT DISTINCT v->>'sku' AS sku
       FROM lld_catalog_snapshot s,
            jsonb_array_elements(s.catalog->'products') p,
            jsonb_array_elements(COALESCE(p->'variants', '[]'::jsonb)) v
      WHERE s.is_active
        AND COALESCE(v->>'sku', '') <> ''`,
  );
  return {
    bl: bl.rows.map((r) => String(r.sku)),
    ll: ll.rows.map((r) => String(r.sku)),
  };
}

async function resolveChannel(knex: Knex): Promise<{ id: string; name: string }> {
  const forced = process.env.SALES_CHANNEL_ID?.trim();
  if (forced) {
    const r = await knex.raw(
      `SELECT id, name FROM sales_channel WHERE id = ? AND deleted_at IS NULL`,
      [forced],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`SALES_CHANNEL_ID ${forced} no existe o está borrado`);
    return { id: String(row.id), name: String(row.name) };
  }
  const r = await knex.raw(
    `SELECT DISTINCT sc.id, sc.name
       FROM publishable_api_key_sales_channel l
       JOIN api_key k ON k.id = l.publishable_key_id
       JOIN sales_channel sc ON sc.id = l.sales_channel_id
      WHERE l.deleted_at IS NULL
        AND k.type = 'publishable' AND k.revoked_at IS NULL AND k.deleted_at IS NULL
        AND sc.deleted_at IS NULL
      ORDER BY sc.name`,
  );
  const only = r.rows.length === 1 ? r.rows[0] : undefined;
  if (!only) {
    const list = r.rows.map((x) => `${x.id} (${x.name})`).join(", ") || "ninguno";
    throw new Error(
      `Se esperaba UN sales channel vinculado a una publishable key viva y hay ${r.rows.length}: ${list}. Pasá SALES_CHANNEL_ID.`,
    );
  }
  return { id: String(only.id), name: String(only.name) };
}

async function resolveProducts(
  knex: Knex,
  skus: string[],
  channelId: string,
): Promise<{ products: ResolvedProduct[]; unresolved: string[] }> {
  if (skus.length === 0) return { products: [], unresolved: [] };
  const r = await knex.raw(
    `SELECT pv.sku, p.id AS product_id, p.title, p.status,
            EXISTS (
              SELECT 1 FROM product_sales_channel psc
               WHERE psc.product_id = p.id AND psc.sales_channel_id = ?
                 AND psc.deleted_at IS NULL
            ) AS linked
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id
      WHERE pv.sku = ANY(?::text[])
        AND pv.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [channelId, skus],
  );
  const byProduct = new Map<string, ResolvedProduct>();
  const seen = new Set<string>();
  for (const row of r.rows) {
    const sku = String(row.sku);
    seen.add(sku);
    const id = String(row.product_id);
    const entry = byProduct.get(id) ?? {
      product_id: id,
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      skus: [],
      linked: Boolean(row.linked),
    };
    entry.skus.push(sku);
    byProduct.set(id, entry);
  }
  const unresolved = skus.filter((s) => !seen.has(s)).sort();
  return { products: [...byProduct.values()], unresolved };
}

function plan(products: ResolvedProduct[]): {
  toPublish: ResolvedProduct[];
  toLink: ResolvedProduct[];
  otherStatus: ResolvedProduct[];
} {
  return {
    toPublish: products.filter((p) => p.status === "draft"),
    toLink: products.filter((p) => !p.linked),
    otherStatus: products.filter((p) => p.status !== "draft" && p.status !== "published"),
  };
}

const show = (items: ResolvedProduct[], max = 80): string =>
  items
    .slice(0, max)
    .map((p) => `    - ${p.skus.join(", ")} · ${p.title} [${p.status}]`)
    .join("\n") + (items.length > max ? `\n    … y ${items.length - max} más` : "");

export default async function publishAppCatalogProducts({ container }: ExecArgs): Promise<void> {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Knex;
  const apply = process.env.APPLY === "true";
  const host = dbHost();
  console.log(`[publish-app-catalog] DB host: ${host || "(desconocido)"} · modo: ${apply ? "APPLY" : "DRY-RUN"}`);

  const channel = await resolveChannel(knex);
  console.log(`[publish-app-catalog] sales channel: ${channel.name} (${channel.id})`);

  const { bl, ll } = await appSkus(knex);
  const skus = [...new Set([...bl, ...ll])].sort();
  console.log(`[publish-app-catalog] SKUs en catálogos activos: BL ${bl.length} · LL ${ll.length} · únicos ${skus.length}`);

  const { products, unresolved } = await resolveProducts(knex, skus, channel.id);
  const p = plan(products);
  console.log(`[publish-app-catalog] productos resueltos: ${products.length} · sin variante en Medusa: ${unresolved.length}`);
  if (unresolved.length) console.log(`  SKUs sin producto (se ignoran):\n    ${unresolved.join(", ")}`);
  if (p.otherStatus.length) console.log(`  en estado que NO se toca (proposed/rejected):\n${show(p.otherStatus)}`);
  console.log(`\nPLAN\n  draft → published: ${p.toPublish.length}\n${show(p.toPublish)}\n  sin canal → link ${channel.name}: ${p.toLink.length}\n${show(p.toLink)}\n`);

  if (!apply) {
    console.log("[publish-app-catalog] DRY-RUN: nada escrito. Aplicar con APPLY=true (prod además CONFIRM_PROD=<host>).");
    return;
  }
  if (!isLocalHost(host)) {
    const confirm = process.env.CONFIRM_PROD?.trim();
    if (!confirm || confirm !== host) {
      throw new Error(
        `Destino NO local (${host}): hace falta CONFIRM_PROD=${host} exacto para escribir. Nada escrito.`,
      );
    }
  }
  if (p.toPublish.length === 0 && p.toLink.length === 0) {
    console.log("[publish-app-catalog] plan vacío: nada que aplicar.");
    return;
  }

  for (let i = 0; i < p.toPublish.length; i += BATCH) {
    const ids = p.toPublish.slice(i, i + BATCH).map((x) => x.product_id);
    await updateProductsWorkflow(container).run({
      input: { selector: { id: ids }, update: { status: "published" } },
    });
    console.log(`[publish-app-catalog] published ${Math.min(i + BATCH, p.toPublish.length)}/${p.toPublish.length}`);
  }
  if (p.toLink.length) {
    await linkProductsToSalesChannelWorkflow(container).run({
      input: { id: channel.id, add: p.toLink.map((x) => x.product_id) },
    });
    console.log(`[publish-app-catalog] linked ${p.toLink.length} al canal ${channel.name}`);
  }

  // Verificación por RE-LECTURA: el plan tiene que quedar vacío.
  const after = plan((await resolveProducts(knex, skus, channel.id)).products);
  const left = after.toPublish.length + after.toLink.length;
  console.log(`[publish-app-catalog] post-check: draft restantes ${after.toPublish.length} · sin canal ${after.toLink.length}`);
  if (left !== 0) throw new Error(`post-check falló: quedaron ${left} pendientes`);
  console.log("[publish-app-catalog] OK");
}
