/**
 * Shared Email Templates for EcoPowerTech
 *
 * Clean, light, professional theme matching Apple/Stripe style.
 * Used across all email-sending code (subscribers, API routes, scripts).
 */

const LOGO_URL =
  process.env.EMAIL_LOGO_URL ||
  `${process.env.MINIO_ENDPOINT || "https://bucket-production-2e09.up.railway.app"}/${process.env.MINIO_BUCKET || "medusa-media"}/ecopowertech-logo.png`;
const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://ecopowertech.com";
const COMPANY_NAME = "EcoPowerTech";
const COMPANY_PHONE = "305-861-7028";
const COMPANY_ADDRESS = "Miami, FL";
const PICKUP_ADDRESS = "7940 NW 84th St, Medley, FL 33166";
const SUPPORT_EMAIL = "support@ecopowertech.com";
const BRAND_COLOR = "#0369a1";

/**
 * Wraps email content in a professional template with logo, card, and footer.
 */
export function emailLayout(
  content: string,
  options?: { preheader?: string }
): string {
  const preheader = options?.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;">${options.preheader}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${COMPANY_NAME}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  ${preheader}
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8fafc;">
    <tr><td style="padding:40px 20px;" align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">

        <!-- Logo -->
        <tr><td style="text-align:center;padding:0 0 32px;">
          <a href="${STOREFRONT_URL}" style="text-decoration:none;">
            <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;"><tr>
              ${LOGO_URL ? `<td style="vertical-align:middle;padding-right:10px;"><img src="${LOGO_URL}" alt="" style="height:36px;width:auto;" /></td>` : ""}
              <td style="vertical-align:middle;"><span style="color:${BRAND_COLOR};font-size:22px;font-weight:800;letter-spacing:1px;">ECOPOWERTECH</span></td>
            </tr></table>
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:40px 36px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          ${content}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:28px 16px;text-align:center;">
          <p style="color:#9ca3af;font-size:13px;margin:0 0 6px;">
            Need help? <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND_COLOR};text-decoration:none;font-weight:500;">${SUPPORT_EMAIL}</a>
            &nbsp;·&nbsp; <a href="tel:+1${COMPANY_PHONE.replace(/[^0-9]/g, "")}" style="color:${BRAND_COLOR};text-decoration:none;font-weight:500;">${COMPANY_PHONE}</a>
          </p>
          <p style="color:#d1d5db;font-size:12px;margin:0 0 6px;">${COMPANY_NAME} · ${COMPANY_ADDRESS}</p>
          <p style="margin:0;"><a href="${STOREFRONT_URL}" style="color:#9ca3af;font-size:12px;text-decoration:none;">ecopowertech.com</a></p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function emailButton(
  text: string,
  href: string,
  color: string = BRAND_COLOR
): string {
  return `
  <div style="text-align:center;margin:28px 0 0;">
    <a href="${href}" style="display:inline-block;background:${color};color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;padding:13px 36px;border-radius:8px;letter-spacing:0.3px;">
      ${text}
    </a>
  </div>`;
}

export function emailIcon(emoji: string, bgColor: string = "#eff6ff"): string {
  return `
  <div style="text-align:center;margin-bottom:20px;">
    <div style="display:inline-block;width:64px;height:64px;background:${bgColor};border-radius:50%;line-height:64px;font-size:30px;">${emoji}</div>
  </div>`;
}

export function emailHeading(title: string, subtitle?: string): string {
  return `
  <h1 style="color:#111827;font-size:22px;font-weight:700;text-align:center;margin:0 0 6px;">${title}</h1>
  ${subtitle ? `<p style="color:#6b7280;font-size:15px;text-align:center;margin:0 0 28px;line-height:1.5;">${subtitle}</p>` : ""}`;
}

export function emailFootnote(text: string): string {
  return `<p style="color:#9ca3af;font-size:13px;text-align:center;margin:24px 0 0;line-height:1.5;">${text}</p>`;
}

// ─── Pre-built Email Templates ───────────────────────────────────────────────

export function buildWelcomeEmail(firstName: string): string {
  return emailLayout(
    `
    ${emailIcon("👋", "#ecfdf5")}
    ${emailHeading(
      `Welcome to ${COMPANY_NAME}!`,
      `Hi ${firstName || "there"}, your account has been created successfully. You can now browse our catalog, place orders, and track your purchases.`
    )}

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin:24px 0;">
      <tr><td style="padding:20px 24px;">
        <div style="color:${BRAND_COLOR};font-size:14px;font-weight:600;margin-bottom:8px;">What you can do:</div>
        <div style="color:#374151;font-size:14px;line-height:1.8;">
          ✓ Browse our full product catalog<br>
          ✓ Place orders with fast checkout<br>
          ✓ Track your orders in real time<br>
          ✓ Access exclusive pricing and promotions
        </div>
      </td></tr>
    </table>

    ${emailButton("Start Shopping", STOREFRONT_URL, "#059669")}
  `,
    { preheader: `Welcome to ${COMPANY_NAME}! Your account is ready.` }
  );
}

export function buildPasswordResetEmail(
  firstName: string,
  resetLink: string
): string {
  return emailLayout(
    `
    ${emailIcon("🔐", "#fef3c7")}
    ${emailHeading(
      "Reset Your Password",
      `Hi ${firstName || "there"}, we received a request to reset your password. Click the button below to create a new one.`
    )}

    ${emailButton("Reset Password", resetLink)}

    <div style="text-align:center;margin-top:24px;">
      <p style="color:#9ca3af;font-size:13px;margin:0;">This link expires in <strong style="color:#6b7280;">1 hour</strong>.</p>
    </div>

    ${emailFootnote("If you didn't request this, you can safely ignore this email. Your password won't be changed.")}
  `,
    { preheader: "Reset your EcoPowerTech password" }
  );
}

export function buildActivationEmail(
  firstName: string,
  activationLink: string
): string {
  return emailLayout(
    `
    ${emailIcon("🔑", "#f0fdf4")}
    ${emailHeading(
      `Set up your online access, ${firstName || "there"}`,
      "You recently asked to create online access for this email at EcoPowerTech."
    )}

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:10px;border:1px solid #e5e7eb;margin:24px 0;">
      <tr><td style="padding:20px 24px;">
        <div style="color:#6b7280;font-size:14px;line-height:1.7;">
          This email is already connected to a customer profile from an
          in-store purchase, invoice, or other offline transaction with
          EcoPowerTech. That profile helps us support your orders, receipts,
          warranty history, and records, but you have <strong>not</strong>
          created an online password or online access yet.
        </div>
      </td></tr>
    </table>

    ${emailButton("Set up online access", activationLink, "#059669")}

    ${emailFootnote("This link expires in 24 hours. If you didn't request this, you can ignore this email — no online password will be created.")}
  `,
    { preheader: "Set up your EcoPowerTech online access" }
  );
}

export function sectionLabel(text: string): string {
  return `<div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #f3f4f6;">${text}</div>`;
}

export {
  LOGO_URL,
  STOREFRONT_URL,
  COMPANY_NAME,
  COMPANY_PHONE,
  COMPANY_ADDRESS,
  PICKUP_ADDRESS,
  SUPPORT_EMAIL,
  BRAND_COLOR,
};
