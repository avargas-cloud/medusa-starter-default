import { existsSync, readdirSync } from "fs";
import { join } from "path";

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Client as PgClient } from "pg";
import { chromium as playwrightChromium } from "playwright-core";

import { sendMail } from "../../../../../utils/mailer";

// ── Template prefetch (avoids headless browser needing an authenticated API call) ──
async function dbConnect() {
  const db = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_URL?.includes("railway") ||
      process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  });
  await db.connect();
  return db;
}

async function fetchTemplateForPdf(
  templateId: string
): Promise<Record<string, unknown> | null> {
  const db = await dbConnect();
  try {
    const result = await db.query(
      "SELECT * FROM pos_document_template WHERE id = $1",
      [templateId]
    );
    return (result.rows[0] as Record<string, unknown>) ?? null;
  } catch (err) {
    console.error("[send-email] Failed to prefetch template:", err);
    return null;
  } finally {
    await db.end();
  }
}

// Returns the default template id for a given doc type (used when the frontend didn't provide one)
async function fetchDefaultTemplateId(docType: string): Promise<string | null> {
  const db = await dbConnect();
  try {
    const result = await db.query(
      "SELECT id FROM pos_document_template WHERE doc_type = $1 AND is_default = true LIMIT 1",
      [docType]
    );
    if (result.rows[0]) return (result.rows[0] as { id: string }).id;
    // No default flagged — take the first one
    const fallback = await db.query(
      "SELECT id FROM pos_document_template WHERE doc_type = $1 LIMIT 1",
      [docType]
    );
    return (fallback.rows[0] as { id: string } | undefined)?.id ?? null;
  } catch (err) {
    console.error("[send-email] Failed to fetch default template:", err);
    return null;
  } finally {
    await db.end();
  }
}

// ── Browser launcher ──────────────────────────────────────────────────────────
// Production (Railway): connects to Browserless sidecar via ws://browserless.railway.internal:8080
//   Uses ws:// directly — http:// triggers a /json/version lookup that returns 0.0.0.0 as the host.
// Local dev: falls back to playwright's installed Chromium (~/.cache/ms-playwright)
async function launchBrowser() {
  // On Railway, connect to the Browserless sidecar service via private networking.
  // RAILWAY_ENVIRONMENT is auto-injected by Railway in all containers — no extra env vars needed.
  // Override with BROWSERLESS_URL if you need to point to a different instance.
  // Use ws:// directly so Playwright skips the /json/version HTTP lookup.
  // That lookup returns a WebSocket URL with host=0.0.0.0 (the container's bind address),
  // which is unreachable from other containers.
  const browserlessUrl =
    process.env.BROWSERLESS_URL ??
    (process.env.RAILWAY_ENVIRONMENT
      ? "ws://browserless.railway.internal:8080"
      : null);

  if (browserlessUrl) {
    console.log(`[chrome] Connecting to Browserless: ${browserlessUrl}`);
    return playwrightChromium.connectOverCDP(browserlessUrl);
  }

  // Local dev fallback: find playwright's installed Chromium
  const homeCache = process.env.HOME
    ? join(process.env.HOME, ".cache/ms-playwright")
    : null;
  let execPath = process.env.CHROME_EXECUTABLE_PATH ?? "";
  for (const root of [homeCache, "/root/.cache/ms-playwright"].filter(
    Boolean
  ) as string[]) {
    if (execPath || !existsSync(root)) continue;
    for (const entry of readdirSync(root).filter((e) =>
      e.startsWith("chromium")
    )) {
      for (const variant of [
        "chrome-headless-shell-linux64/chrome-headless-shell",
        "chrome-linux64/chrome",
      ]) {
        const candidate = join(root, entry, variant);
        if (existsSync(candidate)) {
          execPath = candidate;
          break;
        }
      }
      if (execPath) break;
    }
  }
  if (!execPath) execPath = playwrightChromium.executablePath();
  console.log(`[chrome] Launching local: ${execPath}`);
  return playwrightChromium.launch({
    executablePath: execPath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
    ],
    headless: true,
  });
}

