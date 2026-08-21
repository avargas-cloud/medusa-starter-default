/**
 * normalize-measurement-values.ts — sanea los values de medición (length,
 * width, height) del catálogo de Atributos (pedido user 2026-08-21):
 *
 *   - unidades ABREVIADAS con espacio: 94.5" → 94.5 in · 10' → 10 ft ·
 *     6ft → 6 ft · 8.5mm → 8.5 mm · 100 feet → 100 ft · 30 Meters → 30 m
 *   - coma decimal → punto: 0,5" → 0.5 in · 13,25 → 13.25
 *   - fracciones y sufijos se CONSERVAN: 1-13/16" → 1-13/16 in ·
 *     6/32" (module) → 6/32 in (module)
 *   - números pelados sin unidad ("17", "1,5") sólo arreglan la coma —
 *     jamás se inventa una unidad; quedan flagueados en el reporte.
 *
 * SIN romper links: los values se UPDATEAN in place (mismo id). Cuando dos
 * values del mismo key colapsan al mismo texto ("0,5\"" y "0.5\"" → "0.5 in")
 * se FUSIONAN: los links del duplicado se repuntan al superviviente (el de
 * más links; si el producto ya tenía al superviviente, el link sobrante se
 * borra) y recién entonces se elimina el value vacío — el orden que exige
 * la PK (product_id, attribute_value_id). Todo en UNA transacción.
 *
 * Uso (DATABASE_URL EXPLÍCITO — no lee .env a propósito):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/fix/normalize-measurement-values.ts
 *   Agregar APPLY=true para ejecutar (dry-run por default).
 */
import { Pool, PoolClient } from 'pg';

const KEYS = ['length', 'width', 'height'];

export function normalizeMeasurement(raw: string): string {
    let s = raw.trim().replace(/\s+/g, ' ');
    // Coma decimal entre dígitos → punto (0,5 → 0.5 · 13,25 → 13.25).
    s = s.replace(/(\d),(\d)/g, '$1.$2');
    // Pulgadas: " · '' · ´´ · ″ pegadas al número/fracción → " in".
    s = s.replace(/(?<=[\d\s)/])\s*(?:"|''|´´|″)/g, ' in');
    // Pies: ' · ′ → " ft".
    s = s.replace(/(?<=[\d\s)/])\s*(?:'|′)/g, ' ft');
    // Palabras completas → abreviatura.
    s = s.replace(/\b(?:feet|foot)\b/gi, 'ft');
    s = s.replace(/\b(?:inches|inch)\b/gi, 'in');
    s = s.replace(/\b(?:meters|meter|metres|metre)\b/gi, 'm');
    // Unidad pegada al número → espacio (mm antes que m; cm antes que m).
    s = s.replace(/(\d)(mm|cm|ft|in)\b/g, '$1 $2');
    s = s.replace(/(\d)m\b/g, '$1 m');
    return s.replace(/\s+/g, ' ').trim();
}

interface ValueRow {
    id: string;
    value: string;
    key_id: string;
    handle: string;
    links: number;
}

async function main() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL es obligatorio y explícito (este script NO lee .env). ' +
                'Sandbox: postgresql://postgres:sandbox@localhost:5499/medusa',
        );
    }
    const apply = process.env.APPLY === 'true';
    const host = new URL(dbUrl).host;
    console.log(`Target DB: ${host}  ·  mode: ${apply ? '⚠️  APPLY' : 'dry-run'}  ·  keys: ${KEYS.join(', ')}`);

    const pool = new Pool({ connectionString: dbUrl });
    const client: PoolClient = await pool.connect();
    try {
        const { rows } = await client.query<ValueRow>(
            `SELECT av.id, av.value, ak.id AS key_id, ak.handle,
                    (SELECT count(*) FROM product_product_productattributes_attribute_value pav
                     WHERE pav.attribute_value_id = av.id AND pav.deleted_at IS NULL)::int AS links
             FROM attribute_value av
             JOIN attribute_key ak ON ak.id = av.attribute_key_id AND ak.deleted_at IS NULL
             WHERE ak.handle = ANY($1) AND av.deleted_at IS NULL
             ORDER BY ak.handle, av.value`,
            [KEYS],
        );

        // Plan: normalizar y agrupar por (key, texto normalizado).
        const byTarget = new Map<string, ValueRow[]>();
        let unchanged = 0;
        const unitless: string[] = [];
        for (const row of rows) {
            const normalized = normalizeMeasurement(row.value);
            if (normalized === row.value) unchanged++;
            if (!/(?:ft|in|mm|cm|m)\b/.test(normalized)) {
                unitless.push(`${row.handle}: "${row.value}"${normalized !== row.value ? ` → "${normalized}"` : ''}`);
            }
            const target = `${row.key_id}||${normalized}`;
            const group = byTarget.get(target) ?? [];
            group.push(row);
            byTarget.set(target, group);
        }

        let renames = 0;
        let merges = 0;
        let linksMoved = 0;

        await client.query('BEGIN');
        for (const [target, group] of byTarget) {
            // target = `${key_id}||${texto}` — el texto normalizado lleva espacios.
            const normalized = target.slice(target.indexOf('||') + 2);
            // Superviviente: el de más links (estabilidad para la mayoría).
            group.sort((a, b) => b.links - a.links);
            const survivor = group[0];
            if (!survivor) continue;
            const dups = group.slice(1);

            if (survivor.value !== normalized) {
                renames++;
                console.log(`~ [${survivor.handle}] "${survivor.value}" → "${normalized}" (${survivor.links} links, in place)`);
                if (apply) {
                    await client.query(
                        `UPDATE attribute_value SET value = $2, updated_at = NOW() WHERE id = $1`,
                        [survivor.id, normalized],
                    );
                }
            }

            for (const dup of dups) {
                merges++;
                console.log(
                    `⇒ [${dup.handle}] "${dup.value}" (${dup.links} links) SE FUSIONA en "${normalized}" (superviviente: "${survivor.value}")`,
                );
                if (!apply) continue;
                // Repuntar links del dup al superviviente, salvo productos que
                // ya lo tengan (la PK compuesta lo impediría) — esos se borran.
                const moved = await client.query(
                    `UPDATE product_product_productattributes_attribute_value pav
                     SET attribute_value_id = $2, updated_at = NOW()
                     WHERE pav.attribute_value_id = $1
                       AND NOT EXISTS (
                         SELECT 1 FROM product_product_productattributes_attribute_value p2
                         WHERE p2.product_id = pav.product_id AND p2.attribute_value_id = $2)`,
                    [dup.id, survivor.id],
                );
                linksMoved += moved.rowCount ?? 0;
                await client.query(
                    `DELETE FROM product_product_productattributes_attribute_value WHERE attribute_value_id = $1`,
                    [dup.id],
                );
                await client.query(`DELETE FROM attribute_value WHERE id = $1`, [dup.id]);
            }
        }
        if (apply) await client.query('COMMIT');
        else await client.query('ROLLBACK');

        console.log(
            `\n════ ${rows.length} values · ${renames} renombrados in place · ${merges} fusionados (${linksMoved} links repuntados) · ${unchanged} ya estaban bien`,
        );
        if (unitless.length > 0) {
            console.log(`\n📋 SIN UNIDAD (sólo se corrigió la coma; unidad la pones vos — jamás se inventa):`);
            for (const u of unitless) console.log(`  · ${u}`);
        }
        if (!apply) console.log('\nDry-run — nada escrito. Agregar APPLY=true para ejecutar.');
        else console.log('\n✅ Aplicado.');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('NORMALIZE FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
