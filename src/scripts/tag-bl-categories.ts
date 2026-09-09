/**
 * Taguea variantes para Backlighting: `metadata.backlighting.category`.
 *
 * Suma a BL las tres familias que hasta ahora sólo tenía Linear Lighting —
 * conectores de cable pelado, cables y accesorios de driver— y de paso MUEVE los
 * 7 productos que hoy están amontonados en `accessories` a la categoría que les
 * corresponde.
 *
 * ── Por qué es read-modify-write y no un update ─────────────────────────────
 * `metadata` de variante es la trampa documentada de este repo: el upsert de
 * variante REEMPLAZA el objeto entero, y `update*` lo deep-mergea, así que
 * borrar una clave nunca persiste. Este script lee el metadata actual de CADA
 * variante, le cambia sólo `backlighting.category`, y escribe el objeto
 * completo. Nunca toca otra clave, y nunca asume que `metadata` existe.
 *
 * ── Seguridad ───────────────────────────────────────────────────────────────
 * · DRY-RUN por defecto. Escribe sólo con APPLY=true.
 * · Idempotente: una variante que ya está en su categoría destino no se toca.
 * · Guarda el metadata previo de cada variante que modifica, en un archivo, para
 *   poder revertir sin adivinar.
 * · Cuenta ANTES y DESPUÉS por categoría, y se niega si el total de variantes
 *   tagueadas bajara — mover no puede perder a nadie.
 *
 * Correr:
 *   env DATABASE_URL=... npx medusa exec ./src/scripts/tag-bl-categories.ts
 *   env APPLY=true DATABASE_URL=... npx medusa exec ./src/scripts/tag-bl-categories.ts
 */
import type { ExecArgs } from "@medusajs/framework/types"
import { Client } from "pg"
import { writeFileSync } from "node:fs"

/** Categoría de spec de Linear Lighting → categoría de Backlighting. */
const LL_TO_BL: Record<string, string> = {
    bare_wire_connector: "bare-wire-connectors",
    cable: "cables",
    led_driver_accessory: "led-driver-accessories",
    led_driver: "led-drivers",
    controller: "controllers",
    remote: "remotes",
}

/**
 * Categorías que NO se barren enteras: sólo entran los SKU nombrados en su
 * allowlist. Estar acá es la diferencia entre "BL adopta esta familia de LL" y
 * "BL adopta ESTE producto". Sacar una categoría de este set la convierte en
 * barrido y da de alta todo lo que LL tenga en ella.
 */
const ALLOWLIST_ONLY = new Set(["led_driver", "controller", "remote"])

/**
 * Drivers de LL que BL adopta EXPLÍCITAMENTE (user-requested 2026-09-03: los
 * XLG metálicos para el filtro driverFormFactor). `led_driver` NO se mapea
 * completo a propósito: BL ya tiene su set de drivers (EPS) y adoptar
 * minis/EASYLED/SWN en bloque haría que el próximo Sync Medusa de BL los dé de
 * alta como productos nuevos sin decisión humana. Un driver nuevo entra acá
 * por nombre, nunca por barrido.
 */
const LED_DRIVER_SKU_ALLOWLIST = ["XLG-200-24-A", "XLG-320-V-A"]

