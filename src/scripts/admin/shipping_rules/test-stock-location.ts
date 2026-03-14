/**
 * Test script: Verify Stock Location address can be read from Medusa DB
 * Run with: npx ts-node scripts/test-stock-location.ts
 */

import pg from "pg"
import * as dotenv from "dotenv"
const { Client } = pg

dotenv.config()

async function testStockLocation() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        await client.connect()
        console.log("✅ Connected to DB\n")

        // Query stock locations with their addresses
        const result = await client.query(`
            SELECT 
                sl.id,
                sl.name,
                sla.address_1,
                sla.address_2,
                sla.city,
                sla.province,
                sla.postal_code,
                sla.country_code,
                sla.phone
            FROM stock_location sl
            LEFT JOIN stock_location_address sla ON sl.address_id = sla.id
            WHERE sl.deleted_at IS NULL
            ORDER BY sl.created_at ASC
        `)

        if (result.rows.length === 0) {
            console.log("❌ No stock locations found!")
            return
        }

        console.log(`Found ${result.rows.length} stock location(s):\n`)

        for (const row of result.rows) {
            console.log(`📍 Location: ${row.name} (${row.id})`)
            console.log(`   Address:  ${row.address_1}`)
            if (row.address_2) console.log(`   Address2: ${row.address_2}`)
            console.log(`   City:     ${row.city}`)
            console.log(`   State:    ${row.province}`)
            console.log(`   ZIP:      ${row.postal_code}`)
            console.log(`   Country:  ${row.country_code?.toUpperCase()}`)
            console.log(`   Phone:    ${row.phone || 'N/A'}`)
            console.log()

            // Simulate what the UPS module will do
            const shipperName = row.name
            const shipperAddress = row.address_1
            const shipperCity = row.city
            const shipperState = row.province
            const shipperZip = row.postal_code
            const shipperCountry = row.country_code?.toUpperCase()

            const allPresent = shipperName && shipperAddress && shipperCity && shipperState && shipperZip && shipperCountry

            if (allPresent) {
                console.log(`✅ All required UPS shipper fields present for "${row.name}"`)
                console.log(`   → UPS Rate API will use: ${shipperName}, ${shipperAddress}, ${shipperCity} ${shipperState} ${shipperZip} ${shipperCountry}`)
            } else {
                console.log(`⚠️  Missing fields for "${row.name}":`)
                if (!shipperName) console.log("   ❌ name")
                if (!shipperAddress) console.log("   ❌ address_1")
                if (!shipperCity) console.log("   ❌ city")
                if (!shipperState) console.log("   ❌ province (state)")
                if (!shipperZip) console.log("   ❌ postal_code")
                if (!shipperCountry) console.log("   ❌ country_code")
            }
        }

        // Also check env var fallbacks
        console.log("\n--- ENV VAR FALLBACKS ---")
        const envVars = {
            UPS_ORIGIN_NAME: process.env.UPS_ORIGIN_NAME,
            UPS_ORIGIN_ADDRESS: process.env.UPS_ORIGIN_ADDRESS,
            UPS_ORIGIN_CITY: process.env.UPS_ORIGIN_CITY,
            UPS_ORIGIN_STATE: process.env.UPS_ORIGIN_STATE,
            UPS_ORIGIN_ZIP: process.env.UPS_ORIGIN_ZIP,
            UPS_ORIGIN_COUNTRY: process.env.UPS_ORIGIN_COUNTRY,
            UPS_SHIPPER_NUMBER: process.env.UPS_SHIPPER_NUMBER,
        }
        for (const [key, val] of Object.entries(envVars)) {
            console.log(`${val ? "✅" : "❌"} ${key}: ${val || "NOT SET"}`)
        }

    } catch (err) {
        console.error("❌ Error:", err)
    } finally {
        await client.end()
    }
}

testStockLocation()
