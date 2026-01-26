import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function checkFields({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["*"],
        filters: {}
    })

    if (variants.length > 0) {
        logger.info("Variant Fields:")
        logger.info(Object.keys(variants[0]).join(", "))
    } else {
        logger.info("No variants found")
    }
}
