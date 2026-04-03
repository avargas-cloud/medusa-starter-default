/**
 * src/utils/mailer.ts
 * Thin wrapper around Resend for all transactional emails.
 * Drop-in replacement for the old @sendgrid/mail usage.
 */

import { Resend } from 'resend'

export interface MailOptions {
    to: string | string[]
    from?: string
    replyTo?: string
    cc?: string | string[]
    subject: string
    html: string
    attachments?: Array<{
        filename: string
        content: string   // base64
        type?: string
    }>
}

/**
 * Send a transactional email via Resend.
 * Returns true if sent, false if API key is missing.
 * Throws on send failure so callers can handle it.
 */
export async function sendMail(options: MailOptions): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) return false

    const resend = new Resend(apiKey)
    const from = options.from ?? process.env.RESEND_FROM ?? process.env.SENDGRID_FROM ?? 'noreply@ecopowertech.com'

    const { data, error } = await resend.emails.send({
        from,
        to: options.to,
        replyTo: options.replyTo,
        cc: options.cc,
        subject: options.subject,
        html: options.html,
        attachments: options.attachments?.map(a => ({
            filename: a.filename,
            content: a.content,
        })),
    })

    if (error) {
        console.error("[mailer] Resend API Error:", error)
        throw new Error(`Resend Error: ${error.message}`)
    }

    console.log(`[mailer] Sent successfully. ID: ${data?.id}`)
    return true
}
