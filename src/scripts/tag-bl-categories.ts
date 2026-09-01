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
}

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
             ORDER BY 3, 2`,
            [Object.keys(LL_TO_BL)],
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

        for (const t of pending) {
            const next = { ...(t.metadata ?? {}) } as Record<string, unknown>
            const bl = { ...((next.backlighting as Record<string, unknown>) ?? {}) }
            bl.category = LL_TO_BL[t.ll_category]
            next.backlighting = bl
            await db.query(`UPDATE product_variant SET metadata = $1, updated_at = now() WHERE id = $2`, [next, t.variant_id])
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
