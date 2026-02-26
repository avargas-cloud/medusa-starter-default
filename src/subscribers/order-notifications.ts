import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ─── Configuration ──────────────────────────────────────────────────────────
const LOGO_URL =
  process.env.EMAIL_LOGO_URL ||
  `${process.env.MINIO_ENDPOINT || "https://bucket-production-2e09.up.railway.app"}/${process.env.MINIO_BUCKET || "medusa-media"}/ecopowertech-logo.png`
const STOREFRONT_URL = process.env.STOREFRONT_URL || "https://ecopowertech.com"
const COMPANY_NAME = "EcoPowerTech"
const COMPANY_PHONE = "305-861-7028"
const COMPANY_ADDRESS = "Miami, FL"
// Pickup address is fetched dynamically from Medusa's stock location data
const SUPPORT_EMAIL = "support@ecopowertech.com"
const BRAND_COLOR = "#0369a1"

// ─── Subscriber Handler ─────────────────────────────────────────────────────
export default async function orderNotifications({ event, container }: SubscriberArgs<any>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const eventName = event.name
  const payload = event.data

  logger.info(`📧 [OrderNotifications] Event received: ${eventName}`)
  logger.info(`📧 [OrderNotifications] Payload: ${JSON.stringify(payload)}`)

  // Respect "Send notification" toggle from Admin
  if (payload.no_notification) {
    logger.info(`📧 [OrderNotifications] Skipping — no_notification flag is set`)
    return
  }

  try {
    const sgMail = await import("@sendgrid/mail")
    const apiKey = process.env.SENDGRID_API_KEY
    const fromEmail = process.env.SENDGRID_FROM || "noreply@ecopowertech.com"

    if (!apiKey) {
      logger.warn("📧 [OrderNotifications] SENDGRID_API_KEY not configured, skipping email")
      return
    }

    sgMail.default.setApiKey(apiKey)

    const orderService = container.resolve(Modules.ORDER)
    const fulfillmentService = container.resolve(Modules.FULFILLMENT)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    if (eventName === "order.fulfillment_created") {
      await handleFulfillmentCreated(payload, sgMail, fromEmail, orderService, fulfillmentService, query, logger, container)
    } else if (eventName === "shipment.created") {
      await handleShipmentCreated(payload, sgMail, fromEmail, orderService, fulfillmentService, query, logger)
    } else if (eventName === "delivery.created") {
      await handleDeliveryCreated(payload, sgMail, fromEmail, orderService, fulfillmentService, query, logger)
    }
  } catch (err: any) {
    logger.error(`📧 [OrderNotifications] Failed to send email for ${eventName}: ${err.message}`)
    logger.error(err.stack)
  }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

async function handleFulfillmentCreated(
  payload: any, sgMail: any, fromEmail: string,
  orderService: any, fulfillmentService: any, _query: any, logger: any, container: any
) {
  const { order_id, fulfillment_id } = payload

  const order = await orderService.retrieveOrder(order_id, {
    select: ["id", "display_id", "email", "currency_code", "total", "subtotal", "shipping_total", "tax_total", "*items", "*items.detail"],
    relations: ["items", "items.tax_lines", "items.adjustments", "shipping_address"],
  })

  const fulfillment = await fulfillmentService.retrieveFulfillment(fulfillment_id, {
    relations: ["labels"],
  })

  const isPickup = fulfillment.provider_id?.includes("store-pickup") ||
    fulfillment.provider_id?.includes("pickup")

  // Fetch stock location address for pickup emails
  let locationAddress: { name: string; address_1?: string; city?: string; province?: string; postal_code?: string; phone?: string } | null = null
  if (isPickup && fulfillment.location_id) {
    try {
      const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
      const location = await stockLocationModule.retrieveStockLocation(fulfillment.location_id, {
        relations: ["address"],
      })
      locationAddress = {
        name: location.name || COMPANY_NAME,
        address_1: location.address?.address_1,
        city: location.address?.city,
        province: location.address?.province,
        postal_code: location.address?.postal_code,
        phone: location.address?.phone,
      }
      logger.info(`📍 Pickup location: ${location.name} - ${location.address?.address_1}`)
    } catch (locErr: any) {
      logger.warn(`⚠️  Could not fetch stock location: ${locErr.message}`)
    }
  }

  const customerEmail = order.email
  logger.info(`📧 Sending ${isPickup ? "ready for pickup" : "fulfillment created"} email to ${customerEmail}`)

  if (isPickup) {
    await sgMail.default.send({
      to: customerEmail,
      from: { email: fromEmail, name: COMPANY_NAME },
      subject: `Your Order #${order.display_id} is Ready for Pickup`,
      html: buildReadyForPickupEmail(order, fulfillment, locationAddress),
    })
  } else {
    await sgMail.default.send({
      to: customerEmail,
      from: { email: fromEmail, name: COMPANY_NAME },
      subject: `Your Order #${order.display_id} is Being Prepared`,
      html: buildFulfillmentCreatedEmail(order),
    })
  }
  logger.info(`✅ [OrderNotifications] Fulfillment email sent to ${customerEmail}`)
}

async function handleShipmentCreated(
  payload: any, sgMail: any, fromEmail: string,
  orderService: any, fulfillmentService: any, query: any, logger: any
) {
  const fulfillmentId = payload.id || payload.fulfillment_id

  const fulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId, {
    relations: ["labels"],
  })

  const { data: [link] } = await query.graph({
    entity: "order_fulfillment",
    filters: { fulfillment_id: fulfillmentId },
    fields: ["order_id"],
  }).catch(() => ({ data: [] }))

  const orderId = link?.order_id || payload.order_id
  if (!orderId) {
    logger.warn("📧 [OrderNotifications] Could not find order for shipment, skipping")
    return
  }

  const order = await orderService.retrieveOrder(orderId, {
    select: ["id", "display_id", "email", "currency_code", "total", "*items", "*items.detail"],
    relations: ["items", "shipping_address"],
  })

  const trackingNumbers = fulfillment.labels?.map((l: any) => l.tracking_number).filter(Boolean) || []
  const trackingUrls = fulfillment.labels?.map((l: any) => l.tracking_url).filter(Boolean) || []

  await sgMail.default.send({
    to: order.email,
    from: { email: fromEmail, name: COMPANY_NAME },
    subject: `Your Order #${order.display_id} Has Been Shipped`,
    html: buildShippedEmail(order, trackingNumbers, trackingUrls),
  })
  logger.info(`✅ [OrderNotifications] Shipment email sent to ${order.email}`)
}

