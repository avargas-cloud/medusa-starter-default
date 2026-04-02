import { loadEnv } from "@medusajs/utils"
import { sendMail } from "../../../utils/mailer"

loadEnv('development', process.cwd())

async function testResend() {
    console.log('🔍 Testing Resend...')
    console.log('API Key:', process.env.RESEND_API_KEY?.substring(0, 20) + '...')
    console.log('From:', process.env.RESEND_FROM)

    try {
        const sent = await sendMail({
            to: 'a.vargas@ecopowertech.com',
            subject: 'Test Email from Medusa',
            html: '<h2>This is a test</h2><p>If you receive this, Resend is working!</p>'
        })

        if (sent) {
            console.log('✅ Email sent successfully!')
        } else {
            console.log('⚠️  RESEND_API_KEY not set — email skipped')
        }
    } catch (error: any) {
        console.error('❌ Error:', error.message)
    }
}

testResend()
