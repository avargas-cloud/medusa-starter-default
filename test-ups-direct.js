const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ connectionString: process.env.DATABASE_URL });

(async () => {
    await client.connect();

    console.log('🔍 Getting a real cart with shipping address...\n');

    // Get the most recent cart with a shipping address
    const cartResult = await client.query(`
    SELECT 
      c.id,
      c.email,
      c.shipping_address_id,
      sa.address_1,
      sa.city,
      sa.province,
      sa.postal_code,
      sa.country_code
    FROM cart c
    LEFT JOIN address sa ON c.shipping_address_id = sa.id
    WHERE c.shipping_address_id IS NOT NULL
    ORDER BY c.created_at DESC
    LIMIT 1
  `);

    if (cartResult.rows.length === 0) {
        console.log('❌ No cart with shipping address found!');
        await client.end();
        return;
    }

    const cart = cartResult.rows[0];
    console.log('Found cart:', {
        id: cart.id,
        email: cart.email,
        address: `${cart.city}, ${cart.province} ${cart.postal_code}`
    });

    // Get cart items
    const itemsResult = await client.query(`
    SELECT 
      li.id,
      li.quantity,
      li.variant_id,
      pv.title as variant_title,
      pv.weight
    FROM line_item li
    JOIN product_variant pv ON li.variant_id = pv.id
    WHERE li.cart_id = $1
  `, [cart.id]);

    console.log('\nCart items:');
    console.table(itemsResult.rows);

    // Calculate total weight
    let totalWeight = 0;
    for (const item of itemsResult.rows) {
        const weight = item.weight || 1;
        totalWeight += weight * item.quantity;
    }

    console.log(`\n📦 Total weight: ${totalWeight} lbs`);
    console.log(`📍 Destination: ${cart.city}, ${cart.province} ${cart.postal_code}, ${cart.country_code}`);

    await client.end();

    console.log('\n✅ Cart data retrieved. Now testing UPS API call...\n');

    // Import and test the UPS service directly
    const axios = require('axios');

    // Get UPS token
    const tokenResponse = await axios.post(
        'https://onlinetools.ups.com/security/v1/oauth/token',
        new URLSearchParams({
            grant_type: 'client_credentials'
        }),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString('base64')}`
            }
        }
    );

    const token = tokenResponse.data.access_token;
    console.log('✅ Got UPS access token');

    // Make rate request
    const rateRequest = {
        RateRequest: {
            Request: {
                TransactionReference: {
                    CustomerContext: "Test Rate Request"
                }
            },
            Shipment: {
                Shipper: {
                    Name: process.env.UPS_SHIPPER_NAME,
                    Address: {
                        AddressLine: [process.env.UPS_SHIPPER_ADDRESS_LINE1],
                        City: process.env.UPS_SHIPPER_CITY,
                        StateProvinceCode: process.env.UPS_SHIPPER_STATE,
                        PostalCode: process.env.UPS_SHIPPER_POSTAL_CODE,
                        CountryCode: process.env.UPS_SHIPPER_COUNTRY
                    }
                },
                ShipTo: {
                    Name: "Test Customer",
                    Address: {
                        AddressLine: [cart.address_1],
                        City: cart.city,
                        StateProvinceCode: cart.province,
                        PostalCode: cart.postal_code,
                        CountryCode: cart.country_code?.toUpperCase()
                    }
                },
                Service: {
                    Code: "01", // UPS Next Day Air
                    Description: "Next Day Air"
                },
                Package: [{
                    PackagingType: {
                        Code: "02",
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
    };

    console.log('\n📤 Sending UPS rate request...');

    try {
        const rateResponse = await axios.post(
            'https://onlinetools.ups.com/api/rating/v1/Rate',
            rateRequest,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'transId': `test_${Date.now()}`,
                    'transactionSrc': 'testing'
                }
            }
        );

        const charge = rateResponse.data.RateResponse.RatedShipment[0].TotalCharges;
        console.log('\n✅ UPS API SUCCESS!');
        console.log(`💰 Shipping cost: $${charge.MonetaryValue} ${charge.CurrencyCode}`);
        console.log(`📦 Service: UPS Next Day Air`);

    } catch (error) {
        console.error('\n❌ UPS API ERROR:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error(error.message);
        }
    }
})();
