import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import { getUPSRate } from "../ups-rate-cache"

// UPS Service Code: 01 = Next Day Air
const SERVICE_CODE = "01"
const SERVICE_NAME = "UPS Next Day Air®"
const FALLBACK_PRICE_CENTS = 6000 // $60.00

class UPSNextDayAirService extends AbstractFulfillmentProviderService {
    static identifier = "ups-next-day-air"

    async validateOption(_data: any): Promise<boolean> {
        return true
    }

    async validateFulfillmentData(_optionData: any, data: any, _context: any): Promise<any> {
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
        const cart = context?.id ? context : data?.cart

        if (!cart?.shipping_address?.postal_code) {
            return { calculated_amount: FALLBACK_PRICE_CENTS, is_calculated_price_tax_inclusive: false }
        }

        let totalWeight = (cart.items || []).reduce((acc: number, item: any) => {
            return acc + ((item.variant?.weight || 1) * item.quantity)
        }, 0)
        if (totalWeight < 0.1) totalWeight = 0.1

        const fromLocation = context?.from_location
        const fromAddress = fromLocation?.address

        try {
            const price = await getUPSRate(SERVICE_CODE, {
                cartId: cart.id,
                postalCode: cart.shipping_address.postal_code,
                totalWeight,
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

        console.warn(`⚠️  ${SERVICE_NAME}: using fallback $${(FALLBACK_PRICE_CENTS / 100).toFixed(2)}`)
        return { calculated_amount: FALLBACK_PRICE_CENTS, is_calculated_price_tax_inclusive: false }
    }

    async createFulfillment(_data: any, _items: any, _order: any, _fulfillment: any): Promise<any> {
        return { data: { method: `ups-${SERVICE_CODE}`, service: SERVICE_NAME, tracking_number: "" } }
    }

    async cancelFulfillment(_fulfillment: any): Promise<any> {
        return {}
    }

    async getFulfillmentOptions(): Promise<any[]> {
        return [{ id: `ups-next-day-air`, name: SERVICE_NAME }]
    }

    async retrieveDocuments(_fulfillmentData: any, _documentType: string): Promise<any> {
        return null
    }
}

export default UPSNextDayAirService
