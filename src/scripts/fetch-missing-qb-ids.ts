import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Script para Consultar QuickBooks y Actualizar quickbooks_id
 * 
 * Consulta directamente con QuickBooks a través del Bridge para obtener
 * los ListID (quickbooks_id) de los productos faltantes y actualizar
 * el metadata de las variantes en Medusa.
 * 
 * MODO DRY-RUN (Por defecto):
 *   DRY_RUN=true npx medusa exec ./src/scripts/fetch-missing-qb-ids.ts
 * 
 * MODO EJECUCIÓN REAL:
 *   DRY_RUN=false npx medusa exec ./src/scripts/fetch-missing-qb-ids.ts
 */

// Config - QuickBooks Bridge
const BRIDGE_URL = "https://ecopower-qb.loca.lt"
const API_KEY = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const POLL_INTERVAL_MS = 30000 // 30 seconds
const MAX_POLL_ATTEMPTS = 20 // 10 minutes max

export default async function fetchMissingQbIds({ container }: ExecArgs) {
    const isDryRun = process.env.DRY_RUN !== "false"
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const productModule = container.resolve(Modules.PRODUCT)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    logger.info("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    logger.info(isDryRun ? "📋 DRY RUN MODE - No se modificará nada" : "⚠️  EXECUTION MODE ACTIVE")
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    try {
        // Paso 1: Encontrar variantes sin quickbooks_id
        logger.info("🔍 Buscando variantes sin quickbooks_id...\n")

        const { data: allVariants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "metadata"],
            filters: {}
        })

        const variantsWithoutQbId = allVariants.filter((v: any) =>
            v.sku && (!v.metadata || !v.metadata.quickbooks_id)
        )

        if (variantsWithoutQbId.length === 0) {
            logger.info("✅ Todas las variantes tienen quickbooks_id")
            return
        }

        logger.info(`   ⚠️  Encontradas ${variantsWithoutQbId.length} variantes sin quickbooks_id:\n`)
        variantsWithoutQbId.slice(0, 10).forEach((v: any, idx: number) => {
            logger.info(`      ${idx + 1}. ${v.sku}`)
        })
        if (variantsWithoutQbId.length > 10) {
            logger.info(`      ... y ${variantsWithoutQbId.length - 10} más`)
        }

        // Paso 2: Consultar QuickBooks Bridge
        logger.info("\n📡 Consultando QuickBooks Bridge...\n")

        const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
            headers: { "x-api-key": API_KEY }
        })

        if (!initRes.ok) {
            logger.error(`❌ Bridge Error: ${initRes.status} ${initRes.statusText}`)
            return
        }

        const initJson: any = await initRes.json()
        const operationId = initJson.operationId
        logger.info(`   ✅ Operación iniciada: ${operationId}`)

        // Paso 3: Polling Loop
        let qbData: any[] = []
        let attempts = 0

        logger.info("\n⏳ Esperando respuesta de QuickBooks...\n")

        while (attempts < MAX_POLL_ATTEMPTS) {
            attempts++
            logger.info(`   Intento ${attempts}/${MAX_POLL_ATTEMPTS}... (Esperando Web Connector sync - cada 2 min)`)

            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

            const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
                headers: { "x-api-key": API_KEY }
            })

            if (!statusRes.ok) {
                logger.warn(`   ⚠️  Bridge Status Error: ${statusRes.status}`)
                continue
            }

            const statusJson: any = await statusRes.json()

            if (statusJson.success && statusJson.operation) {
                if (statusJson.operation.status === "completed") {
                    // Parse XML Response
                    const rawXml = statusJson.operation.qbxmlResponse
                    if (rawXml) {
                        logger.info("\n📦 Respuesta recibida. Parseando XML...\n")

                        const itemBlocks = rawXml.match(/<Item[a-zA-Z]+Ret>[\s\S]*?<\/Item[a-zA-Z]+Ret>/g) || []

                        qbData = itemBlocks.map((block: string) => {
                            const listId = block.match(/<ListID>([^<]+)<\/ListID>/)?.[1]
                            const name = block.match(/<Name>([^<]+)<\/Name>/)?.[1]
                            const mpn = block.match(/<ManufacturerPartNumber>([^<]+)<\/ManufacturerPartNumber>/)?.[1]

                            return {
                                ListID: listId,
                                Name: name,
                                MPN: mpn
                            }
                        }).filter((i: any) => i.ListID)

                        logger.info(`   ✅ ${qbData.length} productos encontrados en QuickBooks`)
                    }
                    break
                } else if (statusJson.operation.status === "failed") {
                    logger.error(`\n❌ Operación fallida: ${statusJson.operation.message}`)
                    return
                }
            }
        }

        if (!qbData || qbData.length === 0) {
            logger.warn("\n⚠️  Timeout o respuesta vacía de QuickBooks")
            return
        }

        // Paso 4: Matching SKU con QuickBooks Name
        logger.info("\n🔄 Buscando coincidencias SKU ↔ QuickBooks...\n")

        const qbMap = new Map<string, any>()

        // Crear mapa Name -> QuickBooks Item
        qbData.forEach(item => {
            if (item.Name) {
                qbMap.set(item.Name.toUpperCase(), item)
            }
        })

        const updates: Array<{ variant: any; qbItem: any }> = []

        for (const variant of variantsWithoutQbId) {
            const sku = variant.sku.toUpperCase()

            // Intentar match exacto por SKU = Name
            let qbItem = qbMap.get(sku)

            if (qbItem) {
                updates.push({ variant, qbItem })
                logger.info(`   ✓ Match: ${variant.sku} ↔ ${qbItem.Name} (${qbItem.ListID})`)
            } else {
                logger.warn(`   ✗ No match: ${variant.sku}`)
            }
        }

        logger.info(`\n📊 Resumen de matches:`)
        logger.info(`   • Total sin QB ID: ${variantsWithoutQbId.length}`)
        logger.info(`   • Matches encontrados: ${updates.length}`)
        logger.info(`   • Sin match: ${variantsWithoutQbId.length - updates.length}`)

        if (updates.length === 0) {
            logger.info("\n⚠️  No se encontraron matches para actualizar")
            return
        }

        // Paso 5: Actualizar metadata
        if (!isDryRun) {
            logger.info("\n🔄 Actualizando metadata...\n")

            for (const { variant, qbItem } of updates) {
                try {
                    const newMetadata = {
                        ...(variant.metadata || {}),
                        quickbooks_id: qbItem.ListID,
                    }

                    // Agregar MPN si existe
                    if (qbItem.MPN) {
                        newMetadata.mpn = qbItem.MPN
                    }

                    await productModule.updateProductVariants(variant.id, {
                        metadata: newMetadata
                    })

                    logger.info(`   ✅ ${variant.sku}: QB_ID=${qbItem.ListID}${qbItem.MPN ? `, MPN=${qbItem.MPN}` : ''}`)
                } catch (err: any) {
                    logger.error(`   ❌ Error actualizando ${variant.sku}: ${err.message}`)
                }
            }

            logger.info("\n✅ Actualización completada")
        } else {
            logger.info("\n✅ DRY RUN COMPLETADO")
            logger.info("\n   Variantes que se actualizarían:\n")
            updates.forEach(({ variant, qbItem }) => {
                logger.info(`   • ${variant.sku} → QB_ID: ${qbItem.ListID}${qbItem.MPN ? `, MPN: ${qbItem.MPN}` : ''}`)
            })
            logger.info("\n   Para ejecutar:")
            logger.info("   DRY_RUN=false npx medusa exec ./src/scripts/fetch-missing-qb-ids.ts")
        }

    } catch (error: any) {
        logger.error(`\n❌ ERROR: ${error.message}`)
        throw error
    }
}
