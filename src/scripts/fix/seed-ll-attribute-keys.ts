/**
 * seed-ll-attribute-keys.ts — crea las claves de Atributos que el Linear
 * Lighting Designer necesita como fuente de verdad (plan ll-attributes-
 * foundation, 2026-08-21): sensor-system, neon-width, input-compatibility,
 * output-compatibility, accessory-type.
 *
 * Cada opción lleva un CÓDIGO MÁQUINA estable en attribute_key.metadata
 * (ll_code_map: label → code). Los labels son presentación y pueden cambiar;
 * los codes son el contrato con los schemas de LL (p.ej. accessory-type usa
 * exactamente los valores del enum Zod: splitter, joiner, end_cap…) y NUNCA
 * se renombran.
 *
 * Idempotente y aditivo: una clave cuyo handle ya existe se COMPLETA (solo
 * agrega opciones/values faltantes); jamás borra ni renombra nada. NO usa
 * /admin/attributes/sync-values (esa ruta borra values ausentes de options
 * aunque haya productos apuntándolos).
 *
 * Uso (desde backend/ — DATABASE_URL EXPLÍCITO, a propósito no lee .env
 * porque ese archivo apunta a prod):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/fix/seed-ll-attribute-keys.ts
 *   Agregar APPLY=true para ejecutar (dry-run por default).
 */
import { Pool } from 'pg';
import { ulid } from 'ulid';

interface SeedKey {
    handle: string;
    label: string;
    setHandle: string;
    unit: string | null;
    /** label visible → código máquina estable (contrato con los schemas LL). */
    options: { label: string; code: string }[];
}