/**
 * Controllers y remotos de LL que BL adopta EXPLÍCITAMENTE (user-requested
 * 2026-09-09). Misma disciplina que los drivers de arriba y por el mismo
 * motivo: `controller` y `remote` NO se mapean como categoría porque BL ya
 * tiene su propio set y un barrido daría de alta cada controller de LL en el
 * próximo Sync Medusa sin que nadie lo haya decidido.
 *
 * · ECTSK-RFRC1C15A — el V1-L de 15 A / 360 W. BL sólo tenía Single/RF de 5 A
 *   (120 W) y la entrada Single/RF de `basicControllerMap` estaba VACÍA; éste
 *   pasa a ser su default. Su spec y su diagrama ya están autorados en
 *   `lld_product_spec`, y sus medidas en el PDF del fabricante.
 * · ECTSK-RM2C1ZW — el remoto CCT. `ECTSK-RFRC2C5A` declara `ECTSK-RM2X` como
 *   su familia de pareo y BL no tenía NINGÚN remoto de esa familia, así que esa
 *   compatibilidad no se podía satisfacer.
 * · ECTSK-RM1C4ZB / ECTSK-RM1C1ZB — Single/RF de 4 y 1 zona. El primero es el
 *   reemplazo del descontinuado `ECTSK-RM1C4Z`, que queda `disabled` en el
 *   catálogo de BL (nunca borrado: los proyectos guardados tienen que seguir
 *   resolviendo su SKU).
 *
 * OJO: el SKU de LL es clave de máquina y estos remotos llevan sufijo de
 * acabado. No fusionar `ECTSK-RM1C4Z` con `ECTSK-RM1C4ZB` — son SKU distintos
 * y se tratan como productos distintos.
 */
const CONTROLLER_REMOTE_SKU_ALLOWLIST = [
    "ECTSK-RFRC1C15A",
    "ECTSK-RM2C1ZW",
    "ECTSK-RM1C4ZB",
    "ECTSK-RM1C1ZB",
]

