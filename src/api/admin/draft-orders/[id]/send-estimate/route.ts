import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import puppeteer from "puppeteer-core"

// ── PDF generator using system Chrome ────────────────────────────────────────
async function generateEstimatePdf(html: string): Promise<Buffer> {
  const CHROME_PATH =
    process.env.CHROME_EXECUTABLE_PATH ??
    "/usr/bin/google-chrome"
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: "networkidle0" })
    const pdfBuffer = await page.pdf({
      format: "Letter",
      margin: { top: "12mm", bottom: "12mm", left: "14mm", right: "14mm" },
      printBackground: true,
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await browser.close()
  }
}

// ── PDF from a live URL (frontend custom template) ────────────────────────────
async function generatePdfFromUrl(url: string): Promise<Buffer> {
  const CHROME_PATH =
    process.env.CHROME_EXECUTABLE_PATH ??
    "/usr/bin/google-chrome"
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    headless: true,
  })
  try {
    const page = await browser.newPage()
    // Wait for the page to fully render the print template
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 })
    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
    })
    return Buffer.from(pdfBuffer)
  } finally {
    await browser.close()
  }
}

// ── QB Rep mapping ────────────────────────────────────────────────────────────
const QB_REP_MAP: Record<string, string> = {
  "a.vargas@ecopowertech.com": "AVP",
  "a.guedes@ecopowertech.com": "AG",
  "j.vargas@ecopowertech.com": "JTV",
  "j.peralta@ecopowertech.com": "JCP",
  "m.perez@ecopowertech.com": "MFP",
  "a.arenas@ecopowertech.com": "AAA",
}
function resolveRepInitials(rep?: string): string {
  if (!rep) return ""
  if (rep.includes("@")) return QB_REP_MAP[rep.toLowerCase()] ?? rep
  return rep
}

// ── Logo (base64 PNG 49×53) ──────────────────────────────────────────────────
const LOGO_B64 = "iVBORw0KGgoAAAANSUhEUgAAADEAAAA1CAMAAADf0/M4AAAAqFBMVEVMaXEeKpseKpomQKAfLZtgq6weKpofKptbx70pMp0gK5khMJsfK5tazsAfK5tXwb1bzsBazb9azr9dz79VvrtCirBkd5AgKpo2aqofKppZzb9mfZFczL9Gl7RPrrk7SpYmQpwfK5v3wjhbzsBnepBWu7rou0FmgZQuVKShl21wfou0oGFMp7d5g4U8e61kjZvDqFiLjHrXsksjMJtinKRDUpU6aaZgcpLUsIt8AAAANHRSTlMAgqL+RP5g4fwQIHLP4L+DxmCdEEP8rzDrwCWFUO/vzx7////////////////////////3CT/2TAAAAAlwSFlzAAALEwAACxMBAJqcGAAAAldJREFUeJyVlutyozAMhcUl4AChzT3Z7G4HECQh98u27/9mO4aE2rKgrX5lJvrmyJZ0DACJvhvakZ8kSeLHtuX26f8k+l58S/SIvaAj36LpddjBz/JbmfCWJI7jOC2MZQjEm+NeZDL20w2H+LrMfLHPlMjfOcRVAPevml8xC4YJG2CSUyDLsmPHYX7V9dOYMohXAwMW4FXmkmgDsoy5M78P8LsVyPb86UdMqhCiTSQGeKXZvdMaEfF0F5zIDYAAvSq9jrtgREAnxAm1YHoP2lWJSqDcnq/n3UX+/DDGOdJOXgHlOa2j2CLiP0pYAJNP4o6Il+IBpGm6Q0Q6/QEoIgIRDwpQIaQuS/Z8/KpIaECaXggS1ZM4HjUSWx1Ir4g4sxvAbpxlKGVyRLwSQorMwF1W+Ut1pWA8mawQkQKpvK/KxNy56VwrxINBnBGx1eRmPyZWiKVByJZwyePhaDDomZf7ODm4tu9Hdr2ytTMMnre7I0BRIs5cn/rPy6ODJ8SyMIt6oy2HYbMaRgulhD6Lrm4lJ1JXcTCG1+8rElmWy2nfNoVdD4gfdNo9fc9lXXjYylkpztVKGfsRA2iGWCGSKh8/vnYGoRgDrnvsngtqJk9zWPdEbgKJ6VfSsWRIv2eehOizf0zkzBNnAYz5t6DN3AO1598xakubq2/UZJNR/BKImuV6MR/CP7cuACCckiNwT7qtbaHnTBsdwX8ChGRxgzhxNsfjcfHOf2f4mlk9ZJ7LycTN4g2ljWnLr5jaL7VYht3fcYFnR0r1dtjxBafE3PU8z+OsFgD+A9q9BIqtlZ3eAAAAAElFTkSuQmCC"
const LOGO_DATA_URI = `data:image/png;base64,${LOGO_B64}`