// ── PDF generator from inline HTML ───────────────────────────────────────────
async function generateEstimatePdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfBuffer = await page.pdf({
      format: "Letter",
      margin: { top: "12mm", bottom: "12mm", left: "14mm", right: "14mm" },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

// ── PDF from a live URL (frontend custom template) ────────────────────────────
async function generatePdfFromUrl(
  url: string,
  posState?: string,
  templateData?: Record<string, unknown> | null
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();

    // Match viewport to Letter paper at 96 dpi (215.9 mm × 279.4 mm).
    // Without this, Playwright's 1280 px default viewport causes the headless
    // engine to scale down the 816 px doc-page, shifting absolutely-positioned
    // blocks and breaking the template layout in the generated PDF.
    await page.setViewportSize({ width: 816, height: 1056 });

    // Always inject localStorage — we need at least posState and the pre-fetched template.
    // The print page reads pdf-template-injection as a fallback when there's no auth token
    // in memory (the authStore intentionally excludes token from localStorage persistence).
    const originUrl = new URL(url).origin;
    await page.goto(originUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ([state, tmpl]: [string | undefined, string | null]) => {
        if (state) localStorage.setItem("pos-documents", state);
        if (tmpl) localStorage.setItem("pdf-template-injection", tmpl);
      },
      [posState, templateData ? JSON.stringify(templateData) : null] as [
        string | undefined,
        string | null,
      ]
    );

    // Navigate; networkidle alone isn't enough — React state settles after network is quiet.
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    // Wait for the React component to signal it has finished rendering
    // (PrintPageInner sets data-pdf-ready on body when doc + template are both loaded).
    await page.waitForSelector("[data-pdf-ready]", { timeout: 20000 });
    const pdfBuffer = await page.pdf({
      format: "Letter",
      printBackground: true,
      scale: 1,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
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
};
function resolveRepInitials(rep?: string): string {
  if (!rep) return "";
  if (rep.includes("@")) return QB_REP_MAP[rep.toLowerCase()] ?? rep;
  return rep;
}

// ── Logo (base64 PNG 49×53) ──────────────────────────────────────────────────
const LOGO_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAADEAAAA1CAMAAADf0/M4AAAAqFBMVEVMaXEeKpseKpomQKAfLZtgq6weKpofKptbx70pMp0gK5khMJsfK5tazsAfK5tXwb1bzsBazb9azr9dz79VvrtCirBkd5AgKpo2aqofKppZzb9mfZFczL9Gl7RPrrk7SpYmQpwfK5v3wjhbzsBnepBWu7rou0FmgZQuVKShl21wfou0oGFMp7d5g4U8e61kjZvDqFiLjHrXsksjMJtinKRDUpU6aaZgcpLUsIt8AAAANHRSTlMAgqL+RP5g4fwQIHLP4L+DxmCdEEP8rzDrwCWFUO/vzx7////////////////////////3CT/2TAAAAAlwSFlzAAALEwAACxMBAJqcGAAAAldJREFUeJyVlutyozAMhcUl4AChzT3Z7G4HECQh98u27/9mO4aE2rKgrX5lJvrmyJZ0DACJvhvakZ8kSeLHtuX26f8k+l58S/SIvaAj36LpddjBz/JbmfCWJI7jOC2MZQjEm+NeZDL20w2H+LrMfLHPlMjfOcRVAPevml8xC4YJG2CSUyDLsmPHYX7V9dOYMohXAwMW4FXmkmgDsoy5M78P8LsVyPb86UdMqhCiTSQGeKXZvdMaEfF0F5zIDYAAvSq9jrtgREAnxAm1YHoP2lWJSqDcnq/n3UX+/DDGOdJOXgHlOa2j2CLiP0pYAJNP4o6Il+IBpGm6Q0Q6/QEoIgIRDwpQIaQuS/Z8/KpIaECaXggS1ZM4HjUSWx1Ir4g4sxvAbpxlKGVyRLwSQorMwF1W+Ut1pWA8mawQkQKpvK/KxNy56VwrxINBnBGx1eRmPyZWiKVByJZwyePhaDDomZf7ODm4tu9Hdr2ytTMMnre7I0BRIs5cn/rPy6ODJ8SyMIt6oy2HYbMaRgulhD6Lrm4lJ1JXcTCG1+8rElmWy2nfNoVdD4gfdNo9fc9lXXjYylkpztVKGfsRA2iGWCGSKh8/vnYGoRgDrnvsngtqJk9zWPdEbgKJ6VfSsWRIv2eehOizf0zkzBNnAYz5t6DN3AO1598xakubq2/UZJNR/BKImuV6MR/CP7cuACCckiNwT7qtbaHnTBsdwX8ChGRxgzhxNsfjcfHOf2f4mlk9ZJ7LycTN4g2ljWnLr5jaL7VYht3fcYFnR0r1dtjxBafE3PU8z+OsFgD+A9q9BIqtlZ3eAAAAAElFTkSuQmCC";
const LOGO_DATA_URI = `data:image/png;base64,${LOGO_B64}`;

const fmt = (n: number, curr = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: curr.toUpperCase(),
  }).format(n);

// ── Text Formatter (Basic Markdown & Spacing Fix) ─────────────────────────────
function formatPolicyText(text?: string): string {
  if (!text) return "";
  // Escape HTML
  let safe = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Parse bold (*text*)
  safe = safe.replace(/\*(.*?)\*/g, "<b>$1</b>");

  return (
    safe
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Ignore consecutive blank lines, but allow meaningful breaks if needed.
      // For extreme compactness as requested, we remove all blank lines.
      .filter((line) => line.length > 0)
      .map((line, i) => {
        // Auto-bold the first line if it looks like a section header
        if (
          i === 0 ||
          line.toUpperCase() === "STORE POLICIES" ||
          line.toUpperCase() === "PAYMENT OPTIONS"
        ) {
          return `<div style="font-weight:700;font-size:9px;margin-bottom:2px;">${line}</div>`;
        }
        return `<div>${line}</div>`;
      })
      .join("")
  );
}

// ── HTML Template ─────────────────────────────────────────────────────────────
function buildEstimateHtml(params: {
  displayId: string | number;
  customerName: string;
  companyName?: string;
  billingAddress?: any;
  shippingAddress?: any;
  items: any[];
  curr: string;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  shippingTotal: number;
  discountTotal: number;
  total: number;
  notes?: string;
  estimateDate: string;
  rep?: string;
  leadTime?: string;
  orderType?: string;
  paymentTerms?: string;
  project?: string;
  storePolicies?: string;
  mode: "print" | "email";
}): string {
  const {
    displayId,
    customerName,
    companyName,
    billingAddress,
    shippingAddress,
    items,
    curr,
    subtotal,
    taxAmount,
    taxRate,
    shippingTotal,
    discountTotal,
    total,
    notes,
    estimateDate,
    rep,
    leadTime,
    orderType,
    paymentTerms,
    project,
    storePolicies,
    mode,
  } = params;

  const isEmail = mode === "email";
  const repDisplay = resolveRepInitials(rep);
  const currUp = curr.toUpperCase();

  // Address block lines
  const addrLines = (addr: any, name: string, company?: string) => {
    return [
      company ? `<b>${company}</b>` : "",
      name,
      [addr?.address_1, addr?.address_2].filter(Boolean).join(", "),
      [addr?.city, addr?.province, addr?.postal_code]
        .filter(Boolean)
        .join(", "),
    ]
      .filter(Boolean)
      .map((l) => `<div style="line-height:1.45;font-size:10px;">${l}</div>`)
      .join("");
  };

  // Item rows — no filler rows; only real items
  const cell = `border:1px solid #d1d5db;`;
  const itemRows = items
    .map((item, i) => {
      const sku = item.variant?.sku ?? item.variant_sku ?? "";
      // Prefer item.title if it looks like a real product name (not a Medusa entity ID).
      // If item.title is a variant ID (starts with "variant_"), fall back to the product title.
      const isEntityId = (s: string) => /^[a-z]+_[A-Z0-9]{26}$/.test(s);
      const rawTitle = item.title ?? "";
      const productTitle =
        !rawTitle || isEntityId(rawTitle)
          ? (item.variant?.product?.title ?? item.variant?.title ?? rawTitle)
          : rawTitle;
      const name = sku || productTitle;
      const desc =
        productTitle !== name ? productTitle : (item.description ?? "");
      const qty = item.quantity ?? 1;
      const price = item.unit_price ?? 0;
      const bg = i % 2 === 0 ? "#fff" : "#f9fafb";
      const thumb =
        item.thumbnail ??
        item.variant?.product?.thumbnail ??
        item.variant?.thumbnail ??
        "";

      const imgCell = isEmail
        ? `<td style="${cell}padding:3px;text-align:center;vertical-align:middle;width:48px;">
           ${
             thumb
               ? `<img src="${thumb}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:2px;" />`
               : `<div style="width:40px;height:40px;background:#f3f4f6;border-radius:2px;display:inline-block;"></div>`
           }
         </td>`
        : "";

      return `<tr style="background:${bg};">
      ${imgCell}
      <td style="${cell}padding:5px 6px;font-size:10.5px;vertical-align:top;width:13%;">${name}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;vertical-align:top;">${desc}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:center;vertical-align:top;width:5%;">${qty}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:right;vertical-align:top;width:10%;">${fmt(price, curr)}</td>
      <td style="${cell}padding:5px 6px;font-size:10.5px;text-align:right;vertical-align:top;font-weight:700;width:10%;">${fmt(price * qty, curr)}</td>
    </tr>`;
    })
    .join("");

  const taxLabel = taxRate > 0 ? `S.Tax (${taxRate}%)` : "S.Tax";
  const estNum = `E${String(displayId).padStart(8, "0")}`;
  const imgHeader = isEmail
    ? `<th style="${cell}padding:4px 6px;font-size:10px;background:#f3f4f6;width:48px;">Img</th>`
    : "";

  const printCss = `<style>
@media print {
  @page { margin:12mm 14mm; size:letter; }
  body { margin:0 !important; display:block !important; min-height:unset !important; padding:0 !important; }
  .grow { display:none !important; }
  * { -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
}
body { margin:12mm 14mm; }
</style>`;
  // Auto-trigger print dialog in print mode (allows save-as-PDF from browser)
  const autoPrint =
    mode === "print"
      ? `<script>window.addEventListener('load',function(){window.print();})</script>`
      : "";

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
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;table-layout:fixed;">
  <tr>
    <td style="vertical-align:middle;width:36%;overflow:hidden;">
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

${
  notes
    ? `
<!-- ═══ NOTES (immediately after items) ════════════════════════════════ -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:6px;">
  <tr>
    <td style="border:1px solid #d1d5db;border-top:0;padding:6px 9px;font-size:9.5px;color:#374151;">
      <div style="font-weight:700;font-size:9px;margin-bottom:2px;">NOTES</div>
      <div style="white-space:pre-wrap;line-height:1.55;">${notes.replace(/</g, "&lt;")}</div>
    </td>
  </tr>
</table>`
    : ""
}

<!-- ═══ FLEXIBLE SPACER ═════════════════════════════════════════════════ -->
<div class="grow"></div>

<!-- ═══ FOOTER ════════════════════════════════════════════════════════ -->
<div class="no-break" style="margin-top:6px;">
<!-- Store Policies + Totals -->
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr style="vertical-align:top;">
    <td style="border:1px solid #d1d5db;padding:6px 8px;font-size:8.5px;line-height:1.55;color:#374151;width:60%;">
      ${
        storePolicies
          ? formatPolicyText(storePolicies)
          : `<div style="font-weight:700;font-size:9px;margin-bottom:2px;">STORE POLICIES</div>
      <div><b>·REFUND</b> within 15 days. Product(s) in original condition.</div>
      <div><b>·EXCHANGE / CREDIT</b> within 30 days. Product(s) in original condition.</div>
      <div><b>·SPECIAL ORDERS</b> subject to 25% restocking fee.</div>
      <div><b>·CUSTOM ORDERS</b> not returnable nor cancellable.</div>
      <div><b>·MADE TO ORDER</b> returns subject to approval, commonly not returnable/cancellable.</div>
      <div><b>·ECOPOWERTECH</b> not responsible for damages after goods leave our premises.</div>`
      }
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
</html>`;
}

// ── Fetch order + draft-order preview (mirrors use-draft-order-detail) ────────
async function fetchOrderWithPreview(req: MedusaRequest, id: string) {
  const headers = {
    Cookie: req.headers["cookie"] ?? "",
    Authorization: req.headers["authorization"] ?? "",
  };
  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const [oRes, dRes, sysRes] = await Promise.all([
    fetch(
      `${base}/admin/orders/${id}?fields=+customer.*,+shipping_address.*,+billing_address.*,+items.*,+items.adjustments.*,+items.thumbnail,+items.variant.*,+items.variant.product.title,+items.variant.product.thumbnail,+shipping_methods.*,+metadata,+currency_code,+display_id,+email`,
      { headers }
    ),
    fetch(`${base}/admin/draft-orders/${id}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch(`${base}/admin/system-defaults`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  if (!oRes.ok) return null;
  const { order: raw } = await oRes.json();
  const preview = dRes?.order ?? dRes?.draft_order ?? null;
  const sysDefaults = sysRes?.defaults ?? [];
  const norm = (cents: number) => (cents > 100 ? cents / 100 : cents);

  // IMPORTANT: Use raw.items from /admin/orders as the base — it has correct product
  // title and thumbnail (joined via variant → product). The draft-order preview endpoint
  // stores item.title as the variant ID for some items, causing the wrong title to show.
  // We only need the preview's unit_price (which is already in the correct pricing tier).
  const priceMap = new Map<string, number>(
    (preview?.items ?? []).map((i: any) => [
      i.id as string,
      norm(i.unit_price ?? 0),
    ])
  );
  const mergedItems = (raw.items ?? []).map((i: any) => ({
    ...i,
    unit_price: priceMap.has(i.id)
      ? priceMap.get(i.id)!
      : norm(i.unit_price ?? 0),
  }));

  return {
    ...raw,
    items: mergedItems.filter((i: any) => i.quantity > 0),
    subtotal:
      preview?.subtotal != null
        ? preview.subtotal / 100
        : (raw.subtotal ?? 0) / 100,
    shipping_total:
      preview?.shipping_total != null
        ? preview.shipping_total / 100
        : (raw.shipping_total ?? 0) / 100,
    discount_total:
      preview?.discount_total != null
        ? preview.discount_total / 100
        : (raw.discount_total ?? 0) / 100,
    tax_total:
      preview?.tax_total != null
        ? preview.tax_total / 100
        : (raw.tax_total ?? 0) / 100,
    _systemDefaults: sysDefaults,
  };
}

function buildTotals(order: any) {
  const subtotal: number =
    order.subtotal ??
    (order.items ?? []).reduce(
      (s: number, i: any) => s + (i.unit_price ?? 0) * (i.quantity ?? 1),
      0
    );
  const taxAmount: number =
    order.metadata?.computed_tax_amount ?? order.tax_total ?? 0;
  const taxRate: number = order.metadata?.computed_tax_rate ?? 0;
  const shippingTotal: number = order.shipping_total ?? 0;
  // Use raw item adjustment amounts (pre-tax) — NOT order.discount_total which Medusa inflates
  // by multiplying with (1 + tax_rate) for its own "effective savings" display metric.
  // item.adjustments[].amount is the actual pre-tax deduction stored in DB.
  const discountTotal: number =
    (order.items ?? []).reduce((s: number, i: any) => {
      return (
        s +
        (i.adjustments ?? []).reduce(
          (a: number, adj: any) => a + (Number(adj.amount) || 0) / 100,
          0
        )
      );
    }, 0) ||
    (order.discount_total ?? 0);
  const total: number =
    order.total ?? subtotal + shippingTotal - discountTotal + taxAmount;
  const customer = order.customer;
  const customerName = customer
    ? `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim() ||
      customer.email
    : (order.email ?? "Customer");
  const estimateDate = new Date().toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "numeric",
  });
  return {
    subtotal,
    taxAmount,
    taxRate,
    shippingTotal,
    discountTotal,
    total,
    customerName,
    customer,
    estimateDate,
  };
}

function buildParams(order: any, mode: "print" | "email") {
  const {
    subtotal,
    taxAmount,
    taxRate,
    shippingTotal,
    discountTotal,
    total,
    customerName,
    estimateDate,
  } = buildTotals(order);
  const m = order.metadata ?? {};
  return {
    displayId: order.display_id,
    customerName,
    companyName: order.customer?.company_name,
    billingAddress: order.billing_address,
    shippingAddress: order.shipping_address,
    items: order.items ?? [],
    curr: order.currency_code ?? "usd",
    subtotal,
    taxAmount,
    taxRate,
    shippingTotal,
    discountTotal,
    total,
    notes: m.estimate_notes,
    estimateDate,
    rep: m.estimate_rep,
    leadTime: m.estimate_lead_time,
    orderType: m.estimate_order_type,
    paymentTerms: m.estimate_payment_terms,
    project: m.estimate_project,
    storePolicies: order._systemDefaults?.find(
      (d: any) =>
        d.context === "Templates Footer" &&
        d.field_name === "Draft Order (Estimates)"
    )?.value,
    mode,
  };
}

// ── GET — HTML preview (?mode=print | email) ─────────────────────────────────
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const mode = (req.query?.mode === "print" ? "print" : "email") as
    | "print"
    | "email";
  const order = await fetchOrderWithPreview(req, id);
  if (!order) return void res.status(404).json({ message: "Order not found" });
  const html = buildEstimateHtml(buildParams(order, mode));
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(html);
}

// ── Payment link helpers ──────────────────────────────────────────────────────

function buildPaymentCard(
  paymentUrl: string,
  amountDisplay: string,
  baseDisplay?: string,
  feeDisplay?: string,
  note?: string
): string {
  const breakdownHtml =
    baseDisplay && feeDisplay
      ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#475569;margin-bottom:12px;line-height:1.5;">
      <tr>
        <td style="padding-bottom:8px;border-bottom:1px solid #e2e8f0;text-align:left;">Total Due:</td>
        <td style="padding-bottom:8px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#0f172a;">${baseDisplay}</td>
      </tr>
      <tr>
        <td style="padding-top:8px;text-align:left;">Card Processing Fee (3%):</td>
        <td style="padding-top:8px;text-align:right;font-weight:600;color:#0f172a;">${feeDisplay}</td>
      </tr>
    </table>
  `
      : `<p style="margin:4px 0 12px;color:#64748b;font-size:13px;">* Includes 3% credit card processing fee</p>`;

  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;margin:24px 0;border-collapse:separate;box-shadow:0 4px 6px -1px rgba(0,0,0,0.02),0 2px 4px -1px rgba(0,0,0,0.02);">
  <tr><td style="padding:32px;">
    <h3 style="margin:0 0 ${note ? '8px' : '16px'};color:#0f172a;font-size:18px;font-weight:700;letter-spacing:-0.02em;">Payment Request</h3>
    ${note ? `<p style="margin:0 0 16px;color:#64748b;font-size:14px;line-height:1.5;">${note}</p>` : ''}
    ${breakdownHtml}
    <div style="background:#f8fafc;border-radius:8px;border:1px solid #f1f5f9;padding:24px;margin:20px 0;text-align:center;">
      <p style="margin:0 0 4px;color:#64748b;font-size:13px;font-weight:500;text-transform:uppercase;letter-spacing:0.05em;">Total to pay</p>
      <p style="margin:0;color:#1d3b8e;font-size:36px;font-weight:800;line-height:1;letter-spacing:-0.03em;">${amountDisplay}</p>
    </div>
    <table cellpadding="0" cellspacing="0" width="100%" style="margin:28px 0 20px;">
      <tr><td style="text-align:center;">
        <a href="${paymentUrl}" style="display:inline-block;background:#1d3b8e;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:16px 48px;border-radius:8px;letter-spacing:0.01em;">Pay Securely Online</a>
      </td></tr>
    </table>
    <div style="text-align:center;">
      <p style="margin:0 0 8px;color:#94a3b8;font-size:12px;">Link expires in 7 days · Processed by BAMS / iPOS Pays</p>
      <a href="${paymentUrl}" style="color:#1d3b8e;font-size:11px;text-decoration:underline;word-break:break-all;">${paymentUrl}</a>
    </div>
  </td></tr>
</table>`;
}

// ── POST — generate PDF and send as attachment ─────────────────────────────────
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const {
    to: toOverride,
    cc: ccOverride,
    subject: subjectOverride,
    templateId,
    docId,
    displayId: displayIdOverride,
    emailBody,
    emailSignature,
    documentType,
    posState,
    paymentLinkUrl,
    paymentAmount,
    paymentBaseAmount,
    paymentNote,
    extraAttachments,
    orderTotal: frontendOrderTotal,
  } = (req.body ?? {}) as any;
  const order = await fetchOrderWithPreview(req, id);
  if (!order) return void res.status(404).json({ message: "Order not found" });
  const { customer, total: backendTotal } = buildTotals(order);
  // Prefer the exact total from the POS frontend — avoids any mismatch
  // between backend recalculation and what the user sees on screen.
  const total = frontendOrderTotal != null ? Number(frontendOrderTotal) : backendTotal;
  const customerEmail = toOverride ?? customer?.email ?? order.email;
  if (!customerEmail)
    return void res.status(400).json({ message: "No customer email found" });

  if (!process.env.RESEND_API_KEY)
    return void res.status(200).json({
      success: false,
      preview_only: true,
      message: "RESEND_API_KEY not set.",
    });

  const params = buildParams(order, "email");
  const docType = documentType ?? "Estimate";
  const displayId = displayIdOverride ?? order.display_id;
  const estNum = `E${String(displayId).padStart(8, "0")}`;
  const emailSubject =
    subjectOverride ?? `${docType} ${estNum} from EcoPowerTech`;

  // Generate PDF — always prefer frontend template; only fall back to backend HTML if no template exists.
  // If the frontend didn't send templateId (e.g. templates hadn't loaded yet), look up the default.
  const resolvedTemplateId: string | null =
    templateId ?? (await fetchDefaultTemplateId(docType.toLowerCase()));

  let pdfBuffer: Buffer | null = null;
  try {
    if (resolvedTemplateId && docId) {
      // Resolve POS base URL: env var takes priority, then x-forwarded-host, then origin/referer headers
      const forwardedHost = req.headers["x-forwarded-host"] as
        | string
        | undefined;
      const forwardedProto =
        (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
      const forwardedBase = forwardedHost
        ? `${forwardedProto}://${forwardedHost}`
        : null;
      const reqOrigin =
        (req.headers["origin"] as string) || (req.headers["referer"] as string);
      const originBase = reqOrigin ? new URL(reqOrigin).origin : null;
      const POS_URL =
        process.env.POS_URL ??
        forwardedBase ??
        originBase ??
        "http://localhost:3001";
      const params = new URLSearchParams({ docId, auto: "0" });
      if (displayId) params.set("displayId", String(displayId));
      const printUrl = `${POS_URL}/print/${resolvedTemplateId}?${params}`;
      console.log(`[send-email] PDF via frontend template: ${printUrl}`);
      // Pre-fetch template from DB so the headless browser doesn't need auth to load it.
      // (authStore intentionally never persists token to localStorage, so the browser
      //  can't call the authenticated template API — we inject the data directly instead.)
      const templateData = await fetchTemplateForPdf(resolvedTemplateId);
      if (!templateData)
        console.warn(
          `[send-email] Template ${resolvedTemplateId} not found — print page may hang`
        );
      pdfBuffer = await generatePdfFromUrl(printUrl, posState, templateData);
      console.log(
        `[send-email] PDF generated successfully (${pdfBuffer.length} bytes)`
      );
    } else {
      // Fallback: use the backend-generated HTML template
      const pdfHtml = buildEstimateHtml(params);
      pdfBuffer = await generateEstimatePdf(pdfHtml);
      console.log(
        `[send-email] Backend HTML PDF generated (${pdfBuffer.length} bytes)`
      );
    }
  } catch (err) {
    console.error(
      "[send-email] PDF generation FAILED — email will be sent without attachment:",
      err
    );
  }

  const customerName = params.customerName;
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: (order.currency_code ?? "USD").toUpperCase(),
    }).format(n);

  // ── Fixed block order (no signature detection needed — frontend sends body + signature separately) ──
  const esc = (s: string) =>
    s
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\[Customer Name\]/gi, customerName);

  // Block 1: Greeting + intro text
  const bodyHtml = emailBody
    ? `<div style="white-space:pre-wrap;line-height:1.6;font-size:15px;color:#334155;margin-bottom:8px;">${esc(String(emailBody))}</div>`
    : `<p style="margin:0 0 12px;font-size:15px;color:#0f172a;">Dear ${customerName},</p>
       <p style="margin:0;color:#475569;font-size:15px;line-height:1.6;">Thank you for your business. Please find your ${docType.toLowerCase()} attached as a PDF.</p>`;

  // Block 2: Payment card (only if link was generated)
  const payCard =
    paymentLinkUrl && paymentAmount
      ? buildPaymentCard(
          paymentLinkUrl,
          fmt(Number(paymentAmount)),
          paymentBaseAmount ? fmt(Number(paymentBaseAmount)) : undefined,
          paymentBaseAmount
            ? fmt(Number(paymentAmount) - Number(paymentBaseAmount))
            : undefined,
          paymentNote
        )
      : "";

  // Block 3: Signature (from frontend field, or auto-generated fallback)
  const sigHtml = emailSignature
    ? `<div style="white-space:pre-wrap;line-height:1.65;font-size:14px;color:#475569;margin-top:8px;">${esc(String(emailSignature))}</div>`
    : `<p style="color:#64748b;font-size:14px;margin:0 0 8px;">If you have any questions, please don't hesitate to reach out.</p>
       <p style="color:#334155;font-size:14px;margin:0;white-space:pre-wrap;">Warm regards,\n<strong>EcoPowerTech Team</strong>\n2760 W 84th St, Unit 4, Hialeah, FL 33016\nPhone: (305) 851-7028 · info@ecopowertech.com</p>`;

  const emailBodyHtml = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#334155;background:#f8fafc;margin:0;padding:40px 0;}
  .wrap{max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:48px 40px;box-shadow:0 10px 15px -3px rgba(0,0,0,0.04),0 4px 6px -2px rgba(0,0,0,0.02);border:1px solid #e2e8f0;}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:36px;}
  .logo span{font-size:18px;font-weight:800;letter-spacing:1px;color:#0f172a;}
  h2{font-size:22px;font-weight:700;color:#0f172a;margin:0 0 24px;letter-spacing:-0.02em;}
  .box{background:#f1f5f9;border-left:4px solid #1d3b8e;border-radius:0 8px 8px 0;padding:24px;margin:28px 0;font-size:14px;line-height:1.8;color:#334155;}
  .box b{color:#0f172a;font-weight:600;display:inline-block;width:95px;}
  .total{font-weight:700;font-size:17px;color:#0f172a;margin-top:16px;padding-top:16px;border-top:1px solid #cbd5e1;}
  .sig{margin-top:40px;}
  .footer{margin-top:48px;font-size:12px;line-height:1.6;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:24px;text-align:center;}
</style></head>
<body>
<div style="background:#f8fafc;padding:40px 0;">
<div class="wrap">

  <!-- LOGO -->
  <div class="logo">
    <img src="https://bucket-production-2e09.up.railway.app/medusa-media/ecopowertech-logo.png" alt="" style="height:36px;vertical-align:middle;" />
    <span style="display:inline-block;vertical-align:middle;margin-left:12px;font-size:18px;font-weight:800;letter-spacing:1px;color:#0f172a;">ECOPOWERTECH</span>
  </div>

  <!-- TITLE -->
  <h2>Your ${docType} is Ready</h2>

  <!-- BODY (greeting + intro) -->
  ${bodyHtml}

  <!-- ESTIMATE INFORMATION -->
  <div class="box">
    <div><b>${docType} #:</b> ${estNum}</div>
    <div><b>Date:</b> ${params.estimateDate}</div>
    ${params.leadTime ? `<div><b>Lead Time:</b> ${params.leadTime}</div>` : ""}
    ${params.orderType ? `<div><b>Order Type:</b> ${params.orderType}</div>` : ""}
    <div class="total" style="margin-top:12px;padding-top:12px;border-top:1px solid #cbd5e1;">Total: ${fmt(total)}</div>
  </div>

  <!-- PAYMENT LINK (only when selected in modal) -->
  ${payCard}

  <!-- SIGNATURE -->
  <div class="sig">${sigHtml}</div>

  <!-- FOOTER -->
  <div class="footer">
    Ecopowertech Inc. &nbsp;·&nbsp; 2760 W 84th St, Unit 4, Hialeah, FL 33016<br>
    Phone: (305) 851-7028 &nbsp;·&nbsp; <a href="mailto:info@ecopowertech.com" style="color:#6b7280;">info@ecopowertech.com</a> &nbsp;·&nbsp; www.ecopowertech.com
  </div>

</div>
</div>
</body>
</html>`;

  const toEmails = customerEmail
    .split(",")
    .map((e: string) => e.trim())
    .filter(Boolean);
  let ccEmails: string[] = [];
  if (ccOverride) {
    const rawCc = Array.isArray(ccOverride)
      ? ccOverride.join(",")
      : String(ccOverride);
    ccEmails = rawCc
      .split(",")
      .map((e: string) => e.trim())
      .filter((e) => e && !toEmails.includes(e));
  }

  let finalHtml = emailBodyHtml;
  let attachments:
    | Array<{ filename: string; content: string; type?: string }>
    | undefined;

  if (pdfBuffer) {
    attachments = [
      {
        content: pdfBuffer.toString("base64"),
        filename: `${estNum}.pdf`,
        type: "application/pdf",
      },
    ];
  } else {
    // Fallback: attach HTML version as a note if PDF failed
    finalHtml += `<p style="color:#dc2626;font-size:11px;margin-top:12px;">Note: PDF could not be generated. Please contact us for the document.</p>`;
  }

  // Append extra attachments from the frontend (ephemeral — only in transit, never persisted)
  if (Array.isArray(extraAttachments) && extraAttachments.length > 0) {
    if (!attachments) attachments = [];
    for (const a of extraAttachments as Array<{
      filename: string;
      content: string;
      type?: string;
    }>) {
      if (a.filename && a.content) {
        attachments.push({
          filename: a.filename,
          content: a.content,
          type: a.type,
        });
      }
    }
  }

  // Always send from the verified Resend domain address.
  // Never use the agent's personal email as From — it may not be a verified Resend sender.
  // senderEmail is stored only as metadata (sent_by), not used as the From address.
  const senderAddr = process.env.RESEND_FROM ?? "estimates@ecopowertech.com";
  const fromEmail = `EcoPowerTech <${senderAddr}>`;
  console.log(
    `[send-email] Sending from: ${fromEmail} → to: ${toEmails.join(", ")} | pdf: ${!!attachments}`
  );
  try {
    await sendMail({
      to: toEmails,
      from: fromEmail,
      subject: emailSubject,
      html: finalHtml,
      ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
      ...(attachments ? { attachments } : {}),
    });
  } catch (mailErr: unknown) {
    const msg = mailErr instanceof Error ? mailErr.message : String(mailErr);
    console.error("[send-email] sendMail failed:", msg);
    return void res.status(500).json({ success: false, message: msg });
  }

  // Update estimate metadata via REST PATCH (reliable — same path the UI uses)
  try {
    const base = `http://localhost:${process.env.PORT ?? 9000}`;
    const metaHeaders = {
      Cookie: req.headers["cookie"] ?? "",
      Authorization: req.headers["authorization"] ?? "",
      "Content-Type": "application/json",
    };
    // Resolve the name of the admin user who sent the estimate
    let senderName: string | undefined;
    try {
      const meRes = await fetch(`${base}/admin/users/me`, {
        headers: metaHeaders,
      });
      if (meRes.ok) {
        const { user: me } = await meRes.json();
        senderName =
          `${me?.first_name ?? ""} ${me?.last_name ?? ""}`.trim() ||
          me?.email ||
          undefined;
      }
    } catch {
      /* best-effort */
    }

    // Read current metadata, merge, then PATCH
    const curRes = await fetch(
      `${base}/admin/orders/${id}?fields=id,+metadata`,
      { headers: metaHeaders }
    );
    const curMeta = curRes.ok
      ? ((await curRes.json()).order?.metadata ?? {})
      : {};
    const curStatus = curMeta.order_status ?? curMeta.estimate_status;
    const newStatus = curStatus === "Created" ? "Sent" : (curStatus ?? "Sent");
    await fetch(`${base}/admin/draft-orders/${id}`, {
      method: "POST",
      headers: metaHeaders,
      body: JSON.stringify({
        metadata: {
          ...curMeta,
          estimate_sent_at: new Date().toISOString(),
          estimate_sent_to: customerEmail,
          estimate_sent_by: senderName,
          ...(paymentLinkUrl
            ? {
                payment_link_count: Number(curMeta.payment_link_count || 1) + 1,
              }
            : {}),
          order_status: newStatus,
        },
      }),
    });
  } catch {
    /* non-critical */
  }

  res.status(200).json({
    success: true,
    sent_to: customerEmail,
    pdf_generated: !!pdfBuffer,
  });
}
