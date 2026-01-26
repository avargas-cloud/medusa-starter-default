import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import axios from "axios"

export default async function testQbRequest({ container, args }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const sku = args[0] || "MG-M100L12DC"
    const apiUrl = "https://ecopower-qb.loca.lt/api/products"
    const apiKey = "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"

    logger.info(`🚀 Testing QuickBooks Bridge connection...`)
    logger.info(`   Target: ${sku}`)
    logger.info(`   URL: ${apiUrl}`)

    try {
        const response = await axios.get(apiUrl, {
            params: { FullName: sku },
            headers: {
                "x-api-key": apiKey,
                "bypass-tunnel-reminder": "true"
            }
        })

        logger.info("✅ Response received:")
        logger.info(JSON.stringify(response.data, null, 2))

        if (response.data.operationId) {
            const opId = response.data.operationId
            logger.info(`⏳ Operation queued with ID: ${opId}. Polling for results...`)

            let attempts = 0
            const maxAttempts = 10

            while (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 2000)) // Wait 2s
                attempts++

                const statusUrl = `https://ecopower-qb.loca.lt/api/sync/status/${opId}`
                const statusRes = await axios.get(statusUrl, {
                    headers: { "x-api-key": apiKey, "bypass-tunnel-reminder": "true" }
                })

                const op = statusRes.data.operation
                if (op && op.status === "completed") {
                    logger.info("✅ Operation completed!")

                    // The result is usually in op.result or we might need to parse qbxmlResponse
                    // Based on docs: $res.operation.qbxmlResponse
                    if (op.result) {
                        logger.info("📊 Result:")
                        logger.info(JSON.stringify(op.result, null, 2))

                        // Parse Deeply nested structure
                        // op.result.QBXML.QBXMLMsgsRs.ItemInventoryQueryRs.ItemInventoryRet
                        let items: any[] = []

                        try {
                            const queryRs = op.result?.QBXML?.QBXMLMsgsRs?.ItemInventoryQueryRs
                            if (queryRs) {
                                const ret = queryRs.ItemInventoryRet
                                if (Array.isArray(ret)) {
                                    items = ret
                                } else if (ret) {
                                    items = [ret]
                                }
                            }
                        } catch (e) {
                            logger.warn("Could not parse items from structure")
                        }

                        if (items.length > 0) {
                            const item = items[0]
                            logger.info("\n📊 Key Data (Extracted):")
                            logger.info(`   Name: ${item.Name}`)
                            logger.info(`   SalesPrice: ${item.SalesPrice}`)
                            logger.info(`   QuantityOnHand: ${item.QuantityOnHand}`)
                            logger.info(`   ListID: ${item.ListID}`)
                        } else {
                            logger.warn("\n⚠️ Did not find ItemInventoryRet in response")
                        }
                    } else {
                        logger.info("📜 Raw XML Response (Partial):")
                        logger.info(op.qbxmlResponse?.substring(0, 500))
                    }
                    return
                } else if (op && op.status === "failed") {
                    logger.error(`❌ Operation failed: ${op.error}`)
                    return
                }

                logger.info(`   ... Status: ${op?.status || 'unknown'} (Attempt ${attempts}/${maxAttempts})`)
            }
            logger.error("❌ Polling timed out")

        } else if (Array.isArray(response.data) && response.data.length > 0) {
            const item = response.data[0]
            logger.info("\n📊 Key Data:")
            logger.info(`   Name: ${item.Name}`)
            logger.info(`   SalesPrice: ${item.SalesPrice}`)
            logger.info(`   QuantityOnHand: ${item.QuantityOnHand}`)
            logger.info(`   ListID: ${item.ListID}`)
        } else {
            logger.warn("⚠️ No items returned and no operation ID found")
        }

    } catch (error: any) {
        logger.error("❌ Request failed:")
        if (error.response) {
            logger.error(`   Status: ${error.response.status}`)
            logger.error(`   Data: ${JSON.stringify(error.response.data)}`)
        } else {
            logger.error(`   Message: ${error.message}`)
        }
    }
}