const fmt = (n: number, curr = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: curr.toUpperCase() }).format(n)

// ── Text Formatter (Basic Markdown & Spacing Fix) ─────────────────────────────
function formatPolicyText(text?: string): string {
  if (!text) return ""
  // Escape HTML
  let safe = text.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  // Parse bold (*text*)
  safe = safe.replace(/\*(.*?)\*/g, "<b>$1</b>")

  return safe.split(/\r?\n/)
    .map(line => line.trim())
    // Ignore consecutive blank lines, but allow meaningful breaks if needed.
    // For extreme compactness as requested, we remove all blank lines.
    .filter(line => line.length > 0)
    .map((line, i) => {
      // Auto-bold the first line if it looks like a section header
      if (i === 0 || line.toUpperCase() === "STORE POLICIES" || line.toUpperCase() === "PAYMENT OPTIONS") {
        return `<div style="font-weight:700;font-size:9px;margin-bottom:2px;">${line}</div>`
      }
      return `<div>${line}</div>`
    })
    .join("")
}

// ── HTML Template ─────────────────────────────────────────────────────────────
function buildEstimateHtml(params: {
  displayId: string | number
  customerName: string
  companyName?: string
  billingAddress?: any
  shippingAddress?: any
  items: any[]
  curr: string
  subtotal: number
  taxAmount: number
  taxRate: number
  shippingTotal: number
  discountTotal: number
  total: number
  notes?: string
  estimateDate: string
  rep?: string
  leadTime?: string
  orderType?: string
  paymentTerms?: string
  project?: string
  storePolicies?: string
  mode: "print" | "email"
}): string {
  const {
    displayId, customerName, companyName, billingAddress, shippingAddress,
    items, curr, subtotal, taxAmount, taxRate, shippingTotal, discountTotal, total,
    notes, estimateDate, rep, leadTime, orderType, paymentTerms, project, storePolicies, mode,
  } = params

  const isEmail = mode === "email"
  const repDisplay = resolveRepInitials(rep)
  const currUp = curr.toUpperCase()

  // Address block lines
  const addrLines = (addr: any, name: string, company?: string) => {
    return [
      company ? `<b>${company}</b>` : "",
      name,
      [addr?.address_1, addr?.address_2].filter(Boolean).join(", "),
      [addr?.city, addr?.province, addr?.postal_code].filter(Boolean).join(", "),
    ].filter(Boolean).map(l => `<div style="line-height:1.45;font-size:10px;">${l}</div>`).join("")
  }

  // Item rows — no filler rows; only real items
  const cell = `border:1px solid #d1d5db;`
  const itemRows = items.map((item, i) => {
    const sku = item.variant?.sku ?? item.variant_sku ?? ""
    // Prefer item.title if it looks like a real product name (not a Medusa entity ID).
    // If item.title is a variant ID (starts with "variant_"), fall back to the product title.
    const isEntityId = (s: string) => /^[a-z]+_[A-Z0-9]{26}$/.test(s)
    const rawTitle = item.title ?? ""
    const productTitle = (!rawTitle || isEntityId(rawTitle))
      ? (item.variant?.product?.title ?? item.variant?.title ?? rawTitle)
      : rawTitle
    const name = sku || productTitle
    const desc = productTitle !== name ? productTitle : (item.description ?? "")
    const qty = item.quantity ?? 1
    const price = item.unit_price ?? 0
    const bg = i % 2 === 0 ? "#fff" : "#f9fafb"
    const thumb = item.thumbnail ?? item.variant?.product?.thumbnail ?? item.variant?.thumbnail ?? ""

    const imgCell = isEmail
      ? `<td style="${cell}padding:3px;text-align:center;vertical-align:middle;width:48px;">
           ${thumb
        ? `<img src="${thumb}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:2px;" />`
        : `<div style="width:40px;height:40px;background:#f3f4f6;border-radius:2px;display:inline-block;"></div>`}
         </td>`
      : ""

    return `<tr style="background:${bg};">
      ${imgCell}
      <td style="${cell}padding:5px 6px;font-size:10.5px;vertical-align:top;width:13%;">${name}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;vertical-align:top;">${desc}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:center;vertical-align:top;width:5%;">${qty}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:right;vertical-align:top;width:10%;">${fmt(price, curr)}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:right;vertical-align:top;font-weight:700;width:10%;">${fmt(price * qty, curr)}</td>
    </tr>`
  }).join("")

  const taxLabel = taxRate > 0 ? `S.Tax (${taxRate}%)` : "S.Tax"
  const estNum = `E${String(displayId).padStart(8, "0")}`
  const imgHeader = isEmail
    ? `<th style="${cell}padding:4px 6px;font-size:10px;background:#f3f4f6;width:48px;">Img</th>` : ""

  const printCss = `<style>
@media print {
  @page { margin:12mm 14mm; size:letter; }
  body { margin:0 !important; display:block !important; min-height:unset !important; padding:0 !important; }
  .grow { display:none !important; }
  * { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
}
body { margin:12mm 14mm; }
</style>`
  // Auto-trigger print dialog in print mode (allows save-as-PDF from browser)
  const autoPrint = mode === "print" ? `<script>window.addEventListener('load',function(){window.print();})</script>` : ""

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Estimate ${estNum}</title>
${printCss}
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;
       display:flex;flex-direction:column;min-height:100vh;padding:14px 22px;}
  .grow{flex:1;}
  .no-break{page-break-inside:avoid;}
