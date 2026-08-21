/**
 * prefill-ll-product-attributes.ts — prellena los atributos básicos de los
 * productos taggeados para Linear Lighting que aún no los tienen, decodificando
 * SKU/título donde se puede (fuente 🟢 sku/title/computed) y cayendo a un
 * default marcado 🟡 donde no (decisión user 2026-08-21: "lo que no puedas
 * descifrar, llenalo con una opción y yo lo cambio").
 *
 * Reglas de negocio confirmadas por el usuario (2026-08-21):
 * - El W del SKU de una strip es POR ROLLO; rollo estándar 5 m (16.404 ft),
 *   salvo sufijo -L = 50 m. power-per-foot = W_familia / 16.404 (densidad de
 *   familia); los -L se FLAGUEAN para verificación manual.
 * - rated-current de controllers/amplifiers = corriente POR CANAL (del SKU) ×
 *   canales; se llena también current-per-channel.
 * - ECN-EDG-SS = strip-to-strip → Joiner; -WIS = wire-to-strip → Splice
 *   (ambos flagueados); -CR = Corner. EAS1-W → Wireless Receiver.
 *
 * Aditivo POR CLAVE: si el producto ya tiene algún valor para esa clave, se
 * saltea (jamás pisa). Crea attribute_value nuevos si el valor computado no
 * existe (marcados metadata.ll_prefill=true). Idempotente.
 *
 * Uso (DATABASE_URL EXPLÍCITO — no lee .env a propósito):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/fix/prefill-ll-product-attributes.ts
 *   Filtro opcional: CATEGORY=led_driver · Aplicar: APPLY=true (dry-run default)
 */
import { Pool } from 'pg';
import { ulid } from 'ulid';

type Source = 'sku' | 'title' | 'computed' | 'default';

interface PlanEntry {
    handle: string;
    value: string;
    source: Source;
    note?: string;
}

interface ProductInfo {
    id: string;
    title: string;
    category: string;
    skus: string[];
}

const ROLL_5M_FT = 16.404;
const CCT_MAP: Record<string, string> = {
    '27': '2700K', '30': '3000K', '35': '3500K', '40': '4000K', '50': '5000K', '60': '6000K', '65': '6500K',
};

/** SKU base sin sufijo CCT ni -L: ESP-ECA40W0840 → familia ECA40W, width 08. */
function parseStripSku(skus: string[]): { familyWatts?: number; widthMm?: number; ccts: string[]; isLongRoll: boolean } {
    const ccts = new Set<string>();
    let familyWatts: number | undefined;
    let widthMm: number | undefined;
    let isLongRoll = false;
    for (const sku of skus) {
        let s = sku.toUpperCase();
        if (s.endsWith('-L')) { isLongRoll = true; s = s.slice(0, -2); }
        const cct = s.slice(-2);
        if (CCT_MAP[cct]) { ccts.add(CCT_MAP[cct]); s = s.slice(0, -2); }
        const width = s.match(/(\d{2})$/);
        if (width && !widthMm) widthMm = parseInt(width[1], 10);
        const watts = s.match(/(\d{2,3})W/);
        if (watts && !familyWatts) familyWatts = parseInt(watts[1], 10);
    }
    return { familyWatts, widthMm, ccts: [...ccts].sort(), isLongRoll };
}

function planLedStrip(p: ProductInfo): PlanEntry[] {
    const { familyWatts, widthMm, ccts, isLongRoll } = parseStripSku(p.skus);
    const out: PlanEntry[] = [];
    if (widthMm) out.push({ handle: 'strip-width', value: `${widthMm}mm`, source: 'sku' });
    if (familyWatts) {
        const perFt = (familyWatts / ROLL_5M_FT).toFixed(2).replace(/\.?0+$/, '');
        out.push({
            handle: 'power-per-foot', value: `${perFt}W/ft`, source: 'computed',
            note: isLongRoll ? `⚠️ rollo 50m (-L): ${familyWatts}W leído como W del rollo de 5m de la familia — VERIFICAR` : `${familyWatts}W/rollo 5m`,
        });
    }
    for (const cct of ccts) out.push({ handle: 'color-options', value: cct, source: 'sku' });
    out.push({ handle: 'input-voltage', value: '24VDC', source: 'default' });
    out.push({ handle: 'cuttable-length', value: '1 inch', source: 'default' });
    return out;
}

