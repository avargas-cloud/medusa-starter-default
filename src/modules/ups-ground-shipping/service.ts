import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"
import axios from "axios"

type UPSOptions = {
    clientId: string
    clientSecret: string
    serviceCode: string
    serviceName: string
    shipperName: string
    shipperAddressLine1: string
    shipperCity: string
    shipperState: string
    shipperPostalCode: string
    shipperCountry: string
}

class UPSGroundShippingService extends AbstractFulfillmentProviderService {
    static identifier = "ups-ground"
    protected options_: UPSOptions
    private accessToken: string | null = null
    private tokenExpiry: number = 0

    // Hardcoded service details to avoid Awilix resolution issues
    private readonly serviceCode = "03"
    private readonly serviceName = "Ground"

    constructor(options: UPSOptions) {
        super()
        this.options_ = options
    }

    /**
     * Get OAuth access token from UPS
     */
    private async getAccessToken(): Promise<string> {
        // Return cached token if still valid
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken
        }

        const clientId = process.env.UPS_CLIENT_ID!
        const clientSecret = process.env.UPS_CLIENT_SECRET!
        const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")

        try {
            const response = await axios.post(
                "https://onlinetools.ups.com/security/v1/oauth/token",
                "grant_type=client_credentials",
                {
                    headers: {
                        "Authorization": `Basic ${auth}`,
                        "Content-Type": "application/x-www-form-urlencoded"
                    }
                }
            )

            this.accessToken = response.data.access_token
            // Token expires in 3600 seconds, cache for 3500 to be safe
            this.tokenExpiry = Date.now() + (3500 * 1000)

            return this.accessToken!
        } catch (error: any) {
            console.error("UPS OAuth error:", error.response?.data || error.message)
            throw new Error("Failed to authenticate with UPS API")
        }
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

    async canCalculate(data: any): Promise<boolean> {
        return Boolean(data.cart?.shipping_address)
    }

    async calculatePrice(
        _optionData: any,
        data: any,
        context: any
    ): Promise<{ calculated_amount: number; is_calculated_price_tax_inclusive: boolean }> {
        // Medusa passes cart spread into context (not data.cart)
        const cart = context?.id ? context : data?.cart
        const serviceCode = this.serviceCode

        // Start logging for debugging
        console.log("UPS calculatePrice called with:", {
            hasCart: !!cart,
            hasAddress: !!cart?.shipping_address,
            serviceCode,
            cartId: cart?.id
        })

        // If no cart or address (e.g. Admin UI validation), return a dummy price to pass validation
        if (!cart?.shipping_address) {
            console.log("UPS: No cart/address, returning fallback price for validation")
            return { calculated_amount: 2500, is_calculated_price_tax_inclusive: false } // Return $25.00 as placeholder
        }

        // Calculate total weight from cart items
        let totalWeight = 0
        for (const item of cart.items || []) {
            const weight = item.variant?.weight || 1 // Default 1 lb if not set
            totalWeight += weight * item.quantity
        }

        // Minimum weight for UPS is 0.1 lbs
        if (totalWeight < 0.1) {
            totalWeight = 0.1
        }

        try {
            const token = await this.getAccessToken()

            // Read shipper address from Stock Location (from_location in context) with env fallback
            const fromLocation = context?.from_location
            const fromAddress = fromLocation?.address
            const shipperName = fromLocation?.name || process.env.UPS_ORIGIN_NAME
            const shipperAddress = fromAddress?.address_1 || process.env.UPS_ORIGIN_ADDRESS
            const shipperCity = fromAddress?.city || process.env.UPS_ORIGIN_CITY
            const shipperState = fromAddress?.province || process.env.UPS_ORIGIN_STATE
            const shipperZip = fromAddress?.postal_code || process.env.UPS_ORIGIN_ZIP
            const shipperCountry = fromAddress?.country_code?.toUpperCase() || process.env.UPS_ORIGIN_COUNTRY

            const rateRequest = {
                RateRequest: {
                    Request: {
                        TransactionReference: {
                            CustomerContext: "Rate Request"
                        }
                    },
                    Shipment: {
                        Shipper: {
                            Name: shipperName,
                            ShipperNumber: process.env.UPS_SHIPPER_NUMBER || "",
                            Address: {
                                AddressLine: [shipperAddress],
                                City: shipperCity,
                                StateProvinceCode: shipperState,
                                PostalCode: shipperZip,
                                CountryCode: shipperCountry
                            }
                        },
                        ShipTo: {
                            Name: cart.shipping_address.company || cart.shipping_address.first_name,
                            Address: {
                                AddressLine: [cart.shipping_address.address_1],
                                City: cart.shipping_address.city,
                                StateProvinceCode: cart.shipping_address.province,
                                PostalCode: cart.shipping_address.postal_code,
                                CountryCode: cart.shipping_address.country_code?.toUpperCase()
                            }
                        },
                        Service: {
                            Code: this.serviceCode,
                            Description: this.serviceName
                        },
                        Package: [{
                            PackagingType: {
                                Code: "02", // Customer Supplied Package
                                Description: "Package"
                            },
                            PackageWeight: {
                                UnitOfMeasurement: {
                                    Code: "LBS",
                                    Description: "Pounds"
                                },
                                Weight: totalWeight.toFixed(1)
                            }
                        }]
                    }
                }
            }

            const response = await axios.post(
                "https://onlinetools.ups.com/api/rating/v1/Rate",
                rateRequest,
                {
                    headers: {
                        "Authorization": `Bearer ${token}`,
                        "Content-Type": "application/json",
                        "transId": `rate_${Date.now()}`,
                        "transactionSrc": "medusa"
                    },
                }
            )

            const ratedShipment = response.data.RateResponse?.RatedShipment
            if (!ratedShipment) {
                throw new Error("No rate returned from UPS")
            }

            // Try to get negotiated rate first, fallback to published rate
            const rateStr =
                ratedShipment.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ||
                ratedShipment.TotalCharges?.MonetaryValue ||
                "0"

            const rate = parseFloat(rateStr)

            // Return price in cents
            return { calculated_amount: Math.round(rate * 100), is_calculated_price_tax_inclusive: false }

        } catch (error: any) {
            console.error("UPS Rate API error:", error.response?.data || error.message)

            // Do NOT use fallback prices — rethrow so Medusa excludes this option.
            throw error
        }
    }

    async createFulfillment(
        _data: any,
        _items: any,
        _order: any,
        _fulfillment: any
    ): Promise<any> {
        // TODO: Implement shipping label generation
        return {
            data: {
                method: `ups-${this.serviceCode}`,
                service: this.serviceName,
                tracking_number: ""
            }
        }
    }

    async cancelFulfillment(_fulfillment: any): Promise<any> {
        // TODO: Implement shipment cancellation if needed
        return {}
    }

    async getFulfillmentOptions(): Promise<any[]> {
        return [
            {
                id: `ups-${this.serviceCode}`,
                name: this.serviceName,
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

export default UPSGroundShippingService