</style>
</head>
<body>

<!-- ═══ HEADER ═══════════════════════════════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
  <tr>
    <td style="vertical-align:middle;width:36%;">
      <table cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;padding-right:7px;">
          <img src="${LOGO_DATA_URI}" alt="EcoPowerTech" style="height:36px;width:auto;" />
        </td>
        <td style="vertical-align:middle;">
          <span style="font-size:14px;font-weight:800;color:#0f172a;letter-spacing:1px;">ECOPOWERTECH</span>
        </td>
      </tr></table>
    </td>
    <td style="vertical-align:middle;text-align:center;font-size:9px;color:#555;width:34%;">
      <div>Ecopowertech Inc.</div>
      <div>2760 W 84th St, Unit 4, Hialeah, FL 33016</div>
      <div>Phone: (305) 851-7028 &nbsp;·&nbsp; info@ecopowertech.com</div>
    </td>
    <td style="vertical-align:top;text-align:right;width:30%;">
      <div style="font-size:20px;font-weight:800;color:#111;line-height:1;">Estimate</div>
      <div style="font-size:8px;color:#777;margin-top:2px;">only valid for 30 days</div>
    </td>
  </tr>
</table>

<!-- ═══ THREE EQUAL BLOCKS: TO / SHIP TO / ESTIMATE FIELDS ═══════════ -->
<!-- Single <td> per column. Browser auto-equalizes height in same <tr>.
     Header uses a div+border-bottom inside the td — no height:100% needed. -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:0;">
  <tr>

    <!-- ── TO ──────────────────────────────────────────────────────────── -->
    <td width="33.33%" style="border:1px solid #d1d5db;vertical-align:top;padding:0;">
      <div style="border-bottom:1px solid #d1d5db;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">To</div>
      <div style="padding:6px 8px;">${addrLines(billingAddress, customerName, companyName)}</div>
    </td>

    <!-- ── SHIP TO ────────────────────────────────────────────────────── -->
    <td width="33.33%" style="border:1px solid #d1d5db;border-left:0;vertical-align:top;padding:0;">
      <div style="border-bottom:1px solid #d1d5db;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">Ship To</div>
      <div style="padding:6px 8px;">${addrLines(shippingAddress, customerName, companyName)}</div>
    </td>

    <!-- ── ESTIMATE FIELDS ─────────────────────────────────────────────── -->
    <td width="33.34%" style="border:1px solid #d1d5db;border-left:0;vertical-align:top;padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;width:42%;">Estimate #</td>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-right:0;padding:3px 7px;font-size:10px;">${estNum}</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">Date</td>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-right:0;padding:3px 7px;font-size:10px;">${estimateDate}</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">Lead Time</td>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-right:0;padding:3px 7px;font-size:10px;">${leadTime ?? ""}</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">Rep</td>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-right:0;padding:3px 7px;font-size:10px;font-weight:700;">${repDisplay}</td>
        </tr>
        <tr>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-bottom:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;">Order Type</td>
          <td style="border:1px solid #d1d5db;border-left:0;border-top:0;border-right:0;border-bottom:0;padding:3px 7px;font-size:10px;">${orderType ?? ""}</td>
        </tr>
      </table>
    </td>

  </tr>