function planLedNeon(p: ProductInfo): PlanEntry[] {
    const out: PlanEntry[] = [];
    const m = p.skus[0]?.toUpperCase().match(/^ENEA\d-(\d{2})-/);
    if (m) out.push({ handle: 'neon-width', value: `${parseInt(m[1], 10)}mm`, source: 'sku', note: 'convención ENEA1-<width>-<cct> — verificar' });
    out.push({ handle: 'input-voltage', value: '24VDC', source: 'default' });
    out.push({ handle: 'cuttable-length', value: '1 inch', source: 'default' });
    return out;
}

function planLedDriver(p: ProductInfo): PlanEntry[] {
    const out: PlanEntry[] = [];
    const sku = p.skus[0]?.toUpperCase() ?? '';
    let watts: number | undefined;
    const d = sku.match(/D(\d{2})24$/);
    const swn = sku.match(/SWN-(\d+)-24/);
    if (d) watts = parseInt(d[1], 10);
    else if (swn) watts = parseInt(swn[1], 10);
    if (watts) {
        const titleW = p.title.match(/(\d+)\s*W/i);
        const mismatch = titleW && parseInt(titleW[1], 10) !== watts;
        out.push({
            handle: 'rated-power', value: `${watts}W`, source: 'sku',
            note: mismatch ? `⚠️ el TÍTULO dice ${titleW![1]}W y el SKU ${watts}W — typo conocido, VERIFICAR` : undefined,
        });
    }
    if (/24$|24\b/.test(sku)) out.push({ handle: 'output-voltage', value: '24VDC', source: 'sku' });
    out.push({ handle: 'input-voltage', value: '100-240VAC', source: 'default' });
    if (/dimmable/i.test(p.title)) out.push({ handle: 'dimmable', value: 'Yes', source: 'title' });
    else out.push({ handle: 'dimmable', value: 'No', source: 'default' });
    return out;
}

function planSensor(p: ProductInfo): PlanEntry[] {
    const out: PlanEntry[] = [];
    const wireless = /wireless/i.test(p.title);
    const wired = /wired/i.test(p.title);
    if (wireless || wired) {
        out.push({ handle: 'sensor-system', value: wireless ? 'Wireless' : 'Wired', source: 'title' });
    } else {
        out.push({ handle: 'sensor-system', value: 'Wired', source: 'default' });
    }
    if (!wireless) {
        // Un sensor wireless no tiene conexión física — sin compat.
        out.push({ handle: 'input-compatibility', value: 'JST', source: 'default' });
        out.push({ handle: 'output-compatibility', value: 'JST', source: 'default' });
    }
    return out;
}

function channelEntries(sku: string): { channels: number[]; ampsPerChannel?: number } {
    const s = sku.toUpperCase();
    const amps = s.match(/(\d+)A$/);
    const multi = s.match(/RM(\d)&(\d)C/);
    if (multi) return { channels: [parseInt(multi[1], 10), parseInt(multi[2], 10)], ampsPerChannel: amps ? parseInt(amps[1], 10) : undefined };
    const single = s.match(/(\d+)C(?:\d|$)/);
    return { channels: single ? [parseInt(single[1], 10)] : [], ampsPerChannel: amps ? parseInt(amps[1], 10) : undefined };
}

function planControllerish(p: ProductInfo): PlanEntry[] {
    const out: PlanEntry[] = [];
    const { channels, ampsPerChannel } = channelEntries(p.skus[0] ?? '');
    for (const ch of channels) out.push({ handle: 'channels', value: ch === 1 ? '1 Channel' : `${ch} Channels`, source: 'sku' });
    if (ampsPerChannel) {
        out.push({ handle: 'current-per-channel', value: `${ampsPerChannel}A`, source: 'sku' });
        const maxCh = Math.max(...channels);
        if (channels.length > 0) {
            out.push({ handle: 'rated-current', value: `${ampsPerChannel * maxCh}A`, source: 'computed', note: `${ampsPerChannel}A × ${maxCh} canales` });
        }
    }
    out.push({ handle: 'input-voltage', value: '12/24VDC', source: 'default' });
    return out;
}

