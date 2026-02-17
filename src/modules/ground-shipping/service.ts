import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

class GroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "custom-fulfillment"

    async validateOption(_data: any): Promise<boolean> {
        return true
    }

    async validateFulfillmentData(
        _optionData: any,
        data: any,
        _context: any
    ): Promise<any> {
        return data
    }

    async canCalculate(_data: any): Promise<boolean> {
        return true
    }

    async calculatePrice(
        _optionData: any,
        data: any,
        context: any
    ): Promise<{ calculated_amount: number; is_calculated_price_tax_inclusive: boolean }> {
        const { cart } = data

        if (!cart) {
            return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
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
            return { calculated_amount: 1499, is_calculated_price_tax_inclusive: false } // $14.99 in cents
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
            return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
        }

        // 2. Long item shipping if cart total < minimum AND has long items
        if (hasLongItems) {
            return { calculated_amount: settings.long_item_ground_shipping_price, is_calculated_price_tax_inclusive: false }
        }

        // 3. Regular flat shipping otherwise
        return { calculated_amount: settings.regular_ground_shipping_price, is_calculated_price_tax_inclusive: false }
    }

    async createFulfillment(
        _data: any,
        _items: any,
        _order: any,
        _fulfillment: any
    ): Promise<any> {
        return {
            data: {
                method: "ground-shipping"
            }
        }
    }

    async cancelFulfillment(_fulfillment: any): Promise<any> {
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
        _fulfillmentData: any,
        _documentType: string
    ): Promise<any> {
        return null
    }
}

export default GroundShippingService