</table>


<!-- ═══ PROJECT + PAYMENT TERMS ══════════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
  <tr>
    <td style="border:1px solid #d1d5db;border-top:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;white-space:nowrap;width:9%;">Project</td>
    <td style="border:1px solid #d1d5db;border-top:0;border-left:0;padding:3px 7px;font-size:10px;width:25%;">${project ?? ""}</td>
    <td style="border:1px solid #d1d5db;border-top:0;border-left:0;padding:3px 7px;font-size:10px;font-weight:700;background:#f3f4f6;white-space:nowrap;width:13%;">Payment Terms</td>
    <td style="border:1px solid #d1d5db;border-top:0;border-left:0;padding:3px 7px;font-size:10px;width:20%;">${paymentTerms ?? ""}</td>
    <td style="border:1px solid #d1d5db;border-top:0;border-left:0;padding:3px 7px;font-size:9px;color:#666;font-style:italic;text-align:center;">Lead time starts after reception of payment</td>
  </tr>
</table>

<!-- ═══ ITEMS TABLE ═══════════════════════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
  <thead>
    <tr style="background:#f3f4f6;">
      ${imgHeader}
      <th style="${cell}padding:4px 6px;font-size:10px;text-align:left;vertical-align:middle;width:13%;">Item</th>
      <th style="${cell}padding:4px 6px;font-size:10px;text-align:left;vertical-align:middle;">Description</th>
      <th style="${cell}padding:4px 6px;font-size:10px;text-align:center;vertical-align:middle;width:5%;">Qty</th>
      <th style="${cell}padding:4px 6px;font-size:10px;text-align:right;vertical-align:middle;width:10%;">Unit Price</th>
      <th style="${cell}padding:4px 6px;font-size:10px;text-align:right;vertical-align:middle;width:10%;">Total</th>
    </tr>
  </thead>
  <tbody>${itemRows}</tbody>
</table>

${notes ? `
<!-- ═══ NOTES (immediately after items) ════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
  <tr>
    <td style="border:1px solid #d1d5db;border-top:0;padding:6px 9px;font-size:9.5px;color:#374151;">
      <div style="font-weight:700;font-size:9px;margin-bottom:2px;">NOTES</div>
      <div style="white-space:pre-wrap;line-height:1.55;">${notes.replace(/</g, "&lt;")}</div>
    </td>
  </tr>
</table>` : ""}

<!-- ═══ FLEXIBLE SPACER ═════════════════════════════════════════════════ -->
<div class="grow"></div>

