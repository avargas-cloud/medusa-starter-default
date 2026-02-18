import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

class GroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "ground-shipping"
    protected options_: GroundShippingOptions

    // Hardcoded service details
    private readonly serviceCode = "GROUND"
    private readonly serviceName = "Ground Shipping"

    constructor(options: GroundShippingOptions) {
        super()
        this.options_ = options
    }

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

    /**
     * Delegate to UPS Ground provider for rate calculation
     * This is called when override_ups_ground = false
     */
    private async calculateUPSGroundRate(
        data: any,
        context: any
    ): Promise<{ calculated_amount: number; is_calculated_price_tax_inclusive: boolean }> {
        try {
            // Resolve the UPS Ground fulfillment provider from the container
            const fulfillmentModuleService = context.container.resolve("fulfillment")

            // Get the ups-ground provider
            const providers = await fulfillmentModuleService.listFulfillmentProviders()
            const upsGroundProvider = providers.find((p: any) => p.id === "ups-ground")

            if (!upsGroundProvider) {
                console.error("UPS Ground provider not found, using fallback price")
                return { calculated_amount: 1500, is_calculated_price_tax_inclusive: false }
            }

            // Calculate the rate using UPS Ground provider
            const rate = await fulfillmentModuleService.calculateShippingOptionPrice(
                {
                    provider_id: "ups-ground",
                    data: {},
                },
                data,
                context
            )

            return {
                calculated_amount: rate.calculated_amount,
                is_calculated_price_tax_inclusive: rate.is_calculated_price_tax_inclusive || false
            }
        } catch (error) {
            console.error("Error calculating UPS Ground rate:", error)
            // Fallback to $15.00 if UPS API fails
            return { calculated_amount: 1500, is_calculated_price_tax_inclusive: false }
        }
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
                "long_item_ground_shipping_price",
                "override_ups_ground"
            ]
        })

        const settings = settingsData?.[0]
        if (!settings) {
            // Default values if settings not found - use UPS native Ground
            // This fallback delegates to UPS Ground provider
            return await this.calculateUPSGroundRate(data, context)
        }

        // Check override flag - if false, use UPS native Ground
        if (!settings.override_ups_ground) {
            console.log("Ground Shipping: override_ups_ground = false, delegating to UPS Ground")
            return await this.calculateUPSGroundRate(data, context)
        }

        // Override is enabled - use custom pricing logic
        console.log("Ground Shipping: override_ups_ground = true, using custom pricing")

        // Get cart total (already in cents in Medusa v2)
        const cartTotal = cart.total || 0

        // Check if any item has "long" shipping profile
        const hasLongItems = cart.items?.some((item: any) => {
            return item.variant?.product?.shipping_profile?.type === "long"
        }) || false

        // Apply conditional pricing logic
        console.log("\n🟢 Ground Shipping Pricing Logic:", {
            cartTotal,
            freeShippingMinimum: settings.free_shipping_minimum,
            isFreeShipping: cartTotal >= settings.free_shipping_minimum,
            hasLongItems,
            regularPrice: settings.regular_ground_shipping_price,
            longItemPrice: settings.long_item_ground_shipping_price
        })

        // 1. Free shipping if cart total >= free_shipping_minimum
        if (cartTotal >= settings.free_shipping_minimum) {
            console.log("✅ Ground Shipping: FREE (cart total >= minimum)")
            return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
        }

        // 2. Long item shipping if cart total < minimum AND has long items
        if (hasLongItems) {
            console.log("📦 Ground Shipping: LONG ITEM PRICE")
            return { calculated_amount: settings.long_item_ground_shipping_price, is_calculated_price_tax_inclusive: false }
        }

        // 3. Regular flat shipping otherwise
        console.log("🚢 Ground Shipping: REGULAR PRICE")
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
