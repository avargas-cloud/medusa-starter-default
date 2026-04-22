/**
 * src/utils/mailer.ts
 * Thin wrapper around Resend for all transactional emails.
 * Drop-in replacement for the old @sendgrid/mail usage.
 */

import { Resend } from "resend";

import { insertIntoGmailSent } from "./gmail-sent-insert";

export interface MailOptions {
  to: string | string[];
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64
    type?: string;
  }>;
}

/**
 * Strips the "dup_" prefix from an email address.
 *
 * Some customers share emails across two QB accounts. The duplicate record is
 * stored with a "dup_" prefix (e.g. "dup_john@gmail.com") so the real email
 * stays available for the canonical customer. When we send mail to a dup_
 * address we transparently deliver to the real address instead.
 */
function resolveDupEmail(email: string): string {
  return email.toLowerCase().startsWith("dup_") ? email.slice(4) : email;
}

function normalizeRecipients(field: string | string[] | undefined) {
  if (!field) return field;
  if (Array.isArray(field)) return field.map(resolveDupEmail);
  return resolveDupEmail(field);
}

/**
 * Send a transactional email via Resend.
 * Returns true if sent, false if API key is missing.
 * Throws on send failure so callers can handle it.
 */
export async function sendMail(options: MailOptions): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  const resend = new Resend(apiKey);
  const from =
    options.from ??
    process.env.RESEND_FROM ??
    process.env.SENDGRID_FROM ??
    "noreply@ecopowertech.com";

  const to = normalizeRecipients(options.to)!;
  const cc = normalizeRecipients(options.cc);
  const replyTo = normalizeRecipients(options.replyTo) as string | undefined;

  // Log when a dup_ address is resolved so it's visible in server logs
  const allOriginal = [options.to, options.cc, options.replyTo]
    .flat()
    .filter(Boolean) as string[];
  const dupResolved = allOriginal.filter((e) =>
    e.toLowerCase().startsWith("dup_")
  );
  if (dupResolved.length > 0) {
    console.log(
      `[mailer] dup_ address resolved: ${dupResolved.map((e) => `${e} → ${e.slice(4)}`).join(", ")}`
    );
  }

  const { data, error } = await resend.emails.send({
    from,
    to,
    replyTo,
    cc,
    subject: options.subject,
    html: options.html,
    attachments: options.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
    })),
  });

  if (error) {
    console.error("[mailer] Resend API Error:", error);
    throw new Error(`Resend Error: ${error.message}`);
  }

  console.log(`[mailer] Sent successfully. ID: ${data?.id}`);

  // Insert a copy into the sender's Gmail Sent folder (non-blocking)
  // so the sender sees the email in their Gmail without needing CC.
  insertIntoGmailSent({
    from,
    to,
    subject: options.subject,
    html: options.html,
    attachments: options.attachments,
  }).catch(() => {
    /* already logged inside */
  });

  return true;
}
