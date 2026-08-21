/**
 * copy-product-attributes.ts — copia los atributos de un producto a otro(s):
 * "este producto debe tener los mismos atributos que aquel". Herramienta del
 * llenado masivo del catálogo Linear Lighting (plan ll-attributes-foundation),
 * útil para cualquier producto de la tienda.
 *
 * Copia LINKS del pivote product_product_productattributes_attribute_value
 * (aditivo: el destino CONSERVA los atributos que ya tenía; sólo se agregan
 * los que le faltan). La PK del pivote es (product_id, attribute_value_id) y
 * un link soft-deleted la ocupa — se REVIVE (deleted_at=NULL) en vez de
 * insertar, siguiendo docs/PRODUCTS_ATTRIBUTES.md (soft-deletes = veneno).
 *
 * Uso (desde backend/ — DATABASE_URL EXPLÍCITO, no lee .env a propósito):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     FROM=ESP-ECA40W08 TO='ESPDO1R4N75W10,ESP-SFA50W0840' \
 *     ./node_modules/.bin/tsx src/scripts/fix/copy-product-attributes.ts
 *   FROM/TO aceptan SKU de variante o product id (prod_…/product_…).
 *   Agregar APPLY=true para ejecutar (dry-run por default).
 */
import { Pool } from 'pg';
import { ulid } from 'ulid';

interface ProductRef {
    id: string;
    title: string;
}

async function resolveProduct(pool: Pool, ref: string): Promise<ProductRef | null> {
    const trimmed = ref.trim();
    if (/^(prod_|product_)/.test(trimmed)) {
        const { rows } = await pool.query<ProductRef>(
            `SELECT id, title FROM product WHERE id = $1 AND deleted_at IS NULL`,
            [trimmed],
        );
        return rows[0] ?? null;
    }
    const { rows } = await pool.query<ProductRef>(
        `SELECT p.id, p.title
         FROM product p
         JOIN product_variant v ON v.product_id = p.id AND v.deleted_at IS NULL
         WHERE UPPER(v.sku) = UPPER($1) AND p.deleted_at IS NULL
         LIMIT 1`,
        [trimmed],
    );
    return rows[0] ?? null;
}

interface AttrLink {
    attribute_value_id: string;
    value: string;
    key_handle: string;
}

async function liveLinks(pool: Pool, productId: string): Promise<AttrLink[]> {
    const { rows } = await pool.query<AttrLink>(
        `SELECT pav.attribute_value_id, av.value, ak.handle AS key_handle
         FROM product_product_productattributes_attribute_value pav
         JOIN attribute_value av ON av.id = pav.attribute_value_id AND av.deleted_at IS NULL
         JOIN attribute_key ak ON ak.id = av.attribute_key_id AND ak.deleted_at IS NULL
         WHERE pav.product_id = $1 AND pav.deleted_at IS NULL
         ORDER BY ak.handle, av.value`,
        [productId],
    );
    return rows;
}

async function main() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL es obligatorio y explícito (este script NO lee .env). ' +
                'Sandbox: postgresql://postgres:sandbox@localhost:5499/medusa',
        );
    }
    const from = process.env.FROM ?? '';
    const toList = (process.env.TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const apply = process.env.APPLY === 'true';
    if (!from || toList.length === 0) {
        throw new Error("Uso: FROM=<sku|product_id> TO='<sku|id>[,<sku|id>…]' [APPLY=true]");
    }
    const host = new URL(dbUrl).host;
    console.log(`Target DB: ${host}  ·  mode: ${apply ? '⚠️  APPLY' : 'dry-run'}`);

    const pool = new Pool({ connectionString: dbUrl });
    try {
        const source = await resolveProduct(pool, from);
        if (!source) throw new Error(`FROM "${from}" no resuelve a ningún producto en ${host}`);
        const sourceLinks = await liveLinks(pool, source.id);
        console.log(`\nFuente: ${source.title} (${source.id}) — ${sourceLinks.length} atributos`);
        for (const l of sourceLinks) console.log(`    ${l.key_handle}: ${l.value}`);
        if (sourceLinks.length === 0) throw new Error('La fuente no tiene atributos — nada que copiar');

        for (const ref of toList) {
            const target = await resolveProduct(pool, ref);
            if (!target) {
                console.log(`\n✗ "${ref}" no resuelve a ningún producto — salteado`);
                continue;
            }
            if (target.id === source.id) {
                console.log(`\n✗ "${ref}" es el mismo producto fuente — salteado`);
                continue;
            }
            const existing = new Set((await liveLinks(pool, target.id)).map((l) => l.attribute_value_id));
            const missing = sourceLinks.filter((l) => !existing.has(l.attribute_value_id));
            console.log(
                `\nDestino: ${target.title} (${target.id}) — tiene ${existing.size}, copia ${missing.length}:`,
            );
            for (const link of missing) {
                console.log(`  + ${link.key_handle}: ${link.value}`);
                if (!apply) continue;
                // La PK (product_id, attribute_value_id) puede estar ocupada por
                // un link soft-deleted (invisible arriba) → revivir, no insertar.
                const revived = await pool.query(
                    `UPDATE product_product_productattributes_attribute_value
                     SET deleted_at = NULL, updated_at = NOW()
                     WHERE product_id = $1 AND attribute_value_id = $2 AND deleted_at IS NOT NULL`,
                    [target.id, link.attribute_value_id],
                );
                if ((revived.rowCount ?? 0) === 0) {
                    await pool.query(
                        `INSERT INTO product_product_productattributes_attribute_value
                             (id, product_id, attribute_value_id)
                         VALUES ($1, $2, $3)`,
                        [`link_${ulid()}`, target.id, link.attribute_value_id],
                    );
                }
            }
        }

        if (!apply) console.log('\nDry-run — nada escrito. Agregar APPLY=true para ejecutar.');
        else console.log('\n✅ Aplicado.');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('COPY FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