const SEED_KEYS: SeedKey[] = [
    {
        handle: 'sensor-system',
        label: 'Sensor System',
        setHandle: 'control-compatibility',
        unit: null,
        options: [
            { label: 'Wired', code: 'wired' },
            { label: 'Wireless', code: 'wireless' },
        ],
    },
    {
        handle: 'neon-width',
        label: 'Neon Width',
        setHandle: 'physical-characteristics',
        unit: 'mm',
        // Arranque paralelo al vocabulario limpio de strip-width; se amplía
        // desde la página de Atributos cuando aparezca un ancho nuevo.
        options: [
            { label: '4mm', code: '4' },
            { label: '5mm', code: '5' },
            { label: '6mm', code: '6' },
            { label: '8mm', code: '8' },
            { label: '10mm', code: '10' },
            { label: '12mm', code: '12' },
            { label: '18mm', code: '18' },
        ],
    },
    {
        // Salidas físicas directas de un driver / splitter — espejo del campo
        // numérico `outputs` del spec LL. Codes = el número, para derivarlo.
        handle: 'number-of-outputs',
        label: 'Number of Outputs',
        setHandle: 'electrical-characteristics',
        unit: null,
        options: [
            { label: '1', code: '1' },
            { label: '2', code: '2' },
            { label: '3', code: '3' },
            { label: '4', code: '4' },
            { label: '5', code: '5' },
            { label: '6', code: '6' },
            { label: '8', code: '8' },
        ],
    },
    {
        // Cuántos extremos de la strip/neon traen conector — espejo del enum
        // `ended: single|both` del spec LL (STRIP_ENDED en catalog-types.ts).
        handle: 'connection-ends',
        label: 'Connection Ends',
        setHandle: 'control-compatibility',
        unit: null,
        options: [
            { label: 'One End', code: 'single' },
            { label: 'Both Ends', code: 'both' },
        ],
    },
    // 2026-08-21 (user): el mating de conectores necesita GÉNERO — un output
    // JST-Female sólo se aparea con un input JST-Male. El usuario borró los
    // genderless "JST"/"DC Plug" y creó estos labels desde el modal; el seed
    // adopta SU vocabulario (no resucitar los viejos). La tabla de mating la
    // consumirá el motor del Designer keyeada por estos codes:
    //   jst_male↔jst_female · dc_male↔dc_female · c8_male↔c8_female ·
    //   bare_wire↔bare_wire · direct_to_strip (sin pareja, clip/solder).
    {
        handle: 'input-connector',
        label: 'Input Connector',
        setHandle: 'control-compatibility',
        unit: null,
        options: [
            { label: 'Direct to LED Strip', code: 'direct_to_strip' },
            { label: 'Bare Wires', code: 'bare_wire' },
            { label: '5A Connector', code: 'connector_5a' },
            { label: 'JST-Male', code: 'jst_male' },
            { label: 'JST-Female', code: 'jst_female' },
            { label: 'DC-Male', code: 'dc_male' },
            { label: 'DC-Female', code: 'dc_female' },
            { label: 'C8-Male', code: 'c8_male' },
            { label: 'C8-Female', code: 'c8_female' },
        ],
    },
    {
        handle: 'output-connector',
        label: 'Output Connector',
        setHandle: 'control-compatibility',
        unit: null,
        options: [
            { label: 'Direct to LED Strip', code: 'direct_to_strip' },
            { label: 'Bare Wires', code: 'bare_wire' },
            { label: '5A Connector', code: 'connector_5a' },
            { label: 'JST-Male', code: 'jst_male' },
            { label: 'JST-Female', code: 'jst_female' },
            { label: 'DC-Male', code: 'dc_male' },
            { label: 'DC-Female', code: 'dc_female' },
            { label: 'C8-Male', code: 'c8_male' },
            { label: 'C8-Female', code: 'c8_female' },
        ],
    },
    {
        handle: 'accessory-type',
        label: 'Accessory Type',
        setHandle: 'general-information',
        unit: null,
        // Los codes son EXACTAMENTE el enum Zod de LL (bom.ts matchea
        // 'splitter' literal) — cambiar un code acá rompe el motor de BOM.
        options: [
            { label: 'Splitter', code: 'splitter' },
            { label: 'Joiner', code: 'joiner' },
            { label: 'Corner', code: 'corner' },
            { label: 'End Cap', code: 'end_cap' },
            { label: 'Mounting', code: 'mounting' },
            { label: 'Lever Nut', code: 'lever_nut' },
            { label: 'Splice', code: 'splice' },
            { label: 'Extension', code: 'extension' },
            { label: 'Cable', code: 'cable' },
            // 2026-08-21 (user): receivers inalámbricos (EAS1-W) viven como
            // driver accessories. El enum Zod de LL lo suma la fase B.
            { label: 'Wireless Receiver', code: 'wireless_receiver' },
            { label: 'Other', code: 'other' },
        ],
    },
];

/**
 * Renombres de handle/label (2026-08-21, user): "compatibility" describía mal
 * — el atributo es el CONECTOR que el producto tiene en cada lado. Corren
 * ANTES del seed de claves: sin esto, el seed no encontraría el handle nuevo
 * y crearía una clave duplicada. Idempotente (0 filas si ya está renombrado).
 */
const RENAMES: { from: string; to: string; label: string }[] = [
    { from: 'input-compatibility', to: 'input-connector', label: 'Input Connector' },
    { from: 'output-compatibility', to: 'output-connector', label: 'Output Connector' },
];

