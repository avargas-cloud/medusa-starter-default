import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())

async function testSendGrid() {
    console.log('🔍 Testing SendGrid...')
    console.log('API Key:', process.env.SENDGRID_API_KEY?.substring(0, 20) + '...')
    console.log('From:', process.env.SENDGRID_FROM)

    const sgMail = await import("@sendgrid/mail")
    sgMail.default.setApiKey(process.env.SENDGRID_API_KEY!)

    try {
        await sgMail.default.send({
            to: 'a.vargas@ecopowertech.com',
            from: process.env.SENDGRID_FROM || 'noreply@ecopowertech.com',
            subject: 'Test Email from Medusa',
            html: '<h2>This is a test</h2><p>If you receive this, SendGrid is working!</p>'
        })

        console.log('✅ Email sent successfully!')
    } catch (error: any) {
        console.error('❌ Error:', error.message)
        console.error('Response:', error.response?.body)
    }
}

testSendGrid()
