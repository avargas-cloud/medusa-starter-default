/**
 * Direct SendGrid test with detailed error logging
 */

require('dotenv').config()

async function testSendGridDirect() {
    console.log('🔍 Testing SendGrid Direct Send...\n')

    try {
        const sgMail = require('@sendgrid/mail')
        sgMail.setApiKey(process.env.SENDGRID_API_KEY)

        console.log('API Key:', process.env.SENDGRID_API_KEY ? '✅ Found' : '❌ Missing')
        console.log('From:', process.env.SENDGRID_FROM || 'noreply@ecopowertech.com')
        console.log()

        const msg = {
            to: 'a.vargas@ecopowertech.com',
            from: process.env.SENDGRID_FROM || 'noreply@ecopowertech.com',
            subject: 'DIRECT TEST - Activation Email',
            text: 'This is a direct test from the registration endpoint logic.',
            html: '<h2>Direct Test</h2><p>If you see this, the email code works!</p>'
        }

        console.log('📧 Sending email...')
        console.log('To:', msg.to)
        console.log()

        const response = await sgMail.send(msg)

        console.log('✅ SUCCESS!')
        console.log('Status Code:', response[0].statusCode)
        console.log('Headers:', JSON.stringify(response[0].headers, null, 2))

    } catch (error) {
        console.error('\n❌ SEND ERROR:')
        console.error('Message:', error.message)

        if (error.response) {
            console.error('\n📊 Response Details:')
            console.error('Status:', error.response.statusCode)
            console.error('Body:', JSON.stringify(error.response.body, null, 2))
        }

        console.error('\n🔍 Full Error:')
        console.error(error)
    }
}

testSendGridDirect()