export default async function tagBlCategories({ container }: ExecArgs) {
    void container
    const apply = process.env.APPLY === "true"
    const db = new Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()

    try {
        const before = await db.query<{ cat: string; n: string }>(`
            SELECT metadata->'backlighting'->>'category' AS cat, count(*)::text AS n
              FROM product_variant
             WHERE metadata->'backlighting' IS NOT NULL AND deleted_at IS NULL
             GROUP BY 1 ORDER BY 1`)
        const totalBefore = before.rows.reduce((s, r) => s + Number(r.n), 0)

        console.log(`\n  ANTES — ${totalBefore} variantes tagueadas`)
        for (const r of before.rows) console.log(`    ${String(r.cat).padEnd(24)} ${r.n}`)

        // Las variantes candidatas y su destino, derivadas del spec de LL. La
        // fuente es `lld_product_spec` a propósito: es donde vive la decisión de
        // qué ES cada producto, y ya está autorada.
        const { rows: targets } = await db.query<{
            variant_id: string
            sku: string | null
            ll_category: string
            current: string | null
            metadata: Record<string, unknown> | null
        }>(`
            SELECT v.id AS variant_id, v.sku,
                   s.spec->>'category' AS ll_category,
                   v.metadata->'backlighting'->>'category' AS current,
                   v.metadata
              FROM lld_product_spec s
              JOIN product p ON p.id = s.product_id AND p.deleted_at IS NULL
              JOIN product_variant v ON v.product_id = p.id AND v.deleted_at IS NULL
             WHERE s.spec->>'category' = ANY($1::text[])
                OR (s.spec->>'category' = ANY($2::text[]) AND v.sku = ANY($3::text[]))
             ORDER BY 3, 2`,
            [
                Object.keys(LL_TO_BL).filter((k) => !ALLOWLIST_ONLY.has(k)),
                [...ALLOWLIST_ONLY],
                [...LED_DRIVER_SKU_ALLOWLIST, ...CONTROLLER_REMOTE_SKU_ALLOWLIST],
            ],
        )

        const pending = targets.filter((t) => t.current !== LL_TO_BL[t.ll_category])
        console.log(`\n  ${targets.length} variantes candidatas · ${pending.length} necesitan cambio\n`)
        for (const t of pending) {
            const to = LL_TO_BL[t.ll_category]
            console.log(`    ${(t.sku ?? t.variant_id).padEnd(22)} ${String(t.current ?? "(sin taguear)").padEnd(22)} → ${to}`)
        }

        if (!apply) {
            console.log(`\n  DRY-RUN. Nada se escribió. Repetí con APPLY=true.\n`)
            return
        }

        // El respaldo se escribe ANTES de la primera escritura: si el proceso
        // muere a la mitad, el archivo ya tiene lo necesario para revertir.
        const backupPath = `/tmp/tag-bl-categories-backup-${Date.now()}.json`
        writeFileSync(backupPath, JSON.stringify(pending.map((t) => ({ variant_id: t.variant_id, sku: t.sku, metadata: t.metadata })), null, 2))
        console.log(`\n  respaldo del metadata previo: ${backupPath}`)

        // ── Por qué el merge se hace en SQL y no en JS ──────────────────────
        // La versión anterior leía el metadata, lo mutaba en memoria y escribía
        // el OBJETO ENTERO. Entre el SELECT y el UPDATE pasan segundos, y el
        // pipeline de QuickBooks escribe `quickbooks_id` / `qb_edit_sequence` en
        // ese mismo campo cada minuto en producción: cualquier escritura suya en
        // esa ventana se perdía sin dejar rastro. Acá el `||` mergea DENTRO de
        // Postgres, en los dos niveles, así que ninguna otra clave se toca —
        // ni las que existan y este proceso no haya visto nunca.
        //
        // Y el `WHERE` lleva el valor esperado (compare-and-swap): si la fila se
        // movió por debajo, no matchea, el conteo queda corto y se aborta la
        // transacción entera. `IS NOT DISTINCT FROM` y no `=`, porque las 15 sin
        // taguear tienen ese valor en NULL y `=` nunca matchearía.
        await db.query("BEGIN")
        try {
            let written = 0
            for (const t of pending) {
                const res = await db.query(
                    `UPDATE product_variant
                        SET metadata = COALESCE(metadata, '{}'::jsonb)
                                     || jsonb_build_object('backlighting',
                                          COALESCE(metadata->'backlighting', '{}'::jsonb)
                                          || jsonb_build_object('category', $1::text)),
                            updated_at = now()
                      WHERE id = $2
                        AND deleted_at IS NULL
                        AND metadata->'backlighting'->>'category' IS NOT DISTINCT FROM $3`,
                    [LL_TO_BL[t.ll_category], t.variant_id, t.current],
                )
                if (res.rowCount !== 1) {
                    throw new Error(
                        `${t.sku ?? t.variant_id}: la fila cambió por debajo (esperaba ` +
                        `${t.current ?? "sin taguear"}). No se escribió nada — la transacción se revierte.`,
                    )
                }
                written += 1
            }
            await db.query("COMMIT")
            console.log(`\n  ${written} filas escritas en UNA transacción, con compare-and-swap`)
        } catch (e) {
            await db.query("ROLLBACK")
            throw e
        }

        const after = await db.query<{ cat: string; n: string }>(`
            SELECT metadata->'backlighting'->>'category' AS cat, count(*)::text AS n
              FROM product_variant
             WHERE metadata->'backlighting' IS NOT NULL AND deleted_at IS NULL
             GROUP BY 1 ORDER BY 1`)
        const totalAfter = after.rows.reduce((s, r) => s + Number(r.n), 0)

        console.log(`\n  DESPUÉS — ${totalAfter} variantes tagueadas`)
        for (const r of after.rows) console.log(`    ${String(r.cat).padEnd(24)} ${r.n}`)

        // Mover no puede perder a nadie. Si el total baja, algo escribió mal el
        // metadata y hay que revertir con el respaldo.
        if (totalAfter < totalBefore) {
            throw new Error(
                `El total de variantes tagueadas BAJÓ (${totalBefore} → ${totalAfter}). ` +
                `Revertí con ${backupPath} antes de seguir.`,
            )
        }
        console.log(`\n  ok — ${pending.length} variantes movidas o tagueadas, ninguna perdida\n`)
    } finally {
        await db.end()
    }
}
