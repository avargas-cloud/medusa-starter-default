/**
 * Create Service Products
 * 
 * This script creates service products (Assembly, Installation, Consulting, etc.)
 * with Product Type = "Service"
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export default async function createServices({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModuleService = container.resolve(Modules.PRODUCT)

    logger.info("🛠️  Creating Service Products...")

    try {
        // Get the "Service" Product Type
        const { data: productTypes } = await query.graph({
            entity: "product_type",
            fields: ["id", "value"],
            filters: { value: "Service" },
        })

        const serviceType = productTypes[0]

        if (!serviceType) {
            throw new Error("Product Type 'Service' not found. Please run restructure-product-types.ts first.")
        }

        logger.info(`✓ Found Service Product Type (ID: ${serviceType.id})`)

        // Define services to create
        const services = [
            {
                title: "Assembly - Panels",
                handle: "assembly-panels",
                description: `This is a service charge for product assembly.

**Scope of Work:**
- Professional assembly of LED panel products
- Quality inspection after assembly
- Testing of electrical connections

**Lead Time:**
- Standard: 2-3 business days
- Rush service available upon request

**Additional Notes:**
- Service charge is per panel
- Panels must be purchased separately
- On-site assembly available in select areas`,
                status: "published",
                type_id: serviceType.id,
                metadata: {
                    service_category: "Assembly",
                    unit_of_measure: "U/M",
                    billable: true,
                    requires_scheduling: true,
                },
                // Create a variant with $0 default price (configurable per quote)
                variants: [
                    {
                        title: "Standard Assembly",
                        sku: "SVC-ASSEMBLY-PANELS",
                        manage_inventory: false,
                        prices: [
                            {
                                amount: 0, // $0 - quote-based pricing
                                currency_code: "usd",
                            }
                        ],
                    }
                ]
            },
            // Add more services here as you provide screenshots
        ]

        logger.info(`\n📋 Creating ${services.length} service(s)...`)

        const createdServices: any[] = []

        for (const service of services) {
            try {
                // Check if service already exists
                const { data: existingProducts } = await query.graph({
                    entity: "product",
                    fields: ["id", "title", "handle"],
                    filters: { handle: service.handle },
                })

                if (existingProducts.length > 0) {
                    logger.info(`  ⚠️  Service "${service.title}" already exists (Handle: ${service.handle})`)
                    continue
                }

                // Create the service product
                const [created] = await productModuleService.createProducts([service])

                logger.info(`  ✓ Created "${service.title}" (ID: ${created.id})`)
                createdServices.push(created)

            } catch (error: any) {
                logger.error(`  ✗ Failed to create "${service.title}": ${error.message}`)
            }
        }

        logger.info("\n" + "=".repeat(60))
        logger.info("✅ SERVICE CREATION COMPLETE!")
        logger.info("=".repeat(60))
        logger.info(`📊 Services created: ${createdServices.length}`)
        logger.info("=".repeat(60))

        if (createdServices.length > 0) {
            logger.info("\n📝 Created Services:")
            createdServices.forEach((svc: any) => {
                logger.info(`  - ${svc.title} (${svc.handle})`)
            })
        }

        return {
            success: true,
            servicesCreated: createdServices.length,
            services: createdServices.map((s: any) => ({
                id: s.id,
                title: s.title,
                handle: s.handle,
            })),
        }

    } catch (error: any) {
        logger.error(`❌ Error creating services: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
