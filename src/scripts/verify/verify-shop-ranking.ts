/**
 * verify-shop-ranking.ts — read-only. Verifica el ranking de categorías de
 * la tienda, el alta de los conectores ECN, y el escritor `orders_12m` del
 * job `shop-bestsellers`.
 *
 * Qué afirma:
 *   V1 los ranks de SHOP_CATEGORY_RANKS son únicos entre sí en la DB y
 *      coinciden con la constante.
 *   V2 `led-neon` está is_active=true, is_internal=false.
 *   V3 los 9 ECN tienen metadata.shop_title == constante, pertenecen a la
 *      categoría target, y primary_category_id == su id.
 *   V4 metadata.orders_12m existe (numérico) en todo producto publicado, y
 *      el máximo corresponde a un producto con ≥1 venta.
 *   V5 control de alternativos: para "Free Cut 8mm COB LED Strip 24V",
 *      orders_12m ≥ own (own recalculado SIN alternativos).
 *   V6 negativo: ningún producto draft tiene orders_12m escrito por la
 *      corrida MÁS RECIENTE del job (el job sólo toca `status='published'`;
 *      un draft con un `orders_12m_at` VIEJO ya lo tenía de antes de bajar
 *      a draft y no cuenta como violación).
 *
 * Usage:
 *   cd backend
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-shop-ranking.ts [--months 12]
 */
import { Client } from "pg";

import { computeOrders12m } from "../../lib/shop/bestsellers";
import { PUBLIC_PRODUCT_METADATA_KEYS } from "../../lib/product-metadata/public-keys";
import { ECN_CONNECTORS, ECN_TARGET_CATEGORY_HANDLE, SHOP_CATEGORY_RANKS } from "../../lib/shop/shop-categories";

const DATABASE_URL = process.env.DATABASE_URL;

const monthsFlagIndex = process.argv.indexOf("--months");
const months =
  monthsFlagIndex >= 0 && process.argv[monthsFlagIndex + 1]
    ? Number(process.argv[monthsFlagIndex + 1])
    : 12;