async function main() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        throw new Error(
            'DATABASE_URL es obligatorio y explícito (este script NO lee .env — apunta a prod). ' +
                'Sandbox: postgresql://postgres:sandbox@localhost:5499/medusa',
        );
    }
    const apply = process.env.APPLY === 'true';
    const host = new URL(dbUrl).host;
    console.log(`Target DB: ${host}  ·  mode: ${apply ? '⚠️  APPLY' : 'dry-run'}`);

    const pool = new Pool({ connectionString: dbUrl });
    try {
        for (const rename of RENAMES) {
            const { rows: oldKey } = await pool.query(
                `SELECT id FROM attribute_key WHERE handle = $1 AND deleted_at IS NULL`,
                [rename.from],
            );
            if (oldKey.length === 0) continue;
            console.log(`~ rename ${rename.from} → ${rename.to} ("${rename.label}")`);
            if (apply) {
                await pool.query(
                    `UPDATE attribute_key SET handle = $2, label = $3, updated_at = NOW()
                     WHERE handle = $1 AND deleted_at IS NULL`,
                    [rename.from, rename.to, rename.label],
                );
            }
        }

        const { rows: sets } = await pool.query<{ id: string; handle: string }>(
            `SELECT id, handle FROM attribute_set WHERE deleted_at IS NULL`,
        );
        const setByHandle = new Map(sets.map((s) => [s.handle, s.id]));

        for (const seed of SEED_KEYS) {
            const setId = setByHandle.get(seed.setHandle);
            if (!setId) throw new Error(`Attribute set "${seed.setHandle}" no existe en ${host} — abortando`);

            const { rows: existing } = await pool.query<{
                id: string;
                options: string[] | null;
                metadata: Record<string, unknown> | null;
            }>(`SELECT id, options, metadata FROM attribute_key WHERE handle = $1 AND deleted_at IS NULL`, [
                seed.handle,
            ]);

            const codeMap = Object.fromEntries(seed.options.map((o) => [o.label, o.code]));
            let keyId: string;

            if (existing.length === 0) {
                keyId = ulid();
                console.log(`+ key ${seed.handle} (set ${seed.setHandle}, ${seed.options.length} opciones)`);
                if (apply) {
                    await pool.query(
                        `INSERT INTO attribute_key (id, handle, label, options, attribute_set_id, unit, filter_type, metadata)
                         VALUES ($1, $2, $3, $4, $5, $6, 'dropdown', $7::jsonb)`,
                        [
                            keyId,
                            seed.handle,
                            seed.label,
                            seed.options.map((o) => o.label),
                            setId,
                            seed.unit,
                            JSON.stringify({ ll_code_map: codeMap, ll_managed: true }),
                        ],
                    );
                }
            } else {
                keyId = existing[0].id;
                const currentOptions = existing[0].options ?? [];
                const missing = seed.options.filter((o) => !currentOptions.includes(o.label));
                console.log(
                    `= key ${seed.handle} ya existe — ${missing.length ? `agrega ${missing.length} opciones: ${missing.map((o) => o.label).join(', ')}` : 'completa, sin cambios de opciones'}`,
                );
                if (apply) {
                    // Aditivo: opciones nuevas al final; el ll_code_map se MERGEA
                    // (labels ya mapeados conservan su code — nunca se pisa).
                    const mergedCodeMap = {
                        ...codeMap,
                        ...((existing[0].metadata?.ll_code_map as Record<string, string>) ?? {}),
                    };
                    await pool.query(
                        `UPDATE attribute_key
                         SET options = $2,
                             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                             updated_at = NOW()
                         WHERE id = $1`,
                        [
                            keyId,
                            [...currentOptions, ...missing.map((o) => o.label)],
                            JSON.stringify({ ll_code_map: mergedCodeMap, ll_managed: true }),
                        ],
                    );
                }
            }

            // Pre-crear los attribute_value de cada opción para que el picker
            // de productos y el pivote puedan linkear de inmediato.
            for (const opt of seed.options) {
                const { rows: existingValue } = await pool.query(
                    `SELECT id FROM attribute_value WHERE attribute_key_id = $1 AND value = $2 AND deleted_at IS NULL`,
                    [keyId, opt.label],
                );
                if (existingValue.length > 0) continue;
                console.log(`  + value "${opt.label}" (code: ${opt.code})`);
                if (apply) {
                    await pool.query(
                        `INSERT INTO attribute_value (id, value, attribute_key_id, metadata)
                         VALUES ($1, $2, $3, $4::jsonb)`,
                        [ulid(), opt.label, keyId, JSON.stringify({ ll_code: opt.code })],
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
    console.error('SEED FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
});
