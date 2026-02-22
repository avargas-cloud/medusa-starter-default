import fetch from 'node-fetch';

const MEDUSA_URL = 'http://localhost:9000';
const PUBLISHABLE_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3';

async function testLegacyCustomer() {
    console.log('🧪 Testing LEGACY Customer - POST /store/auth/register\n');
    console.log('━'.repeat(60));

    // Using a legacy customer email (guest without password)
    const testData = {
        email: 'a.vargas@ecopowertech.com',
        password: 'NewPassword123!',
        first_name: 'Alejandro',
        last_name: 'Vargas'
    };

    console.log('\n📝 Request Data (legacy customer):');
    console.log(JSON.stringify(testData, null, 2));

    try {
        console.log(`\n🌐 Calling: ${MEDUSA_URL}/store/auth/register`);
        const response = await fetch(`${MEDUSA_URL}/store/auth/register`, {
            method: 'POST',
            headers: {
                'x-publishable-api-key': PUBLISHABLE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(testData)
        });

        console.log(`\n📊 Response Status: ${response.status} ${response.statusText}`);

        const responseText = await response.text();
        console.log('\n📦 Response Body:');

        try {
            const jsonData = JSON.parse(responseText);
            console.log(JSON.stringify(jsonData, null, 2));

            if (jsonData.needs_activation) {
                console.log('\n🔔 LEGACY CUSTOMER DETECTED!');
                console.log('   → Should send activation email');
                console.log('   → User needs to check email to complete registration');
            }
        } catch (e) {
            console.log('Raw response (not JSON):');
            console.log(responseText);
        }

        console.log('\n━'.repeat(60));

        if (response.ok) {
            console.log('\n✅ Request processed successfully');
        } else {
            console.log(`\n❌ Request failed with status ${response.status}`);
        }

    } catch (error) {
        console.error('\n❌ Error during test:', error.message);
    }
}

testLegacyCustomer();