<!-- ═══ FOOTER ════════════════════════════════════════════════════════ -->
<div class="no-break" style="margin-top:6px;">
<!-- Store Policies + Totals -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr style="vertical-align:top;">
    <td style="border:1px solid #d1d5db;padding:6px 8px;font-size:8.5px;line-height:1.55;color:#374151;width:60%;">
      ${storePolicies ? formatPolicyText(storePolicies) : `<div style="font-weight:700;font-size:9px;margin-bottom:2px;">STORE POLICIES</div>
      <div><b>·REFUND</b> within 15 days. Product(s) in original condition.</div>
      <div><b>·EXCHANGE / CREDIT</b> within 30 days. Product(s) in original condition.</div>
      <div><b>·SPECIAL ORDERS</b> subject to 25% restocking fee.</div>
      <div><b>·CUSTOM ORDERS</b> not returnable nor cancellable.</div>
      <div><b>·MADE TO ORDER</b> returns subject to approval, commonly not returnable/cancellable.</div>
      <div><b>·ECOPOWERTECH</b> not responsible for damages after goods leave our premises.</div>`}
    </td>
    <td style="width:40%;vertical-align:top;border:1px solid #d1d5db;border-left:0;padding:0;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="border-bottom:1px solid #d1d5db;padding:4px 8px;font-size:11px;font-weight:700;background:#f3f4f6;">Subtotal</td>
          <td style="border-bottom:1px solid #d1d5db;border-left:1px solid #d1d5db;padding:4px 8px;font-size:11px;text-align:right;">${currUp} ${fmt(subtotal, curr)}</td>
        </tr>
        ${shippingTotal > 0 ? `<tr><td style="border-bottom:1px solid #d1d5db;padding:4px 8px;font-size:11px;font-weight:700;background:#f3f4f6;">Shipping</td><td style="border-bottom:1px solid #d1d5db;border-left:1px solid #d1d5db;padding:4px 8px;font-size:11px;text-align:right;">${currUp} ${fmt(shippingTotal, curr)}</td></tr>` : ""}
        ${discountTotal > 0 ? `<tr><td style="border-bottom:1px solid #d1d5db;padding:4px 8px;font-size:11px;font-weight:700;background:#f3f4f6;">Discount</td><td style="border-bottom:1px solid #d1d5db;border-left:1px solid #d1d5db;padding:4px 8px;font-size:11px;text-align:right;">-${currUp} ${fmt(discountTotal, curr)}</td></tr>` : ""}
        <tr>
          <td style="border-bottom:1px solid #d1d5db;padding:4px 8px;font-size:11px;font-weight:700;background:#f3f4f6;">${taxLabel}</td>
          <td style="border-bottom:1px solid #d1d5db;border-left:1px solid #d1d5db;padding:4px 8px;font-size:11px;text-align:right;">${currUp} ${fmt(taxAmount, curr)}</td>
        </tr>
        <tr>
          <td style="padding:6px 8px;font-size:13px;font-weight:800;background:#0f172a;color:#fff;">Total</td>
          <td style="border-left:1px solid #d1d5db;padding:6px 8px;font-size:13px;font-weight:800;background:#0f172a;color:#fff;text-align:right;">${currUp} ${fmt(total, curr)}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<!-- Validity -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>
    <td style="border:1px solid #d1d5db;border-top:0;padding:5px 7px;font-size:8.5px;color:#555;font-style:italic;">
      Unless otherwise indicated, written quotations shall expire automatically thirty (30) days after the date appearing on the quotation.
    </td>
  </tr>
</table>

<!-- Payment Options -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>
    <td style="border:1px solid #d1d5db;border-top:0;padding:6px 8px;font-size:8.5px;line-height:1.65;color:#374151;">
      <div style="font-weight:700;font-size:9px;margin-bottom:1px;">Payment Options</div>
      <div>· <b>Cash</b> – pay in store. &nbsp;· <b>Credit Card</b> – in store or request a secure payment link by email. &nbsp;· <b>Check</b> – payable to "Ecopowertech, INC" (cleared check required).</div>
      <div>· <b>Wire transfer</b> – JP Morgan Chase, Acct.#949187223, ABA: 267084131, SWIFT: CHASUS33. &nbsp;· <b>Zelle</b> – payments@ecopowertech.com (include Estimate # in note).</div>
    </td>
  </tr>
</table>