function planRemote(p: ProductInfo): PlanEntry[] {
    const { channels } = channelEntries(p.skus[0] ?? '');
    return channels.map((ch) => ({ handle: 'channels', value: ch === 1 ? '1 Channel' : `${ch} Channels`, source: 'sku' as Source }));
}

function planAccessory(p: ProductInfo): PlanEntry[] {
    const out: PlanEntry[] = [];
    const sku = (p.skus[0] ?? '').toUpperCase();
    const isEasyledW = /^EAS\d-W$/.test(sku);
    let type: { value: string; source: Source; note?: string } | null = null;
    if (isEasyledW) type = { value: 'Wireless Receiver', source: 'sku' };
    else if (sku.includes('SPL')) type = { value: 'Splitter', source: 'sku' };
    else if (sku.includes('EXT')) type = { value: 'Extension', source: 'sku' };
    else if (sku.includes('-CR')) type = { value: 'Corner', source: 'sku' };
    else if (sku.includes('-SS')) type = { value: 'Joiner', source: 'sku', note: '⚠️ SS = strip-to-strip → Joiner, revisar' };
    else if (sku.includes('-WIS')) type = { value: 'Splice', source: 'sku', note: '⚠️ WIS = wire-to-strip → Splice, revisar' };
    else type = { value: 'Other', source: 'default' };
    out.push({ handle: 'accessory-type', ...type });

    if (sku.includes('-CR') || sku.includes('-SS')) {
        out.push({ handle: 'input-compatibility', value: 'Direct to LED Strip', source: 'sku' });
        out.push({ handle: 'output-compatibility', value: 'Direct to LED Strip', source: 'sku' });
    } else if (sku.includes('-WIS')) {
        out.push({ handle: 'input-compatibility', value: 'Bare Wires', source: 'sku' });
        out.push({ handle: 'output-compatibility', value: 'Direct to LED Strip', source: 'sku' });
    } else if (sku.includes('DCSPL')) {
        out.push({ handle: 'input-compatibility', value: 'DC Plug', source: 'sku' });
        out.push({ handle: 'output-compatibility', value: 'DC Plug', source: 'sku' });
    } else if (sku.includes('3DSPL') || sku.includes('3DEXT')) {
        out.push({ handle: 'input-compatibility', value: 'JST', source: 'sku' });
        out.push({ handle: 'output-compatibility', value: 'JST', source: 'sku' });
    } else {
        out.push({ handle: 'input-compatibility', value: 'JST', source: 'default' });
        out.push({ handle: 'output-compatibility', value: 'JST', source: 'default' });
    }
    return out;
}

const PLANNERS: Record<string, (p: ProductInfo) => PlanEntry[]> = {
    led_strip: planLedStrip,
    led_neon: planLedNeon,
    led_driver: planLedDriver,
    sensor: planSensor,
    controller: planControllerish,
    amplifier: planControllerish,
    remote: planRemote,
    led_strip_accessory: planAccessory,
    led_driver_accessory: planAccessory,
    led_neon_accessory: planAccessory,
};

