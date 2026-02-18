#!/usr/bin/env node

/**
 * UPS API Connection Test
 * Tests OAuth authentication and basic rate calculation
 */

const axios = require('axios');
require('dotenv').config();

const CLIENT_ID = process.env.UPS_CLIENT_ID;
const CLIENT_SECRET = process.env.UPS_CLIENT_SECRET;

async function testUPSConnection() {
    console.log('🔍 Testing UPS API Connection...\n');

    // Step 1: Test OAuth
    console.log('Step 1: Testing OAuth Authentication');
    console.log('Client ID:', CLIENT_ID ? `${CLIENT_ID.substring(0, 10)}...` : 'MISSING');
    console.log('Client Secret:', CLIENT_SECRET ? `${CLIENT_SECRET.substring(0, 10)}...` : 'MISSING');

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.error('❌ ERROR: UPS credentials not found in .env file');
        process.exit(1);
    }

    try {
        const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

        const tokenResponse = await axios.post(
            'https://onlinetools.ups.com/security/v1/oauth/token',
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        console.log('✅ OAuth SUCCESS');
        console.log('Access Token:', tokenResponse.data.access_token.substring(0, 20) + '...');
        console.log('Expires in:', tokenResponse.data.expires_in, 'seconds\n');

        // Step 2: Test Rate Calculation
        console.log('Step 2: Testing Rate Calculation API');

        const rateRequest = {
            RateRequest: {
                Request: {
                    SubVersion: '1707',
                    TransactionReference: {
                        CustomerContext: 'Test Rate Request'
                    }
                },
                Shipment: {
                    Shipper: {
                        Name: 'Ecopowertech',
                        ShipperNumber: '',
                        Address: {
                            AddressLine: ['9876 SW 54th St'],
                            City: 'Miami',
                            StateProvinceCode: 'FL',
                            PostalCode: '33165',
                            CountryCode: 'US'
                        }
                    },
                    ShipTo: {
                        Name: 'Test Customer',
                        Address: {
                            AddressLine: ['Unique Street'],
                            City: 'The Villages',
                            StateProvinceCode: 'FL',
                            PostalCode: '32163',
                            CountryCode: 'US'
                        }
                    },
                    ShipFrom: {
                        Name: 'Ecopowertech',
                        Address: {
                            AddressLine: ['9876 SW 54th St'],
                            City: 'Miami',
                            StateProvinceCode: 'FL',
                            PostalCode: '33165',
                            CountryCode: 'US'
                        }
                    },
                    Service: {
                        Code: '01', // Next Day Air
                        Description: 'Next Day Air'
                    },
                    Package: [{
                        PackagingType: {
                            Code: '02',
                            Description: 'Package'
                        },
                        Dimensions: {
                            UnitOfMeasurement: {
                                Code: 'IN',
                                Description: 'Inches'
                            },
                            Length: '12',
                            Width: '12',
                            Height: '12'
                        },
                        PackageWeight: {
                            UnitOfMeasurement: {
                                Code: 'LBS',
                                Description: 'Pounds'
                            },
                            Weight: '10.0'
                        }
                    }]
                }
            }
        };

        const rateResponse = await axios.post(
            'https://onlinetools.ups.com/api/rating/v1/Rate',
            rateRequest,
            {
                headers: {
                    'Authorization': `Bearer ${tokenResponse.data.access_token}`,
                    'Content-Type': 'application/json',
                    'transId': `test_${Date.now()}`,
                    'transactionSrc': 'test'
                }
            }
        );

        console.log('✅ Rate Calculation SUCCESS');

        const ratedShipment = rateResponse.data.RateResponse.RatedShipment;
        if (Array.isArray(ratedShipment)) {
            console.log(`Found ${ratedShipment.length} rate(s):`);
            ratedShipment.forEach((rate, i) => {
                console.log(`  Rate ${i + 1}: $${rate.TotalCharges.MonetaryValue} ${rate.TotalCharges.CurrencyCode}`);
            });
        } else {
            console.log(`Rate: $${ratedShipment.TotalCharges.MonetaryValue} ${ratedShipment.TotalCharges.CurrencyCode}`);
        }

        console.log('\n✅ ALL TESTS PASSED - UPS API is working correctly!');

    } catch (error) {
        console.error('\n❌ ERROR:', error.response?.data || error.message);
        if (error.response?.data) {
            console.error('Full error:', JSON.stringify(error.response.data, null, 2));
        }
        process.exit(1);
    }
}

testUPSConnection();
