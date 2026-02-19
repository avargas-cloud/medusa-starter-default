import axios from "axios"
import { PackageSpec } from "./box-packing"

interface CachedRates {
    rates: Record<string, number> // serviceCode -> price in cents
    timestamp: number
}

interface ShopRateRequest {
    cartId: string
    postalCode: string
    packages: PackageSpec[]   // one or more packages (from box-packing)
    shipperZip: string
    shipperAddress: string
    shipperCity: string
    shipperState: string
    shipperCountry: string
    shipperName: string
    shipToName: string
    shipToAddress: string
    shipToCity: string
    shipToState: string
    shipToCountry: string
}

// Singleton cache — shared across all UPS provider instances in the same Node.js process
const rateCache = new Map<string, CachedRates>()
const CACHE_TTL_MS = 30_000 // 30 seconds

// Singleton OAuth token — shared across all providers
let sharedAccessToken: string | null = null
let sharedTokenExpiry: number = 0

// In-flight promise deduplication — if multiple providers call simultaneously, only one HTTP request fires
const inFlightRequests = new Map<string, Promise<Record<string, number>>>()

function getCacheKey(cartId: string, postalCode: string, pkgCount: number): string {
    return `${cartId}:${postalCode}:${pkgCount}`
}

async function getAccessToken(): Promise<string> {
    if (sharedAccessToken && Date.now() < sharedTokenExpiry) {
        return sharedAccessToken
    }

    const clientId = process.env.UPS_CLIENT_ID!
    const clientSecret = process.env.UPS_CLIENT_SECRET!
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")

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

    sharedAccessToken = response.data.access_token
    sharedTokenExpiry = Date.now() + (3500 * 1000) // cache for 3500s (token valid 3600s)
    return sharedAccessToken!
}

async function fetchShopRates(req: ShopRateRequest): Promise<Record<string, number>> {
    const token = await getAccessToken()

    const totalWeight = req.packages.reduce((s, p) => s + p.weight, 0)
    console.log(`🚀 UPS Shop API — cart ${req.cartId} → ${req.postalCode} | ${req.packages.length} pkg(s), ${totalWeight.toFixed(2)}lbs total`)

    const shopRequest = {
        RateRequest: {
            Request: {
                TransactionReference: { CustomerContext: "Shop Rate Request" }
            },
            Shipment: {
                Shipper: {
                    Name: req.shipperName,
                    ShipperNumber: process.env.UPS_SHIPPER_NUMBER || "",
                    Address: {
                        AddressLine: [req.shipperAddress],
                        City: req.shipperCity,
                        StateProvinceCode: req.shipperState,
                        PostalCode: req.shipperZip,
                        CountryCode: req.shipperCountry
                    }
                },
                ShipTo: {
                    Name: req.shipToName,
                    Address: {
                        AddressLine: [req.shipToAddress],
                        City: req.shipToCity,
                        StateProvinceCode: req.shipToState,
                        PostalCode: req.postalCode,
                        CountryCode: req.shipToCountry
                    }
                },
                // Multiple packages — UPS sums the cost of all packages
                Package: req.packages.map(pkg => ({
                    PackagingType: { Code: "02", Description: "Package" },
                    PackageWeight: {
                        UnitOfMeasurement: { Code: "LBS", Description: "Pounds" },
                        Weight: pkg.weight.toFixed(2)
                    },
                    Dimensions: {
                        UnitOfMeasurement: { Code: "IN", Description: "Inches" },
                        Length: pkg.length.toFixed(2),
                        Width: pkg.width.toFixed(2),
                        Height: pkg.height.toFixed(2)
                    }
                }))
            }
        }
    }

    // Use /Shop endpoint — returns ALL services in one call
    const response = await axios.post(
        "https://onlinetools.ups.com/api/rating/v1/Shop",
        shopRequest,
        {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "transId": `shop_${Date.now()}`,
                "transactionSrc": "medusa"
            }
        }
    )

    const ratedShipments = response.data.RateResponse?.RatedShipment || []
    const rates: Record<string, number> = {}

    for (const shipment of ratedShipments) {
        const serviceCode = shipment.Service?.Code
        if (!serviceCode) continue

        const rateStr =
            shipment.NegotiatedRateCharges?.TotalCharge?.MonetaryValue ||
            shipment.TotalCharges?.MonetaryValue ||
            "0"

        rates[serviceCode] = Math.round(parseFloat(rateStr) * 100) // store in cents
    }

    console.log(`✅ UPS Shop returned ${Object.keys(rates).length} services:`, rates)
    return rates
}

/**
 * Get UPS rate for a specific service code.
 * Uses shared cache — only 1 HTTP call per cart+zip+pkgCount combo within 30 seconds.
 */
export async function getUPSRate(serviceCode: string, req: ShopRateRequest): Promise<number | null> {
    const cacheKey = getCacheKey(req.cartId, req.postalCode, req.packages.length)

    // Check cache first
    const cached = rateCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        const price = cached.rates[serviceCode]
        console.log(`📦 UPS cache hit for ${serviceCode} (cart ${req.cartId}): ${price} cents`)
        return price ?? null
    }

    // Deduplicate in-flight requests — if another provider is already fetching, wait for it
    if (!inFlightRequests.has(cacheKey)) {
        const promise = fetchShopRates(req)
            .then(rates => {
                rateCache.set(cacheKey, { rates, timestamp: Date.now() })
                inFlightRequests.delete(cacheKey)
                return rates
            })
            .catch(err => {
                inFlightRequests.delete(cacheKey)
                throw err
            })
        inFlightRequests.set(cacheKey, promise)
    }

    const rates = await inFlightRequests.get(cacheKey)!
    return rates[serviceCode] ?? null
}
