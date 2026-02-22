/**
 * Send activation email directly via SendGrid
 * This bypasses the endpoint to test email delivery
 */

require('dotenv').config()

async function sendActivationEmail() {
    const sgMail = require('@sendgrid/mail')
    sgMail.setApiKey(process.env.SENDGRID_API_KEY)

    // Simulate a real activation token
    const customerId = 'cus_01KG0F72ZTGAE00F50N1W5RC5M'
    const token = Buffer.from(`${customerId}:${Date.now()}`).toString('base64')
    const activationLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/activate-account?token=${token}`

    console.log('📧 Sending Activation Email')
    console.log('To: a.vargas@ecopowertech.com')
    console.log('Link:', activationLink)
    console.log()

    const emailContent = {
        to: 'a.vargas@ecopowertech.com',
        from: process.env.SENDGRID_FROM || 'noreply@ecopowertech.com',
        subject: 'Activate Your Account - Ecopower Tech',
        text: `Hi Alejandro,\n\nWelcome to Ecopower Tech! Please activate your account by clicking the link below:\n\n${activationLink}\n\nThis link will expire in 24 hours.\n\nBest regards,\nEcopower Tech Team`,
        html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome to Ecopower Tech!</h2>
        <p>Hi Alejandro,</p>
        <p>We're excited to have you! Please activate your account by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${activationLink}" style="background-color: #0070f3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Activate Account</a>
        </div>
        <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
        <p style="color: #666; font-size: 14px;">If you didn't request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        <p style="color: #999; font-size: 12px;">Ecopower Tech - Lighting Solutions</p>
      </div>
    `
    }

    try {
        const response = await sgMail.send(emailContent)
        console.log('✅ Email sent successfully!')
        console.log('Status:', response[0].statusCode)
        console.log('Message ID:', response[0].headers['x-message-id'])
    } catch (error) {
        console.error('❌ Error:', error.message)
        if (error.response) {
            console.error('Response:', error.response.body)
        }
    }
}

sendActivationEmail()