async function handleDeliveryCreated(
  payload: any, sgMail: any, fromEmail: string,
  orderService: any, fulfillmentService: any, query: any, logger: any
) {
  const fulfillmentId = payload.id || payload.fulfillment_id
  const fulfillment = await fulfillmentService.retrieveFulfillment(fulfillmentId, {})

  const isPickup = fulfillment.provider_id?.includes("store-pickup") ||
    fulfillment.provider_id?.includes("pickup")

  const { data: [link] } = await query.graph({
    entity: "order_fulfillment",
    filters: { fulfillment_id: fulfillmentId },
    fields: ["order_id"],
  }).catch(() => ({ data: [] }))

  const orderId = link?.order_id || payload.order_id
  if (!orderId) {
    logger.warn("📧 [OrderNotifications] Could not find order for delivery, skipping")
    return
  }

  const order = await orderService.retrieveOrder(orderId, {
    select: ["id", "display_id", "email", "currency_code", "total", "*items", "*items.detail"],
    relations: ["items"],
  })

  await sgMail.default.send({
    to: order.email,
    from: { email: fromEmail, name: COMPANY_NAME },
    subject: isPickup
      ? `Your Order #${order.display_id} Has Been Picked Up`
      : `Your Order #${order.display_id} Has Been Delivered`,
    html: buildDeliveredEmail(order, isPickup),
  })
  logger.info(`✅ [OrderNotifications] Delivery email sent to ${order.email}`)
}