async function main() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL es obligatorio y explícito (este script NO lee .env). ' +
                'Sandbox: postgresql://postgres:sandbox@localhost:5499/medusa',
        );
    }
    const apply = process.env.APPLY === 'true';
    const categoryFilter = process.env.CATEGORY ?? null;
    const host = new URL(dbUrl).host;
    console.log(`Target DB: ${host}  ·  mode: ${apply ? '⚠️  APPLY' : 'dry-run'}${categoryFilter ? `  ·  category: ${categoryFilter}` : ''}`);

    const pool = new Pool({ connectionString: dbUrl });
    const flagged: string[] = [];
    let filled = 0, skipped = 0, valuesCreated = 0;
    try {
        const { rows: keys } = await pool.query<{ id: string; handle: string }>(
            `SELECT id, handle FROM attribute_key WHERE deleted_at IS NULL`,
        );
        const keyByHandle = new Map(keys.map((k) => [k.handle, k.id]));

        const { rows: products } = await pool.query<ProductInfo>(
            `SELECT p.id, p.title,
                    p.metadata->'linear_lighting'->>'category' AS category,
                    ARRAY(SELECT v.sku FROM product_variant v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.sku IS NOT NULL
                          ORDER BY v.variant_rank NULLS LAST, v.created_at) AS skus
             FROM product p
             WHERE p.metadata->>'linear_lighting' IS NOT NULL AND p.deleted_at IS NULL
               AND ($1::text IS NULL OR p.metadata->'linear_lighting'->>'category' = $1)
             ORDER BY category, p.title`,
            [categoryFilter],
        );

        for (const p of products) {
            const planner = PLANNERS[p.category];
            if (!planner || p.skus.length === 0) continue;
            const plan = planner(p);
            if (plan.length === 0) continue;

            const { rows: existingKeys } = await pool.query<{ attribute_key_id: string }>(
                `SELECT DISTINCT av.attribute_key_id
                 FROM product_product_productattributes_attribute_value pav
                 JOIN attribute_value av ON av.id = pav.attribute_value_id AND av.deleted_at IS NULL
                 WHERE pav.product_id = $1 AND pav.deleted_at IS NULL`,
                [p.id],
            );
            const hasKey = new Set(existingKeys.map((r) => r.attribute_key_id));

            const toApply = plan.filter((e) => {
                const keyId = keyByHandle.get(e.handle);
                return keyId !== undefined && !hasKey.has(keyId);
            });
            if (toApply.length === 0) { skipped++; continue; }

            console.log(`\n${p.title}  [${p.category}]  (${p.skus[0]})`);
            for (const entry of toApply) {
                const keyId = keyByHandle.get(entry.handle)!;
                const icon = entry.source === 'default' ? '🟡' : '🟢';
                console.log(`  ${icon} ${entry.handle} = "${entry.value}" (${entry.source})${entry.note ? ` — ${entry.note}` : ''}`);
                if (entry.source === 'default' || entry.note?.startsWith('⚠️')) {
                    flagged.push(`${p.skus[0]} · ${entry.handle} = "${entry.value}"${entry.note ? ` — ${entry.note}` : ' — default'}`);
                }
                filled++;
                if (!apply) continue;

                const { rows: valRows } = await pool.query<{ id: string }>(
                    `SELECT id FROM attribute_value WHERE attribute_key_id = $1 AND value = $2 AND deleted_at IS NULL LIMIT 1`,
                    [keyId, entry.value],
                );
                let valueId = valRows[0]?.id;
                if (!valueId) {
                    valueId = ulid();
                    valuesCreated++;
                    await pool.query(
                        `INSERT INTO attribute_value (id, value, attribute_key_id, metadata)
                         VALUES ($1, $2, $3, '{"ll_prefill": true}'::jsonb)`,
                        [valueId, entry.value, keyId],
                    );
                }
                const revived = await pool.query(
                    `UPDATE product_product_productattributes_attribute_value
                     SET deleted_at = NULL, updated_at = NOW()
                     WHERE product_id = $1 AND attribute_value_id = $2 AND deleted_at IS NOT NULL`,
                    [p.id, valueId],
                );
                if ((revived.rowCount ?? 0) === 0) {
                    await pool.query(
                        `INSERT INTO product_product_productattributes_attribute_value (id, product_id, attribute_value_id)
                         VALUES ($1, $2, $3)`,
                        [`link_${ulid()}`, p.id, valueId],
                    );
                }
            }
        }

        console.log(`\n════ Resumen: ${filled} atributos ${apply ? 'aplicados' : 'a aplicar'} · ${skipped} productos ya cubiertos · ${valuesCreated} values nuevos`);
        if (flagged.length > 0) {
            console.log(`\n📋 PARA TU REVISIÓN MANUAL (${flagged.length} — defaults y flags):`);
            for (const f of flagged) console.log(`  · ${f}`);
        }
        if (!apply) console.log('\nDry-run — nada escrito. Agregar APPLY=true para ejecutar.');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('PREFILL FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
