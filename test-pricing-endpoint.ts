// Quick test of pricing endpoint
const productId = 'product_01KGAX7RD0E6AS8JDARPEED795'
const backendUrl = 'http://localhost:9000'
const apiKey = 'pk_01JGXWCK77BB2P4FWKB9FKQHEE'

async function testPricing() {
    try {
        const response = await fetch(
            `${backendUrl}/store/products/${productId}/prices-and-stock`,
            {
                headers: {
                    'x-publishable-api-key': apiKey,
                    'Content-Type': 'application/json'
                }
            }
        )

        const data = await response.json()

        console.log('=== PRICING ENDPOINT RESPONSE ===')
        console.log(JSON.stringify(data, null, 2))

        if (data.variants && data.variants[0]) {
            console.log('\n=== FIRST VARIANT ===')
            console.log('variant_id:', data.variants[0].variant_id)
            console.log('price.amount:', data.variants[0].price.amount)
            console.log('price.formatted:', data.variants[0].price.formatted)
        }
    } catch (error: any) {
        console.error('ERROR:', error.message)
    }
}

testPricing()
