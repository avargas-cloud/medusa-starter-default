/**
 * _shared/pdf.ts
 * Shared PDF-generation utilities used by send-email and pdf-link routes.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";

import { Client as PgClient } from "pg";
import { chromium as playwrightChromium } from "playwright-core";

export async function dbConnect(): Promise<PgClient> {
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

export async function fetchTemplateForPdf(
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
    console.error("[pdf-shared] Failed to prefetch template:", err);
    return null;
  } finally {
    await db.end();
  }
}

export async function fetchDefaultTemplateId(
  docType: string
): Promise<string | null> {
  const db = await dbConnect();
  try {
    const result = await db.query(
      "SELECT id FROM pos_document_template WHERE doc_type = $1 AND is_default = true LIMIT 1",
      [docType]
    );
    if (result.rows[0]) return (result.rows[0] as { id: string }).id;
    const fallback = await db.query(
      "SELECT id FROM pos_document_template WHERE doc_type = $1 LIMIT 1",
      [docType]
    );
    return (fallback.rows[0] as { id: string } | undefined)?.id ?? null;
  } catch (err) {
    console.error("[pdf-shared] Failed to fetch default template:", err);
    return null;
  } finally {
    await db.end();
  }
}

export async function launchBrowser() {
  const browserlessUrl =
    process.env.BROWSERLESS_URL ??
    (process.env.RAILWAY_ENVIRONMENT
      ? "ws://browserless.railway.internal:8080"
      : null);

  if (browserlessUrl) {
    console.log(`[chrome] Connecting to Browserless: ${browserlessUrl}`);
    return playwrightChromium.connectOverCDP(browserlessUrl);
  }

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

export async function generatePdfFromUrl(
  url: string,
  posState?: string,
  templateData?: Record<string, unknown> | null,
  localStoragePayloads?: Record<string, string>
): Promise<Buffer> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 816, height: 1056 });
    const originUrl = new URL(url).origin;
    await page.goto(originUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ([state, tmpl, payloads]: [
        string | undefined,
        string | null,
        Record<string, string> | undefined,
      ]) => {
        if (state) localStorage.setItem("pos-documents", state);
        if (tmpl) localStorage.setItem("pdf-template-injection", tmpl);
        if (payloads) {
          for (const [key, value] of Object.entries(payloads)) {
            localStorage.setItem(key, value);
          }
        }
      },
      [
        posState,
        templateData ? JSON.stringify(templateData) : null,
        localStoragePayloads,
      ] as [
        string | undefined,
        string | null,
        Record<string, string> | undefined,
      ]
    );
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
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
