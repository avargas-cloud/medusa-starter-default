import { AbstractFulfillmentProviderService } from "@medusajs/utils"
import { getUPSRate } from "../ups-rate-cache"
import { packItems } from "../box-packing"

// UPS Service Code: 12 = 3 Day Select
const SERVICE_CODE = "12"
const SERVICE_NAME = "UPS 3 Day Select®"

class UPS3DaySelectService extends AbstractFulfillmentProviderService {
    static identifier = "ups-3-day-select"

    async validateOption(_data: any): Promise<boolean> { return true }
    async validateFulfillmentData(_optionData: any, data: any, _context: any): Promise<any> { return data }
    async canCalculate(_data: any): Promise<boolean> { return true }

    async calculatePrice(
        _optionData: any,
        data: any,
        context: any
    ): Promise<{ calculated_amount: number; is_calculated_price_tax_inclusive: boolean }> {
        const cart = context?.id ? context : data?.cart

        if (!cart?.shipping_address?.postal_code) {
            // No postal code yet — cart is in early state, silently skip
            return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
        }

        const rawItems = (cart.items || []).map((item: any) => {
            const inv = item.variant?.inventory_items?.[0]?.inventory_item
            return {
                weight: parseFloat(inv?.weight ?? item.variant?.weight ?? 1),
                length: parseFloat(inv?.length ?? item.variant?.length ?? 1),
                width: parseFloat(inv?.width ?? item.variant?.width ?? 1),
                height: parseFloat(inv?.height ?? item.variant?.height ?? 1),
                quantity: item.quantity || 1,
            }
        })

        const packages = packItems(rawItems)

        const fromLocation = context?.from_location
        const fromAddress = fromLocation?.address

        try {
            const price = await getUPSRate(SERVICE_CODE, {
                cartId: cart.id,
                postalCode: cart.shipping_address.postal_code,
                packages,
                shipperName: fromLocation?.name || process.env.UPS_ORIGIN_NAME || "",
                shipperAddress: fromAddress?.address_1 || process.env.UPS_ORIGIN_ADDRESS || "",
                shipperCity: fromAddress?.city || process.env.UPS_ORIGIN_CITY || "",
                shipperState: fromAddress?.province || process.env.UPS_ORIGIN_STATE || "",
                shipperZip: fromAddress?.postal_code || process.env.UPS_ORIGIN_ZIP || "",
                shipperCountry: fromAddress?.country_code?.toUpperCase() || process.env.UPS_ORIGIN_COUNTRY || "US",
                shipToName: cart.shipping_address.company || cart.shipping_address.first_name || "",
                shipToAddress: cart.shipping_address.address_1 || "",
                shipToCity: cart.shipping_address.city || "",
                shipToState: cart.shipping_address.province || "",
                shipToCountry: cart.shipping_address.country_code?.toUpperCase() || "US",
            })

            if (price !== null) {
                console.log(`✅ ${SERVICE_NAME}: $${(price / 100).toFixed(2)}`)
                return { calculated_amount: price, is_calculated_price_tax_inclusive: false }
            }
        } catch (err: any) {
            console.error(`❌ ${SERVICE_NAME} rate error:`, err.message)
        }

        // Rate unavailable — return 0 so Medusa hides this option gracefully
        return { calculated_amount: 0, is_calculated_price_tax_inclusive: false }
    }

    async createFulfillment(_data: any, _items: any, _order: any, _fulfillment: any): Promise<any> {
        return { data: { method: `ups-${SERVICE_CODE}`, service: SERVICE_NAME, tracking_number: "" } }
    }
    async cancelFulfillment(_fulfillment: any): Promise<any> { return {} }
    async getFulfillmentOptions(): Promise<any[]> { return [{ id: `ups-3-day-select`, name: SERVICE_NAME }] }
    async retrieveDocuments(_fulfillmentData: any, _documentType: string): Promise<any> { return null }
}

export default UPS3DaySelectService