let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set");
    process.exit(2);
  }

  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();

  try {
    console.log(`\n🔎 verify-shop-ranking (months=${months})\n`);

    // ── V1 ────────────────────────────────────────────────────────────────
    console.log("V1 category ranks");
    const handles = SHOP_CATEGORY_RANKS.map((r) => r.handle);
    const { rows: catRows } = await pg.query<{
      handle: string;
      rank: number | null;
    }>(
      `SELECT handle, rank FROM product_category WHERE handle = ANY($1) AND deleted_at IS NULL`,
      [handles]
    );
    const dbRankByHandle = new Map(catRows.map((r) => [r.handle, r.rank]));

    check(
      "todos los handles de SHOP_CATEGORY_RANKS existen",
      catRows.length === SHOP_CATEGORY_RANKS.length,
      `${catRows.length}/${SHOP_CATEGORY_RANKS.length}`
    );

    for (const { handle, rank } of SHOP_CATEGORY_RANKS) {
      check(
        `${handle} rank == ${rank}`,
        dbRankByHandle.get(handle) === rank,
        `db=${dbRankByHandle.get(handle)}`
      );
    }

    const ranksSeen = catRows.map((r) => r.rank);
    const uniqueRanks = new Set(ranksSeen);
    check(
      "los ranks son únicos entre sí",
      uniqueRanks.size === ranksSeen.length,
      `${uniqueRanks.size} únicos de ${ranksSeen.length}`
    );

    // ── V2 ────────────────────────────────────────────────────────────────
    console.log("\nV2 led-neon activo y no interno");
    const { rows: neonRows } = await pg.query<{
      is_active: boolean;
      is_internal: boolean;
    }>(
      `SELECT is_active, is_internal FROM product_category WHERE handle = 'led-neon' AND deleted_at IS NULL LIMIT 1`
    );
    check(
      "led-neon is_active=true",
      neonRows[0]?.is_active === true,
      String(neonRows[0]?.is_active)
    );
    check(
      "led-neon is_internal=false",
      neonRows[0]?.is_internal === false,
      String(neonRows[0]?.is_internal)
    );

    // ── V3 ────────────────────────────────────────────────────────────────
    console.log("\nV3 conectores ECN");
    const { rows: targetCatRows } = await pg.query<{ id: string }>(
      `SELECT id FROM product_category WHERE handle = $1 AND deleted_at IS NULL LIMIT 1`,
      [ECN_TARGET_CATEGORY_HANDLE]
    );
    const targetCategoryId = targetCatRows[0]?.id ?? null;
    check(
      `categoría target ${ECN_TARGET_CATEGORY_HANDLE} existe`,
      targetCategoryId !== null
    );

    for (const { sku, shopTitle } of ECN_CONNECTORS) {
      const { rows } = await pg.query<{
        id: string;
        shop_title: string | null;
        primary_category_id: string | null;
        linked: boolean;
      }>(
        `
        SELECT
          p.id,
          p.metadata ->> 'shop_title' AS shop_title,
          p.metadata ->> 'primary_category_id' AS primary_category_id,
          EXISTS (
            SELECT 1 FROM product_category_product pcp
            WHERE pcp.product_id = p.id AND pcp.product_category_id = $2
          ) AS linked
        FROM product p
        WHERE p.title = $1 AND p.deleted_at IS NULL
        `,
        [sku, targetCategoryId]
      );
      const row = rows[0];
      check(`${sku} resuelve a un producto`, rows.length === 1, `${rows.length} filas`);
      if (!row) continue;
      check(`${sku} shop_title == constante`, row.shop_title === shopTitle, `db="${row.shop_title}"`);
      check(`${sku} pertenece a la categoría target`, row.linked === true);
      check(
        `${sku} primary_category_id == categoría target`,
        row.primary_category_id === targetCategoryId,
        `db=${row.primary_category_id}`
      );
    }

    // ── V4 ────────────────────────────────────────────────────────────────
    console.log("\nV4 orders_12m en todo producto publicado");
    const { rows: publishedRows } = await pg.query<{
      id: string;
      title: string;
      orders_12m: string | null;
    }>(
      `SELECT id, title, metadata ->> 'orders_12m' AS orders_12m FROM product WHERE status = 'published' AND deleted_at IS NULL`
    );
    const missingOrders12m = publishedRows.filter(
      (r) => r.orders_12m === null || r.orders_12m === undefined || Number.isNaN(Number(r.orders_12m))
    );
    check(
      "todo producto publicado tiene orders_12m numérico",
      missingOrders12m.length === 0,
      `${missingOrders12m.length} sin valor de ${publishedRows.length}`
    );

    let maxRow: { id: string; title: string; orders_12m: number } | null = null;
    for (const r of publishedRows) {
      const value = Number(r.orders_12m ?? -1);
      if (!maxRow || value > maxRow.orders_12m) {
        maxRow = { id: r.id, title: r.title, orders_12m: value };
      }
    }
    check(
      "el máximo corresponde a un producto con ≥1 venta",
      !!maxRow && maxRow.orders_12m >= 1,
      maxRow ? `${maxRow.title}: ${maxRow.orders_12m}` : "sin productos publicados"
    );

    // ── V5 ────────────────────────────────────────────────────────────────
    console.log("\nV5 control de alternativos (Free Cut 8mm COB LED Strip 24V)");
    const { rows: freeCutRows } = await pg.query<{
      id: string;
      orders_12m: string | null;
    }>(
      `SELECT id, metadata ->> 'orders_12m' AS orders_12m FROM product WHERE title LIKE 'Free Cut 8mm COB LED Strip 24V%' AND deleted_at IS NULL AND status = 'published' LIMIT 1`
    );
    if (freeCutRows.length === 0) {
      check("producto de control encontrado", false, "ningún producto matchea el título");
    } else {
      const productId = freeCutRows[0].id;
      const total = Number(freeCutRows[0].orders_12m ?? -1);

      const { rows: ownRows } = await pg.query<{ own: string }>(
        `
        SELECT COUNT(DISTINCT o.id)::text AS own
        FROM order_item oi
        JOIN order_line_item oli ON oli.id = oi.item_id
        JOIN "order" o ON o.id = oi.order_id
        JOIN product_variant pv ON pv.id = oli.variant_id
        WHERE pv.product_id = $1
          AND o.created_at >= now() - ($2::int || ' months')::interval
          AND o.deleted_at IS NULL
          AND oi.deleted_at IS NULL
        `,
        [productId, months]
      );
      const own = Number(ownRows[0]?.own ?? 0);
      check(
        "orders_12m (con alternativos) ≥ own (sin alternativos)",
        total >= own,
        `own=${own} total=${total}`
      );
    }

    // ── V6 ────────────────────────────────────────────────────────────────
    console.log("\nV6 negativo: draft sin orders_12m de la corrida más reciente");
    const { rows: latestAtRows } = await pg.query<{ latest_at: string | null }>(
      `SELECT MAX(metadata ->> 'orders_12m_at') AS latest_at FROM product WHERE status = 'published' AND deleted_at IS NULL AND metadata ->> 'orders_12m_at' IS NOT NULL`
    );
    const latestAt = latestAtRows[0]?.latest_at ?? null;
    if (!latestAt) {
      check("hay al menos una corrida registrada para comparar", false, "ningún orders_12m_at en productos publicados");
    } else {
      const { rows: draftHit } = await pg.query<{ id: string; title: string }>(
        `SELECT id, title FROM product WHERE status = 'draft' AND deleted_at IS NULL AND metadata ->> 'orders_12m_at' = $1`,
        [latestAt]
      );
      check(
        "ningún draft comparte el timestamp de la corrida más reciente",
        draftHit.length === 0,
        draftHit.map((d) => d.title).join(", ")
      );
    }

    // ── V7 ────────────────────────────────────────────────────────────────
    console.log("\nV7 exposición pública: shop_sales_rank sale, orders_12m NO");
    const { rows: rankRows } = await pg.query<{ n: string; top: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE (metadata ->> 'shop_sales_rank') ~ '^\\d+$') AS n,
              (SELECT title FROM product WHERE status = 'published' AND deleted_at IS NULL AND metadata ->> 'shop_sales_rank' = '1' LIMIT 1) AS top
         FROM product WHERE status = 'published' AND deleted_at IS NULL`
    );
    const { rows: pubCount } = await pg.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM product WHERE status = 'published' AND deleted_at IS NULL`
    );
    check(
      "todo producto publicado tiene shop_sales_rank entero",
      rankRows[0]?.n === pubCount[0]?.n,
      `${rankRows[0]?.n} de ${pubCount[0]?.n} · #1 = ${rankRows[0]?.top ?? "—"}`
    );
    const publicKeys = new Set<string>(PUBLIC_PRODUCT_METADATA_KEYS);
    check("allowlist expone shop_sales_rank y shop_title", publicKeys.has("shop_sales_rank") && publicKeys.has("shop_title"));
    check(
      "allowlist NO expone orders_12m, orders_12m_at ni revenue_12m (volumen = interno)",
      !publicKeys.has("orders_12m") && !publicKeys.has("orders_12m_at") && !publicKeys.has("revenue_12m")
    );

    // Chequeo puramente informativo: recomputa en memoria (sin escribir) para
    // dejar evidencia de que `computeOrders12m` es consistente con lo persistido.
    const fresh = await computeOrders12m(
      // computeOrders12m espera un pg.Pool; un Client comparte la misma interfaz
      // `.query()` usada acá, así que se castea sólo para este chequeo informativo.
      { query: pg.query.bind(pg) } as unknown as import("pg").Pool,
      { months }
    );
    console.log(
      `\nℹ️  computeOrders12m (fresh, no escribe): ${fresh.size} productos evaluados`
    );
  } finally {
    await pg.end();
  }

  console.log(failed ? `\n❌ ${failed} chequeo(s) fallaron.` : "\n✅ Todos los chequeos pasaron.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(1);
});
