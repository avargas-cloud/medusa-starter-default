/**
 * Send all email template previews to a.vargas@ecopowertech.com
 * 
 * Usage: node -e "require('./src/scripts/tests/preview-all-emails.js')"
 *   or:  npx ts-node src/scripts/tests/preview-all-emails.ts
 */

import {
  buildWelcomeEmail,
  buildPasswordResetEmail,
  buildActivationEmail,
  emailLayout,
  emailIcon,
  emailHeading,
  emailButton,
  emailFootnote,
  sectionLabel,
} from "../../utils/email-templates"

// We also need the order notification templates — import them inline
// since they're not exported from the subscriber. We'll rebuild them here.

const RECIPIENT = "a.vargas@ecopowertech.com"

async function main() {
  const sgMail = await import("@sendgrid/mail")
  const apiKey = process.env.SENDGRID_API_KEY
  const fromEmail = process.env.SENDGRID_FROM || "noreply@ecopowertech.com"

  if (!apiKey) {
    console.error("❌ SENDGRID_API_KEY not set")
    process.exit(1)
  }

  sgMail.default.setApiKey(apiKey)

  const from = { email: fromEmail, name: "EcoPowerTech" }
  const emails: Array<{ subject: string; html: string; delay?: number }> = []

  // ── 1. Welcome Email ──
  emails.push({
    subject: "📧 PREVIEW 1/6 — Welcome Email",
    html: buildWelcomeEmail("Alejandro"),
  })

  // ── 2. Password Reset ──
  emails.push({
    subject: "📧 PREVIEW 2/6 — Password Reset",
    html: buildPasswordResetEmail("Alejandro", "https://ecopowertech.com/reset-password?token=demo-preview-token-12345"),
  })

  // ── 3. Account Activation (QuickBooks) ──
  emails.push({
    subject: "📧 PREVIEW 3/6 — Account Activation",
    html: buildActivationEmail("Alejandro", "https://ecopowertech.com/activate-account?token=demo-preview-token-12345"),
  })

  // ── 4–6: Order Notification Emails ──
  // These templates are in the subscriber file. We'll import the shared layout
  // and rebuild them with demo data here.

  const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://ecopowertech.com"
  const BRAND_COLOR = "#0369a1"

  function fmt(amount: number): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
  }

  function demoItemsTable(): string {
    const MINIO = process.env.MINIO_ENDPOINT || "https://bucket-production-2e09.up.railway.app"
    const BUCKET = process.env.MINIO_BUCKET || "medusa-media"
    const thumbUrl = `${MINIO}/${BUCKET}/ecopowertech-logo.png`
    const items = [
      { title: "LED High Bay Light 200W", sku: "EPT-HBL-200W", qty: 2, price: 89.99 },
      { title: "Solar Panel 400W Mono", sku: "EPT-SP-400M", qty: 1, price: 349.00 },
      { title: "LED Strip Light 5m Cool White", sku: "EPT-LST-5CW", qty: 3, price: 24.99 },
    ]
    return items.map(item => `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #f3f4f6;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="width:56px;vertical-align:top;">
            <img src="${thumbUrl}" alt="${item.title}" style="width:56px;height:56px;object-fit:contain;background:#f3f4f6;border-radius:8px;border:1px solid #e5e7eb;" />
          </td>
          <td style="padding-left:16px;vertical-align:top;">
            <div style="color:#111827;font-weight:600;font-size:14px;line-height:1.4;">${item.title}</div>
            <div style="color:#6b7280;font-size:13px;margin-top:2px;">${item.sku}</div>
            <div style="color:#6b7280;font-size:13px;">Qty: ${item.qty}</div>
          </td>
          <td style="text-align:right;vertical-align:top;color:#111827;font-weight:600;font-size:14px;">
            ${fmt(item.price * item.qty)}
          </td>
        </tr></table>
      </td>
    </tr>`).join("")
  }

  function progressBar(steps: { label: string; done: boolean; active?: boolean }[]): string {
    return `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 32px;">
      <tr><td style="text-align:center;">
        <table cellpadding="0" cellspacing="0" border="0" style="display:inline-table;"><tr>
          ${steps.map((s, i) => {
      const bg = s.done ? "#0369a1" : s.active ? "#0369a1" : "#e5e7eb"
      const textColor = s.done || s.active ? "#0369a1" : "#9ca3af"
      const icon = s.done ? "✓" : s.active ? "●" : `${i + 1}`
      const iconColor = s.done || s.active ? "#fff" : "#9ca3af"
      const connector = i < steps.length - 1
        ? `<td style="width:40px;"><div style="height:2px;background:${s.done ? "#0369a1" : "#e5e7eb"};"></div></td>`
        : ""
      return `
              <td style="text-align:center;padding:0 10px;">
                <div style="width:30px;height:30px;background:${bg};border-radius:50%;line-height:30px;color:${iconColor};font-size:13px;font-weight:700;margin:0 auto;">${icon}</div>
                <div style="color:${textColor};font-size:11px;font-weight:${s.active ? "700" : "500"};margin-top:6px;white-space:nowrap;">${s.label}</div>
              </td>${connector}`
    }).join("")}
        </tr></table>
      </td></tr>
    </table>`
  }

  const subtotal = 89.99 * 2 + 349.00 + 24.99 * 3
  const shipping = 15.00
  const tax = subtotal * 0.07
  const total = subtotal + shipping + tax

  // 4. Ready for Pickup
  emails.push({
    subject: "📧 PREVIEW 4/6 — Ready for Pickup",
    html: emailLayout(`
      ${emailIcon("✅", "#ecfdf5")}
      ${emailHeading("Ready for Pickup", `Great news! Order <strong style="color:#111827;">#1061</strong> is ready and waiting for you.`)}

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:28px;">
        <tr><td style="padding:20px 24px;">
          <div style="color:${BRAND_COLOR};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">📍 Pickup Location</div>
          <div style="color:#111827;font-size:16px;font-weight:600;margin-bottom:4px;">Ecopowertech Miami</div>
          <div style="color:#374151;font-size:14px;">2760 W 84th St, Unit 4</div>
          <div style="color:#374151;font-size:14px;">Hialeah, FL 33016</div>
          <div style="color:#6b7280;font-size:14px;margin-top:4px;">📞 305-861-7028</div>
          <div style="color:#6b7280;font-size:13px;margin-top:8px;font-style:italic;">Please bring your order confirmation and a valid ID.</div>
        </td></tr>
      </table>

      ${sectionLabel("Order Summary")}
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        ${demoItemsTable()}
      </table>

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
        <tr><td style="color:#6b7280;font-size:14px;padding:4px 0;">Subtotal</td><td style="text-align:right;color:#374151;font-size:14px;">${fmt(subtotal)}</td></tr>
        <tr><td style="color:#6b7280;font-size:14px;padding:4px 0;">Shipping</td><td style="text-align:right;color:#374151;font-size:14px;">FREE (Pickup)</td></tr>
        <tr><td style="color:#6b7280;font-size:14px;padding:4px 0;">Tax</td><td style="text-align:right;color:#374151;font-size:14px;">${fmt(tax)}</td></tr>
        <tr><td style="color:#111827;font-size:16px;font-weight:700;padding:12px 0 0;">Total</td><td style="text-align:right;color:#111827;font-size:16px;font-weight:700;padding:12px 0 0;">${fmt(total - shipping)}</td></tr>
      </table>

      ${emailButton("View Order Details", `${STOREFRONT_URL}/account/orders`)}
    `),
  })

  // 5. Order Shipped
  emails.push({
    subject: "📧 PREVIEW 5/6 — Order Shipped",
    html: emailLayout(`
      ${emailIcon("🚚", "#f5f3ff")}
      ${emailHeading("Your Order Has Shipped!", `Order <strong style="color:#111827;">#1062</strong> is on its way to you.`)}

      ${progressBar([
      { label: "Ordered", done: true },
      { label: "Prepared", done: true },
      { label: "Shipped", done: false, active: true },
      { label: "Delivered", done: false },
    ])}

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:20px;">
        <tr><td style="padding:18px 22px;">
          <div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Tracking Number</div>
          <div style="display:inline-block;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:10px 18px;color:${BRAND_COLOR};font-size:14px;font-weight:600;">📦 1Z999AA10123456784</div>
          <div style="color:#6b7280;font-size:12px;margin-top:8px;">Carrier: UPS Ground</div>
        </td></tr>
      </table>

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:24px;">
        <tr><td style="padding:18px 22px;">
          <div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Shipping To</div>
          <div style="color:#111827;font-size:14px;font-weight:500;">Alejandro Vargas</div>
          <div style="color:#6b7280;font-size:14px;">1234 NW 5th Ave</div>
          <div style="color:#6b7280;font-size:14px;">Miami, FL 33136</div>
        </td></tr>
      </table>

      ${sectionLabel("Items Shipped")}
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        ${demoItemsTable()}
      </table>

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
        <tr><td style="color:#111827;font-size:16px;font-weight:700;">Total</td><td style="text-align:right;color:#111827;font-size:16px;font-weight:700;">${fmt(total)}</td></tr>
      </table>

      ${emailButton("Track Your Order", `${STOREFRONT_URL}/account/orders`)}
    `),
  })

  // 6. Order Delivered
  emails.push({
    subject: "📧 PREVIEW 6/6 — Order Delivered",
    html: emailLayout(`
      ${emailIcon("🎉", "#ecfdf5")}
      ${emailHeading("Order Delivered!", `Order <strong style="color:#111827;">#1062</strong> has been delivered. Thank you for your purchase!`)}

      ${progressBar([
      { label: "Ordered", done: true },
      { label: "Prepared", done: true },
      { label: "Shipped", done: true },
      { label: "Delivered", done: true },
    ])}

      ${sectionLabel("Order Summary")}
      <table cellpadding="0" cellspacing="0" border="0" width="100%">
        ${demoItemsTable()}
      </table>

      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
        <tr><td style="color:#111827;font-size:16px;font-weight:700;">Total</td><td style="text-align:right;color:#111827;font-size:16px;font-weight:700;">${fmt(total)}</td></tr>
      </table>

      <div style="text-align:center;margin-top:28px;padding:20px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
        <div style="color:#166534;font-size:15px;font-weight:600;margin-bottom:4px;">Thank you for your purchase! 💚</div>
        <div style="color:#6b7280;font-size:14px;">We appreciate your business and hope to see you again.</div>
      </div>

      ${emailButton("Continue Shopping", STOREFRONT_URL, "#059669")}
    `),
  })

  // Send all emails with 2-second delay between each
  console.log(`\n📧 Sending ${emails.length} preview emails to ${RECIPIENT}...\n`)

  for (let i = 0; i < emails.length; i++) {
    const e = emails[i]!
    try {
      await sgMail.default.send({
        to: RECIPIENT,
        from,
        subject: e.subject,
        html: e.html,
      })
      console.log(`  ✅ ${i + 1}/${emails.length} — ${e.subject}`)
    } catch (err: any) {
      console.error(`  ❌ ${i + 1}/${emails.length} — ${e.subject}`)
      console.error(`     Error: ${err.message}`)
      if (err.response?.body) console.error(`     SendGrid response:`, JSON.stringify(err.response.body, null, 2))
    }

    // Small delay to avoid rate limiting
    if (i < emails.length - 1) {
      await new Promise(r => setTimeout(r, 1500))
    }
  }

  console.log(`\n🎉 Done! Check ${RECIPIENT} inbox.\n`)
}

main().catch(console.error)