// ─── Template Helpers ────────────────────────────────────────────────────────

function fmt(amount: number, currency: string = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount)
}

function itemsTable(items: any[], currency: string): string {
  if (!items?.length) return ""
  return items.map((item: any) => {
    const qty = item.quantity || item.detail?.quantity || 1
    const price = item.unit_price ?? item.detail?.unit_price ?? 0
    const thumb = item.thumbnail
      ? `<img src="${item.thumbnail}" alt="${item.title || 'Product'}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;background:#f3f4f6;" />`
      : `<div style="width:56px;height:56px;background:#f3f4f6;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:22px;border:1px solid #e5e7eb;">📦</div>`
    return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #f3f4f6;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
          <td style="width:56px;vertical-align:top;">${thumb}</td>
          <td style="padding-left:16px;vertical-align:top;">
            <div style="color:#111827;font-weight:600;font-size:14px;line-height:1.4;">${item.title || "Item"}</div>
            <div style="color:#6b7280;font-size:13px;margin-top:2px;">${item.variant_sku || ""}</div>
            <div style="color:#6b7280;font-size:13px;">Qty: ${qty}</div>
          </td>
          <td style="text-align:right;vertical-align:top;color:#111827;font-weight:600;font-size:14px;">
            ${fmt(price * qty, currency)}
          </td>
        </tr></table>
      </td>
    </tr>`
  }).join("")
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

function wrap(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${COMPANY_NAME}</title>
</head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased;">
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
</html>`
}

function ctaButton(text: string, href: string, color: string = BRAND_COLOR): string {
  return `
  <div style="text-align:center;margin-top:32px;">
    <a href="${href}" style="display:inline-block;background:${color};color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;padding:13px 36px;border-radius:8px;letter-spacing:0.3px;">
      ${text}
    </a>
  </div>`
}

function sectionLabel(text: string): string {
  return `<div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #f3f4f6;">${text}</div>`
}

// ─── Email Templates ─────────────────────────────────────────────────────────

function buildReadyForPickupEmail(order: any, fulfillment: any, locationAddress?: any): string {
  const items = order.items || []
  const currency = order.currency_code || "USD"
  const locName = locationAddress?.name || fulfillment.location?.name || COMPANY_NAME
  const locAddr = locationAddress?.address_1 || ""
  const locCity = [locationAddress?.city, locationAddress?.province, locationAddress?.postal_code].filter(Boolean).join(", ")
  const locPhone = locationAddress?.phone || COMPANY_PHONE

  return wrap(`
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-block;width:64px;height:64px;background:#ecfdf5;border-radius:50%;line-height:64px;font-size:30px;">✅</div>
    </div>

    <h1 style="color:#111827;font-size:22px;font-weight:700;text-align:center;margin:0 0 6px;">Ready for Pickup</h1>
    <p style="color:#6b7280;font-size:15px;text-align:center;margin:0 0 28px;line-height:1.5;">
      Great news! Order <strong style="color:#111827;">#${order.display_id}</strong> is ready and waiting for you.
    </p>

    <!-- Pickup Location -->
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0f9ff;border-radius:10px;border:1px solid #bae6fd;margin-bottom:28px;">
      <tr><td style="padding:20px 24px;">
        <div style="color:${BRAND_COLOR};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px;">📍 Pickup Location</div>
        <div style="color:#111827;font-size:16px;font-weight:600;margin-bottom:4px;">${locName}</div>
        ${locAddr ? `<div style="color:#374151;font-size:14px;">${locAddr}</div>` : ""}
        ${locCity ? `<div style="color:#374151;font-size:14px;">${locCity}</div>` : ""}
        ${locPhone ? `<div style="color:#6b7280;font-size:14px;margin-top:4px;">📞 ${locPhone}</div>` : ""}
        <div style="color:#6b7280;font-size:13px;margin-top:8px;font-style:italic;">Please bring your order confirmation and a valid ID.</div>
      </td></tr>
    </table>

    ${sectionLabel("Order Summary")}
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${itemsTable(items, currency)}
    </table>

    <!-- Totals -->
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
      ${order.subtotal ? `<tr>
        <td style="color:#6b7280;font-size:14px;padding:4px 0;">Subtotal</td>
        <td style="text-align:right;color:#374151;font-size:14px;">${fmt(order.subtotal, currency)}</td>
      </tr>` : ""}
      ${order.shipping_total ? `<tr>
        <td style="color:#6b7280;font-size:14px;padding:4px 0;">Shipping</td>
        <td style="text-align:right;color:#374151;font-size:14px;">${fmt(order.shipping_total, currency)}</td>
      </tr>` : ""}
      ${order.tax_total ? `<tr>
        <td style="color:#6b7280;font-size:14px;padding:4px 0;">Tax</td>
        <td style="text-align:right;color:#374151;font-size:14px;">${fmt(order.tax_total, currency)}</td>
      </tr>` : ""}
      <tr>
        <td style="color:#111827;font-size:16px;font-weight:700;padding:12px 0 0;">Total</td>
        <td style="text-align:right;color:#111827;font-size:16px;font-weight:700;padding:12px 0 0;">${fmt(order.total || 0, currency)}</td>
      </tr>
    </table>

    ${ctaButton("View Order Details", `${STOREFRONT_URL}/account/orders`)}
  `)
}

function buildFulfillmentCreatedEmail(order: any): string {
  const items = order.items || []
  const currency = order.currency_code || "USD"

  return wrap(`
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-block;width:64px;height:64px;background:#eff6ff;border-radius:50%;line-height:64px;font-size:30px;">📦</div>
    </div>

    <h1 style="color:#111827;font-size:22px;font-weight:700;text-align:center;margin:0 0 6px;">Your Order is Being Prepared</h1>
    <p style="color:#6b7280;font-size:15px;text-align:center;margin:0 0 4px;line-height:1.5;">
      We're getting order <strong style="color:#111827;">#${order.display_id}</strong> ready for shipment.
    </p>
    <p style="color:#9ca3af;font-size:14px;text-align:center;margin:0 0 24px;">
      You'll receive another email with tracking details once it ships.
    </p>

    ${progressBar([
    { label: "Ordered", done: true },
    { label: "Preparing", done: false, active: true },
    { label: "Shipped", done: false },
    { label: "Delivered", done: false },
  ])}

    ${sectionLabel("Order Summary")}
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${itemsTable(items, currency)}
    </table>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
      <tr>
        <td style="color:#111827;font-size:16px;font-weight:700;">Total</td>
        <td style="text-align:right;color:#111827;font-size:16px;font-weight:700;">${fmt(order.total || 0, currency)}</td>
      </tr>
    </table>

    ${ctaButton("View Order Details", `${STOREFRONT_URL}/account/orders`)}
  `)
}

function buildShippedEmail(order: any, trackingNumbers: string[], trackingUrls: string[]): string {
  const items = order.items || []
  const currency = order.currency_code || "USD"
  const address = order.shipping_address || {}

  const trackingHTML = trackingNumbers.length > 0
    ? trackingNumbers.map((num: string, i: number) => {
      const url = trackingUrls[i] || `https://www.google.com/search?q=${num}+tracking`
      return `<a href="${url}" target="_blank" style="display:inline-block;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:10px 18px;color:${BRAND_COLOR};font-size:14px;font-weight:600;text-decoration:none;margin:4px 4px 4px 0;">📦 ${num}</a>`
    }).join("")
    : `<div style="color:#9ca3af;font-size:14px;">Tracking information will be updated shortly.</div>`

  const addressHTML = address.first_name
    ? `<div style="color:#111827;font-size:14px;font-weight:500;">${address.first_name} ${address.last_name || ""}</div>
       <div style="color:#6b7280;font-size:14px;">${address.address_1 || ""}${address.address_2 ? `, ${address.address_2}` : ""}</div>
       <div style="color:#6b7280;font-size:14px;">${address.city || ""}, ${address.province || ""} ${address.postal_code || ""}</div>`
    : ""

  return wrap(`
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-block;width:64px;height:64px;background:#f5f3ff;border-radius:50%;line-height:64px;font-size:30px;">🚚</div>
    </div>

    <h1 style="color:#111827;font-size:22px;font-weight:700;text-align:center;margin:0 0 6px;">Your Order Has Shipped!</h1>
    <p style="color:#6b7280;font-size:15px;text-align:center;margin:0 0 24px;line-height:1.5;">
      Order <strong style="color:#111827;">#${order.display_id}</strong> is on its way to you.
    </p>

    ${progressBar([
    { label: "Ordered", done: true },
    { label: "Prepared", done: true },
    { label: "Shipped", done: false, active: true },
    { label: "Delivered", done: false },
  ])}

    <!-- Tracking -->
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:20px;">
      <tr><td style="padding:18px 22px;">
        <div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Tracking Number</div>
        ${trackingHTML}
      </td></tr>
    </table>

    ${addressHTML ? `
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:10px;border:1px solid #e5e7eb;margin-bottom:24px;">
      <tr><td style="padding:18px 22px;">
        <div style="color:#6b7280;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;">Shipping To</div>
        ${addressHTML}
      </td></tr>
    </table>` : ""}

    ${sectionLabel("Items Shipped")}
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${itemsTable(items, currency)}
    </table>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
      <tr>
        <td style="color:#111827;font-size:16px;font-weight:700;">Total</td>
        <td style="text-align:right;color:#111827;font-size:16px;font-weight:700;">${fmt(order.total || 0, currency)}</td>
      </tr>
    </table>

    ${ctaButton("Track Your Order", `${STOREFRONT_URL}/account/orders`)}
  `)
}

function buildDeliveredEmail(order: any, isPickup: boolean): string {
  const items = order.items || []
  const currency = order.currency_code || "USD"

  return wrap(`
    <!-- Icon -->
    <div style="text-align:center;margin-bottom:20px;">
      <div style="display:inline-block;width:64px;height:64px;background:#ecfdf5;border-radius:50%;line-height:64px;font-size:30px;">🎉</div>
    </div>

    <h1 style="color:#111827;font-size:22px;font-weight:700;text-align:center;margin:0 0 6px;">
      ${isPickup ? "Order Picked Up!" : "Order Delivered!"}
    </h1>
    <p style="color:#6b7280;font-size:15px;text-align:center;margin:0 0 24px;line-height:1.5;">
      Order <strong style="color:#111827;">#${order.display_id}</strong> has been ${isPickup ? "picked up successfully" : "delivered"}. Thank you for your purchase!
    </p>

    ${progressBar([
    { label: "Ordered", done: true },
    { label: "Prepared", done: true },
    { label: isPickup ? "Ready" : "Shipped", done: true },
    { label: isPickup ? "Picked Up" : "Delivered", done: true },
  ])}

    ${sectionLabel("Order Summary")}
    <table cellpadding="0" cellspacing="0" border="0" width="100%">
      ${itemsTable(items, currency)}
    </table>

    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;padding-top:16px;border-top:2px solid #f3f4f6;">
      <tr>
        <td style="color:#111827;font-size:16px;font-weight:700;">Total</td>
        <td style="text-align:right;color:#111827;font-size:16px;font-weight:700;">${fmt(order.total || 0, currency)}</td>
      </tr>
    </table>

    <!-- Thank You -->
    <div style="text-align:center;margin-top:28px;padding:20px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
      <div style="color:#166534;font-size:15px;font-weight:600;margin-bottom:4px;">Thank you for your purchase! 💚</div>
      <div style="color:#6b7280;font-size:14px;">We appreciate your business and hope to see you again.</div>
    </div>

    ${ctaButton("Continue Shopping", STOREFRONT_URL, "#059669")}
  `)
}

// ─── Subscriber Configuration ────────────────────────────────────────────────
export const config: SubscriberConfig = {
  event: [
    "order.fulfillment_created",
    "shipment.created",
    "delivery.created",
  ],
  context: {
    subscriberId: "order-notifications-handler",
  },
}
