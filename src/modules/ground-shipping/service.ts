import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { MedusaContainer } from "@medusajs/framework/types"

class GroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "custom-fulfillment"

    constructor(container: MedusaContainer, options: any) {
        super(container, options)
    }

    async validateOption(data: any): Promise<boolean> {
        return true
    }

    async validateFulfillmentData(
        optionData: any,
        data: any,
        context: any
    ): Promise<any> {
        return data
    }

    async canCalculate(data: any): Promise<boolean> {
        return true
    }

    async calculatePrice(
        optionData: any,
        data: any,
        context: any
    ): Promise<number> {
        const { cart } = data

        if (!cart) {
            return 0
        }

        // Get shipping settings from database
        const query = context.container.resolve("query")
        const { data: settingsData } = await query.graph({
            entity: "shipping_settings",
            fields: [
                "free_shipping_minimum",
                "regular_ground_shipping_price",
                "long_item_ground_shipping_price"
            ]
        })

        const settings = settingsData?.[0]
        if (!settings) {
            // Default values if settings not found
            return 1499 // $14.99 in cents
        }

        // Get cart total (already in cents in Medusa v2)
        const cartTotal = cart.total || 0

        // Check if any item has "long" shipping profile
        const hasLongItems = cart.items?.some((item: any) => {
            return item.variant?.product?.shipping_profile?.type === "long"
        }) || false

        // Apply conditional pricing logic
        // 1. Free shipping if cart total >= free_shipping_minimum
        if (cartTotal >= settings.free_shipping_minimum) {
            return 0
        }

        // 2. Long item shipping if cart total < minimum AND has long items
        if (hasLongItems) {
            return settings.long_item_ground_shipping_price
        }

        // 3. Regular flat shipping otherwise
        return settings.regular_ground_shipping_price
    }

    async createFulfillment(
        data: any,
        items: any,
        order: any,
        fulfillment: any
    ): Promise<any> {
        return {
            data: {
                method: "ground-shipping"
            }
        }
    }

    async cancelFulfillment(fulfillment: any): Promise<any> {
        return {}
    }

    async getFulfillmentOptions(): Promise<any[]> {
        return [
            {
                id: "ground-shipping",
                name: "Ground Shipping",
            }
        ]
    }

    async retrieveDocuments(
        fulfillmentData: any,
        documentType: string
    ): Promise<any> {
        return null
    }
}

export default GroundShippingService
