/**
 * Test script to verify SendGrid is working correctly
 * Usage: node src/scripts/test-sendgrid.js your-email@example.com
 */

require('dotenv').config()

async function testSendGrid() {
    const recipientEmail = process.argv[2]

    if (!recipientEmail) {
        console.error('❌ Error: Email required')
        console.log('Usage: node src/scripts/test-sendgrid.js your-email@example.com')
        process.exit(1)
    }

    console.log('🔍 Testing SendGrid configuration...\n')
    console.log(`📧 Recipient: ${recipientEmail}`)
    console.log(`🔑 API Key: ${process.env.SENDGRID_API_KEY ? '✅ Found' : '❌ Missing'}`)
    console.log(`📤 From: ${process.env.SENDGRID_FROM || 'noreply@ecopowertech.com'}`)
    console.log()

    if (!process.env.SENDGRID_API_KEY) {
        console.error('❌ SENDGRID_API_KEY not found in environment variables')
        process.exit(1)
    }

    try {
        const sgMail = require('@sendgrid/mail')
        sgMail.setApiKey(process.env.SENDGRID_API_KEY)

        const msg = {
            to: recipientEmail,
            from: process.env.SENDGRID_FROM || 'noreply@ecopowertech.com',
            subject: 'Test Email - SendGrid Verification',
            text: 'This is a test email to verify SendGrid is working correctly.',
            html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #0070f3;">✅ SendGrid Test Email</h2>
          <p>If you're seeing this, SendGrid is configured correctly!</p>
          <p style="color: #666; font-size: 14px;">Sent at: ${new Date().toISOString()}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">Ecopower Tech - Lighting Solutions</p>
        </div>
      `
        }

        console.log('📨 Sending test email...\n')

        const response = await sgMail.send(msg)

        console.log('✅ Email sent successfully!')
        console.log('\n📊 Response Details:')
        console.log(`   Status Code: ${response[0].statusCode}`)
        console.log(`   Message ID: ${response[0].headers['x-message-id'] || 'N/A'}`)
        console.log()
        console.log('🎉 SendGrid is working correctly!')
        console.log()
        console.log('⏰ Check your inbox in 1-2 minutes. Don\'t forget to check spam!')

        process.exit(0)

    } catch (error) {
        console.error('\n❌ SendGrid Error:\n')

        if (error.response) {
            console.error('Status Code:', error.response.statusCode)
            console.error('Error Body:', JSON.stringify(error.response.body, null, 2))

            if (error.response.statusCode === 401) {
                console.error('\n⚠️  Authentication failed. Check your SENDGRID_API_KEY.')
            } else if (error.response.statusCode === 403) {
                console.error('\n⚠️  Forbidden. Your API key may not have permission to send emails.')
            } else if (error.response.body?.errors) {
                console.error('\nErrors:')
                error.response.body.errors.forEach((err, i) => {
                    console.error(`  ${i + 1}. ${err.message}`)
                    if (err.field) console.error(`     Field: ${err.field}`)
                })
            }
        } else {
            console.error(error.message)
            console.error(error.stack)
        }

        console.error('\n💡 Troubleshooting:')
        console.error('   1. Verify SENDGRID_API_KEY in .env')
        console.error('   2. Verify sender email in SendGrid dashboard')
        console.error('   3. Check SendGrid account status')

        process.exit(1)
    }
}

testSendGrid()