<!-- Footer note -->
<div style="text-align:center;margin-top:5px;font-size:8.5px;color:#999;">
  Thank you for your business! &nbsp;·&nbsp; <b>www.ecopowertech.com</b>
</div>
</div>

${autoPrint}
</body>
</html>`
}

// ── Fetch order + draft-order preview (mirrors use-draft-order-detail) ────────
async function fetchOrderWithPreview(req: MedusaRequest, id: string) {
  const headers = {
    "Cookie": req.headers["cookie"] ?? "",
    "Authorization": req.headers["authorization"] ?? "",
  }
  const base = `http://localhost:${process.env.PORT ?? 9000}`
  const [oRes, dRes, sysRes] = await Promise.all([
    fetch(`${base}/admin/orders/${id}?fields=+customer.*,+shipping_address.*,+billing_address.*,+items.*,+items.adjustments.*,+items.thumbnail,+items.variant.*,+items.variant.product.title,+items.variant.product.thumbnail,+shipping_methods.*,+metadata,+currency_code,+display_id,+email`, { headers }),
    fetch(`${base}/admin/draft-orders/${id}`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${base}/admin/system-defaults`, { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
  ])
  if (!oRes.ok) return null
  const { order: raw } = await oRes.json()
  const preview = dRes?.order ?? dRes?.draft_order ?? null
  const sysDefaults = sysRes?.defaults ?? []
  const norm = (cents: number) => cents > 100 ? cents / 100 : cents

  // IMPORTANT: Use raw.items from /admin/orders as the base — it has correct product
  // title and thumbnail (joined via variant → product). The draft-order preview endpoint
  // stores item.title as the variant ID for some items, causing the wrong title to show.
  // We only need the preview's unit_price (which is already in the correct pricing tier).
  const priceMap = new Map<string, number>(
    (preview?.items ?? []).map((i: any) => [i.id as string, norm(i.unit_price ?? 0)])
  )
  const mergedItems = (raw.items ?? []).map((i: any) => ({
    ...i,
    unit_price: priceMap.has(i.id) ? priceMap.get(i.id)! : norm(i.unit_price ?? 0),
  }))

  return {
    ...raw,
    items: mergedItems.filter((i: any) => i.quantity > 0),
    subtotal: preview?.subtotal != null ? preview.subtotal / 100 : raw.subtotal ?? 0,
    shipping_total: preview?.shipping_total != null ? preview.shipping_total / 100 : raw.shipping_total ?? 0,
    discount_total: preview?.discount_total != null ? preview.discount_total / 100 : raw.discount_total ?? 0,
    tax_total: preview?.tax_total != null ? preview.tax_total / 100 : raw.tax_total ?? 0,
    _systemDefaults: sysDefaults,
  }
}

function buildTotals(order: any) {
  const subtotal: number = (order.items ?? []).reduce((s: number, i: any) => s + (i.unit_price ?? 0) * (i.quantity ?? 1), 0)
  const taxAmount: number = order.metadata?.computed_tax_amount ?? order.tax_total ?? 0
  const taxRate: number = order.metadata?.computed_tax_rate ?? 0
  const shippingTotal: number = order.shipping_total ?? 0
  // Use raw item adjustment amounts (pre-tax) — NOT order.discount_total which Medusa inflates
  // by multiplying with (1 + tax_rate) for its own "effective savings" display metric.
  // item.adjustments[].amount is the actual pre-tax deduction stored in DB.
  const discountTotal: number = (order.items ?? []).reduce((s: number, i: any) => {
    return s + (i.adjustments ?? []).reduce((a: number, adj: any) => a + (Number(adj.amount) || 0), 0)
  }, 0) || (order.discount_total ?? 0)
  const total: number = subtotal + shippingTotal - discountTotal + taxAmount
  const customer = order.customer
  const customerName = customer
    ? `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() || customer.email
    : order.email ?? "Customer"
  const estimateDate = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" })
  return { subtotal, taxAmount, taxRate, shippingTotal, discountTotal, total, customerName, customer, estimateDate }
}

function buildParams(order: any, mode: "print" | "email") {
  const { subtotal, taxAmount, taxRate, shippingTotal, discountTotal, total, customerName, estimateDate } = buildTotals(order)
  const m = order.metadata ?? {}
  return {
    displayId: order.display_id, customerName,
    companyName: order.customer?.company_name,
    billingAddress: order.billing_address, shippingAddress: order.shipping_address,
    items: order.items ?? [], curr: order.currency_code ?? "usd",
    subtotal, taxAmount, taxRate, shippingTotal, discountTotal, total,
    notes: m.estimate_notes, estimateDate,
    rep: m.estimate_rep, leadTime: m.estimate_lead_time,
    orderType: m.estimate_order_type, paymentTerms: m.estimate_payment_terms,
    project: m.estimate_project,
    storePolicies: order._systemDefaults?.find((d: any) => d.context === "Templates Footer" && d.field_name === "Draft Order (Estimates)")?.value,
    mode,
  }
}

// ── GET — HTML preview (?mode=print | email) ─────────────────────────────────
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params as { id: string }
  const mode = (req.query?.mode === "print" ? "print" : "email") as "print" | "email"
  const order = await fetchOrderWithPreview(req, id)
  if (!order) return void res.status(404).json({ message: "Order not found" })
  const html = buildEstimateHtml(buildParams(order, mode))
  res.setHeader("Content-Type", "text/html")
  res.status(200).send(html)
}

// ── POST — generate PDF and send as attachment ─────────────────────────────────
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params as { id: string }
  const { to: toOverride, cc: ccOverride, subject: subjectOverride, templateId, docId, displayId: displayIdOverride } = (req.body ?? {}) as any
  const order = await fetchOrderWithPreview(req, id)
  if (!order) return void res.status(404).json({ message: "Order not found" })
  const { customer, total } = buildTotals(order)
  const customerEmail = toOverride ?? customer?.email ?? order.email
  if (!customerEmail) return void res.status(400).json({ message: "No customer email found" })

  const apiKey = process.env.SENDGRID_API_KEY
  const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? process.env.SENDGRID_FROM ?? "estimates@ecopowertech.com"
  if (!apiKey) return void res.status(200).json({ success: false, preview_only: true, message: "SENDGRID_API_KEY not set." })

  const params = buildParams(order, "email")
  const displayId = displayIdOverride ?? order.display_id
  const estNum = `E${String(displayId).padStart(8, "0")}`
  const emailSubject = subjectOverride ?? `Estimate ${estNum} from EcoPowerTech`

  // Generate PDF — prefer frontend template (Puppeteer on print page URL), fallback to backend HTML
  let pdfBuffer: Buffer | null = null
  try {
    if (templateId && docId) {
      // Use the frontend custom template: render the print page via Puppeteer
      const POS_URL = process.env.POS_FRONTEND_URL ?? process.env.NEXT_PUBLIC_POS_URL ?? "http://localhost:3001"
      const params = new URLSearchParams({ docId, auto: "0" })
      if (displayId) params.set("displayId", String(displayId))
      const printUrl = `${POS_URL}/print/${templateId}?${params}`
      console.log(`[send-estimate] Using frontend template PDF: ${printUrl}`)
      pdfBuffer = await generatePdfFromUrl(printUrl)
    } else {
      // Fallback: use the backend-generated HTML template
      const pdfHtml = buildEstimateHtml(params)
      pdfBuffer = await generateEstimatePdf(pdfHtml)
    }
  } catch (err) {
    console.error("[send-estimate] PDF generation failed, falling back to HTML email:", err)
  }

  const customerName = params.customerName
  const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: (order.currency_code ?? "USD").toUpperCase() }).format(n)

  // Clean email body (no invoice HTML inline)
  const emailBodyHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>
  body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;background:#fff;margin:0;padding:0;}
  .wrap{max-width:560px;margin:32px auto;padding:0 16px;}
  .logo{display:flex;align-items:center;gap:8px;margin-bottom:24px;}
  .logo span{font-size:16px;font-weight:800;letter-spacing:1px;color:#0f172a;}
  h2{font-size:18px;margin:0 0 8px;}
  .box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin:20px 0;font-size:13px;line-height:1.7;}
  .total{font-weight:700;font-size:15px;}
  .btn{display:inline-block;margin-top:20px;padding:10px 22px;background:#0f172a;color:#fff;text-decoration:none;border-radius:5px;font-size:13px;font-weight:600;}
  .footer{margin-top:32px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px;}
</style></head>
<body>
<div class="wrap">
  <div class="logo">
    <img src="https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png" alt="" style="height:32px;" />
    <span>ECOPOWERTECH</span>
  </div>

  <h2>Your Estimate is Ready</h2>
  <p style="margin:0 0 4px;">Dear ${customerName},</p>
  <p style="margin:0 0 16px;color:#555;">Thank you for your interest. Please find your estimate attached as a PDF.</p>

  <div class="box">
    <div><b>Estimate #:</b> ${estNum}</div>
    <div><b>Date:</b> ${params.estimateDate}</div>
    ${params.leadTime ? `<div><b>Lead Time:</b> ${params.leadTime}</div>` : ""}
    ${params.orderType ? `<div><b>Order Type:</b> ${params.orderType}</div>` : ""}
    <div class="total" style="margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;">Total: ${fmt(total)}</div>
  </div>

  <p style="color:#555;font-size:13px;">If you have any questions, please don't hesitate to reach out.</p>

  <div class="footer">
    Ecopowertech Inc. &nbsp;·&nbsp; 2760 W 84th St, Unit 4, Hialeah, FL 33016<br>
    Phone: (305) 851-7028 &nbsp;·&nbsp; info@ecopowertech.com &nbsp;·&nbsp; www.ecopowertech.com
  </div>
</div>
</body>
</html>`

  const sgMail = await import("@sendgrid/mail")
  sgMail.default.setApiKey(apiKey)

  const msg: any = {
    to: customerEmail,
    from: { email: fromEmail, name: "EcoPowerTech" },
    subject: emailSubject,
    html: emailBodyHtml,
    ...(ccOverride ? { cc: ccOverride } : {}),
  }

  if (pdfBuffer) {
    msg.attachments = [{
      content: pdfBuffer.toString("base64"),
      filename: `${estNum}.pdf`,
      type: "application/pdf",
      disposition: "attachment",
    }]
  } else {
    // Fallback: attach HTML version as a note if PDF failed
    msg.html += `<p style="color:#dc2626;font-size:11px;margin-top:12px;">Note: PDF could not be generated. Please contact us for the document.</p>`
  }

  await sgMail.default.send(msg)

  // Update estimate metadata via REST PATCH (reliable — same path the UI uses)
  try {
    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const metaHeaders = {
      "Cookie": req.headers["cookie"] ?? "",
      "Authorization": req.headers["authorization"] ?? "",
      "Content-Type": "application/json",
    }
    // Resolve the name of the admin user who sent the estimate
    let senderName: string | undefined
    try {
      const meRes = await fetch(`${base}/admin/users/me`, { headers: metaHeaders })
      if (meRes.ok) {
        const { user: me } = await meRes.json()
        senderName = `${me?.first_name ?? ""} ${me?.last_name ?? ""}`.trim() || me?.email || undefined
      }
    } catch { /* best-effort */ }

    // Read current metadata, merge, then PATCH
    const curRes = await fetch(`${base}/admin/orders/${id}?fields=id,+metadata`, { headers: metaHeaders })
    const curMeta = curRes.ok ? ((await curRes.json()).order?.metadata ?? {}) : {}
    const newStatus = curMeta.estimate_status === "Created" ? "Sent" : (curMeta.estimate_status ?? "Sent")
    await fetch(`${base}/admin/draft-orders/${id}`, {
      method: "POST",
      headers: metaHeaders,
      body: JSON.stringify({
        metadata: {
          ...curMeta,
          estimate_sent_at: new Date().toISOString(),
          estimate_sent_to: customerEmail,
          estimate_sent_by: senderName,
          estimate_status: newStatus,
        },
      }),
    })
  } catch { /* non-critical */ }

  res.status(200).json({ success: true, sent_to: customerEmail, pdf_generated: !!pdfBuffer })
}
