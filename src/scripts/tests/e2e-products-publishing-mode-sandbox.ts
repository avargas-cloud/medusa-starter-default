/**
 * E2E — Medusa admin `/app/products-advanced` · Publishing mode.
 *
 * Qué prueba (contra el sandbox, NUNCA prod):
 *   1. El filtro "Draft" existe y sólo trae drafts.
 *   2. "Publishing mode" convierte la columna Status en un switch por fila.
 *   3. Un click publica: la fila muestra `published` y la DB dice `published`.
 *   4. Otro click vuelve a draft: fila y DB en `draft`.
 *   5. NEGATIVO: un producto vecino que NO se tocó sigue `draft` en la DB.
 *   6. Salir del modo devuelve el badge y saca los switches.
 *
 * Correr:  ./node_modules/.bin/tsx src/scripts/tests/e2e-products-publishing-mode-sandbox.ts
 * Requiere ./back-sb arriba (9099) y el Docker sandbox (pg 5499, meili 7799).
 */
import { existsSync, readdirSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { Client } from "pg";

const ADMIN = process.env.MEDUSA_SANDBOX_URL ?? "http://localhost:9099";
const PG_URL =
  process.env.SANDBOX_PG ?? "postgresql://postgres:sandbox@localhost:5499/medusa";
const MEILI = process.env.SANDBOX_MEILI ?? "http://localhost:7799";
const MEILI_KEY = process.env.SANDBOX_MEILI_KEY ?? "sandbox_master_key";
const EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "sandbox@test.com";
const PASS = process.env.SANDBOX_ADMIN_PASSWORD ?? "sandbox123";
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

function assertSandbox() {
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(PG_URL)) {
    throw new Error(`PG target no es el sandbox: ${PG_URL.replace(/:[^:@]+@/, ":***@")}`);
  }
  if (!/:9099/.test(ADMIN)) throw new Error(`ADMIN target no es el sandbox: ${ADMIN}`);
}

function resolveChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  if (!existsSync(cache)) return undefined;
  const rel: Array<[string, string]> = [
    ["chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell"],
    ["chromium-", "chrome-linux64/chrome"],
    ["chromium-", "chrome-linux/chrome"],
  ];
  const dirs = readdirSync(cache);
  for (const [prefix, tail] of rel) {
    for (const d of dirs.filter((x) => x.startsWith(prefix)).sort().reverse()) {
      const p = `${cache}/${d}/${tail}`;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

type Candidate = { id: string; handle: string; title: string };

/** Drafts that exist BOTH in the sandbox index and in the sandbox DB. */
async function pickDrafts(db: Client, n: number): Promise<Candidate[]> {
  const res = await fetch(`${MEILI}/indexes/products/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MEILI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: "", filter: 'status = "draft"', limit: 40, sort: ["title:asc"] }),
  });
  if (!res.ok) throw new Error(`Meili sandbox ${res.status}`);
  const { hits } = (await res.json()) as { hits: Candidate[] };
  const out: Candidate[] = [];
  for (const h of hits) {
    const r = await db.query(
      `SELECT status FROM product WHERE id = $1 AND deleted_at IS NULL`,
      [h.id]
    );
    if (r.rows[0]?.status === "draft" && h.handle && h.handle.length > 12) out.push(h);
    if (out.length === n) break;
  }
  if (out.length < n) throw new Error(`no hay ${n} drafts en sandbox DB+Meili`);
  return out;
}

const dbStatus = async (db: Client, id: string) =>
  (await db.query(`SELECT status FROM product WHERE id = $1`, [id])).rows[0]?.status as string;

async function login(page: Page) {
  await page.goto(`${ADMIN}/app/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20_000 });
}

async function setStatusFilter(page: Page, label: string) {
  // The status select shows "Published" by default; it's the only trigger with that text.
  await page.getByRole("combobox").filter({ hasText: /^(Published|Draft|All Statuses)$/ }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

async function main() {
  assertSandbox();
  const db = new Client({ connectionString: PG_URL });
  await db.connect();
  const [target, control] = await pickDrafts(db, 2);
  console.log(`target=${target.handle} control=${control.handle}`);

  const exe = resolveChromium();
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  try {
    await login(page);
    await page.goto(`${ADMIN}/app/products-advanced`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("publishing-mode-toggle").waitFor({ timeout: 20_000 });

    // 1. Draft filter exists and yields only drafts
    await setStatusFilter(page, "Draft");
    await page.waitForTimeout(1500);
    const badges = await page.locator("table tbody tr td:last-child").allInnerTexts();
    check(
      "filtro Draft: todas las filas visibles son draft",
      badges.length > 0 && badges.every((t) => /draft/i.test(t)),
      `${badges.length} filas`
    );

    // 2. Enter publishing mode → switches appear
    await page.getByTestId("publishing-mode-toggle").click();
    await page.fill('input[type="search"]', target.handle);
    const toggle = page.getByTestId(`status-toggle-${target.id}`);
    await toggle.waitFor({ timeout: 15_000 });
    check("publishing mode: la fila tiene switch", await toggle.count() === 1);
    check("switch arranca en draft", (await toggle.getAttribute("data-status")) === "draft");
    await page.screenshot({ path: `${SHOT_DIR}/publishing-mode-before.png` });

    // 3. Click → published (UI + DB)
    await toggle.locator("button[role='switch']").click();
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="status-toggle-${id}"]`)?.getAttribute("data-status") === "published",
      target.id,
      { timeout: 15_000 }
    );
    await page.waitForTimeout(500);
    check("publish: DB dice published", (await dbStatus(db, target.id)) === "published");
    await page.screenshot({ path: `${SHOT_DIR}/publishing-mode-after.png` });

    // 5. Negative: neighbour untouched
    check("negativo: el control sigue draft en DB", (await dbStatus(db, control.id)) === "draft");

    // 4. Click again → draft
    await toggle.locator("button[role='switch']").click();
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="status-toggle-${id}"]`)?.getAttribute("data-status") === "draft",
      target.id,
      { timeout: 15_000 }
    );
    await page.waitForTimeout(500);
    check("unpublish: DB vuelve a draft", (await dbStatus(db, target.id)) === "draft");

    // 6. Exit mode → badge back
    await page.getByTestId("publishing-mode-toggle").click();
    await page.waitForTimeout(300);
    check("salir del modo: sin switches", (await page.locator("button[role='switch']").count()) === 0);
  } finally {
    // Leave the sandbox as found.
    await db.query(`UPDATE product SET status = 'draft' WHERE id = $1`, [target.id]);
    await browser.close();
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} OK`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("💥", e);
  process.exit(2);
});
