/**
 * src/utils/gmail-sent-insert.ts
 *
 * After Resend delivers an email, inserts a copy into the sender's Gmail
 * "Sent" folder via the Gmail API using a Google Workspace Service Account
 * with Domain-Wide Delegation.
 *
 * This works automatically for any @ecopowertech.com address — no per-user
 * OAuth tokens needed. The service account impersonates the sender.
 *
 * Required env var:
 *   GMAIL_SERVICE_ACCOUNT_KEY — the full service account JSON (single line)
 *
 * Google Workspace Admin setup (one-time):
 *   admin.google.com → Security → API controls → Domain-wide Delegation
 *   Add client ID with scope: https://www.googleapis.com/auth/gmail.insert
 */

import { google } from "googleapis";

export interface GmailInsertOptions {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  attachments?: Array<{
    filename: string;
    content: string; // base64
    type?: string;
  }>;
}

/** Extract bare email address from "Name <email>" format */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim();
}

/** Build a minimal RFC 2822 MIME message as a Buffer */
function buildMimeMessage(opts: GmailInsertOptions): Buffer {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toHeader = Array.isArray(opts.to) ? opts.to.join(", ") : opts.to;
  const hasAttachments = opts.attachments && opts.attachments.length > 0;

  const headers = [
    `From: ${opts.from}`,
    `To: ${toHeader}`,
    `Subject: ${opts.subject}`,
    `MIME-Version: 1.0`,
  ];

  const htmlBase64 = Buffer.from(opts.html, "utf-8").toString("base64");
  let body: string;

  if (hasAttachments) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      htmlBase64,
    ];
    for (const att of opts.attachments!) {
      const mime = att.type ?? "application/octet-stream";
      parts.push(
        `--${boundary}`,
        `Content-Type: ${mime}; name="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        ``,
        att.content
      );
    }
    parts.push(`--${boundary}--`);
    body = parts.join("\r\n");
  } else {
    headers.push(`Content-Type: text/html; charset="UTF-8"`);
    headers.push(`Content-Transfer-Encoding: base64`);
    body = htmlBase64;
  }

  return Buffer.from([...headers, "", body].join("\r\n"));
}

/** Base64url encode (Gmail API requirement) */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Insert the email into the sender's Gmail Sent folder using service account
 * impersonation. Non-blocking — logs a warning on failure but does NOT throw.
 */
export async function insertIntoGmailSent(
  opts: GmailInsertOptions
): Promise<void> {
  const keyRaw = process.env.GMAIL_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) return; // Not configured — skip silently

  const senderEmail = extractEmail(opts.from);

  // Only insert for @ecopowertech.com senders (domain we have DWD for)
  if (!senderEmail.endsWith("@ecopowertech.com")) return;

  try {
    const key = JSON.parse(keyRaw) as {
      client_email: string;
      private_key: string;
    };

    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ["https://www.googleapis.com/auth/gmail.insert"],
      subject: senderEmail,
    });

    const gmail = google.gmail({ version: "v1", auth });
    const raw = base64url(buildMimeMessage(opts));

    await gmail.users.messages.insert({
      userId: senderEmail,
      requestBody: { labelIds: ["SENT"], raw },
    });

    console.log(`[gmail-sent] Inserted into Sent for ${senderEmail}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gmail-sent] Failed to insert (Resend delivery unaffected): ${message}`
    );
  }
}
