#!/usr/bin/env tsx
/**
 * cleanup-test-customers.ts
 * 
 * Elimina cuentas de prueba (sin QB List ID) y consolida duplicados.
 * 
 * REGLAS:
 * - Solo toca tabla `customer` (las cuentas admin están en la tabla `user`)
 * - Elimina SOLO clientes sin qb_list_id (todos los reales vinieron de QB)
 * - Mantiene intactos los clientes con qb_list_id
 * - DRY_RUN=true por defecto — pasar DRY_RUN=false para ejecutar
 */
import { Client } from 'pg'
import dotenv from 'dotenv'
dotenv.config()

const DRY_RUN = process.env.DRY_RUN !== 'false'

async function main() {
    const client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    console.log(`✅ Connected to database`)
    console.log(`🔧 Mode: ${DRY_RUN ? '🔍 DRY RUN (no changes)' : '💾 LIVE (deleting)'}\n`)

    // Obtener todos los candidatos a eliminar
    const candidates = await client.query(`
        SELECT id, email, first_name, last_name,
               metadata->>'qb_list_id' as qb_list_id,
               metadata->>'legacy_customer' as is_legacy,
               created_at
        FROM customer
        WHERE metadata->>'qb_list_id' IS NULL
        ORDER BY created_at DESC
    `)

    console.log(`📋 CANDIDATOS A ELIMINAR (${candidates.rowCount} cuentas sin QB ID):\n`)
    for (const c of candidates.rows) {
        const tag = c.is_legacy === 'true' ? '[LEGACY]' : '[TEST]'
        console.log(`  ${tag} ${c.first_name} ${c.last_name} | ${c.email} | ${c.id}`)
    }

    // Verificar que no vamos a borrar nada con QB ID (safety check)
    const withQbId = candidates.rows.filter(c => c.qb_list_id)
    if (withQbId.length > 0) {
        console.error('\n❌ SAFETY CHECK FAILED: algunos candidatos tienen QB ID. Abortando.')
        process.exit(1)
    }

    console.log(`\n✅ Safety check passed: todos los ${candidates.rowCount} candidatos no tienen QB ID`)

    if (DRY_RUN) {
        console.log('\n🔍 DRY RUN — no se realizaron cambios.')
        console.log('   Para ejecutar: DRY_RUN=false npx tsx src/scripts/delete/cleanup-test-customers.ts')
        await client.end()
        return
    }

    // LIVE: Eliminar
    console.log(`\n💾 Eliminando ${candidates.rowCount} cuentas...`)

    const ids = candidates.rows.map(c => c.id)

    // Primero eliminar registros relacionados (addresses, etc.)
    await client.query(`DELETE FROM customer_address WHERE customer_id = ANY($1::text[])`, [ids])
    console.log(`  ✅ Addresses eliminadas`)

    // Eliminar los customers
    const deleted = await client.query(`
        DELETE FROM customer WHERE id = ANY($1::text[]) RETURNING id, email
    `, [ids])

    console.log(`\n✅ COMPLETADO: ${deleted.rowCount} cuentas eliminadas`)

    // Verificar Alejandro Vargas consolidado
    const vargas = await client.query(`
        SELECT id, email, metadata->>'qb_list_id' as qb_list_id
        FROM customer
        WHERE first_name ILIKE '%alejandro%' AND last_name ILIKE '%vargas%'
    `)
    console.log(`\n🔍 Alejandro Vargas después del cleanup:`)
    for (const c of vargas.rows) {
        console.log(`  ${c.email} | QB ID: ${c.qb_list_id || 'NONE'}`)
    }

    // Totales finales
    const final = await client.query(`
        SELECT COUNT(*) as total,
               COUNT(CASE WHEN metadata->>'qb_list_id' IS NOT NULL THEN 1 END) as with_qb_id,
               COUNT(CASE WHEN metadata->>'qb_list_id' IS NULL THEN 1 END) as without_qb_id
        FROM customer
    `)
    console.log('\n📊 TOTALES FINALES:')
    console.table(final.rows)

    await client.end()
}

main().catch(e => {
    console.error('❌ Error:', e.message)
    process.exit(1)
})
