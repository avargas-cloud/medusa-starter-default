/**
 * verify-project-order-lock.ts — el candado proyecto ↔ orden, afirmado por
 * NOMBRE en las TRES bases de código que lo componen (Medusa escribe; BL y LL
 * leen y rechazan). Un gate que sólo mirara este repo aprobaría un candado que
 * ninguna app respeta.
 *
 *   (a) migración: tabla, PK (app, project_id), CHECKs de app y reason, unlocked_at
 *   (b) subscriber: los MISMOS eventos que auto-complete-order (superset) + kill switch
 *   (c) job: cada 5 min, kill switch, guard de scheduled jobs
 *   (d) predicado: MAX (nunca suma) de proyección y capturado; draft nunca lockea
 *   (e) reconciler: vínculos por metadata Y por estimate_id del proyecto
 *   (f) BL y LL: leen `unlocked_at IS NULL` y llaman rejectIfLocked en PUT, repin y DELETE
 *       (sin contar líneas de import); clone y report-access registrados
 *   (g) con DATABASE_URL LOCAL: la tabla existe con sus columnas (lectura)
 *
 * READ-ONLY. exit 1 ante cualquier FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-project-order-lock.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKSPACE = join(ROOT, "..");

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const record = (label: string, pass: boolean, detail: string) =>
  checks.push({ label, pass, detail });

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const readWs = (rel: string): string => readFileSync(join(WORKSPACE, rel), "utf8");

/** Sin comentarios y sin imports: importar un guard no es usarlo. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "");
}

// ── (a) migración ──────────────────────────────────────────────────────────
{
  const rel = "src/migrations/1789100000000-CreateProjectOrderLock.ts";
  const src = read(rel);
  record("migración: CREATE TABLE project_order_lock", /CREATE TABLE IF NOT EXISTS project_order_lock/.test(src), rel);
  record("migración: PK (app, project_id)", /PRIMARY KEY \(app, project_id\)/.test(src), rel);
  record("migración: CHECK app ∈ {backlighting, linear-lighting}", /CHECK \(app IN \('backlighting', 'linear-lighting'\)\)/.test(src), rel);
  record("migración: CHECK reason ∈ {paid, fulfilled}", /CHECK \(reason IN \('paid', 'fulfilled'\)\)/.test(src), rel);
  record("migración: unlocked_at nullable (desbloqueo con rastro)", /unlocked_at TIMESTAMPTZ NULL/.test(src), rel);
}

// ── (b) subscriber ─────────────────────────────────────────────────────────
{
  const rel = "src/subscribers/project-order-lock.ts";
  const src = code(read(rel));
  const base = code(read("src/subscribers/auto-complete-order.ts"));
  const events = (s: string) =>
    [...s.matchAll(/"([a-z-]+\.[a-z_.]+)"/g)].map((m) => m[1]).filter((e) => e.includes("."));
  const mine = new Set(events(src));
  const missing = events(base).filter((e) => !mine.has(e));
  record(
    "subscriber: escucha TODOS los eventos de auto-complete-order",
    missing.length === 0,
    missing.length === 0 ? `${mine.size} eventos` : `faltan: ${missing.join(", ")}`
  );
  record("subscriber: kill switch isProjectLockDisabled", /isProjectLockDisabled\(\)/.test(src), rel);
  record("subscriber: nunca lanza (try/catch alrededor de evaluate)", /try \{[\s\S]*evaluateProjectLocksForOrder[\s\S]*\} catch/.test(src), rel);
}

// ── (c) job ────────────────────────────────────────────────────────────────
{
  const rel = "src/jobs/project-order-lock-reconciler.ts";
  const src = code(read(rel));
  record("job: schedule */5", /schedule: "\*\/5 \* \* \* \*"/.test(src), rel);
  record("job: isScheduledJobsDisabled primero", /isScheduledJobsDisabled\(container\)/.test(src), rel);
  record("job: kill switch isProjectLockDisabled", /isProjectLockDisabled\(\)/.test(src), rel);
}

// ── (d) predicado ──────────────────────────────────────────────────────────
{
  const rel = "src/lib/project-lock/predicate.ts";
  const src = code(read(rel));
  record("predicado: recibido = Math.max(proyección, capturado)", /Math\.max\(facts\.projectionReceivedCents, facts\.capturedCents\)/.test(src), rel);
  record("predicado: no suma las dos lecturas", !/projectionReceivedCents \+ facts\.capturedCents/.test(src), rel);
  record("predicado: draft order nunca lockea", /facts\.isDraftOrder\) return null/.test(src), rel);
  record("predicado: fulfilled antes que paid", src.indexOf('"fulfilled"') < src.indexOf('"paid"'), rel);
}

// ── (e) reconciler: dos lados del vínculo ──────────────────────────────────
{
  const rel = "src/lib/project-lock/repo.ts";
  const src = code(read(rel));
  record("repo: vínculos por order.metadata (backlighting_project_id / ll_project_id)", /backlighting_project_id/.test(src) && /ll_project_id/.test(src), rel);
  record("repo: vínculos por estimate_id del proyecto (bl_projects / lld_project)", /estimate_id = \$1/.test(src) && /JOIN "order" o ON o\.id = p\.estimate_id/.test(src), rel);
  record("repo: insert ON CONFLICT DO NOTHING (un candado no se reescribe)", /ON CONFLICT \(app, project_id\) DO NOTHING/.test(src), rel);
}

// ── (f) las apps respetan el candado ───────────────────────────────────────
const APPS = [
  {
    name: "BL",
    lock: "backlighting/backend/src/lib/project-lock.ts",
    guard: "rejectIfLocked",
    writers: [
      "backlighting/backend/src/routes/projects/write.handlers.ts",
      "backlighting/backend/src/routes/projects/catalog-pin.handlers.ts",
      "backlighting/backend/src/routes/projects/detail.handlers.ts",
    ],
    router: "backlighting/backend/src/routes/projects/index.ts",
    routes: ["/:id/clone", "/:id/report-access"],
  },
  {
    name: "LL",
    lock: "linear-lighting/backend/src/lib/project-lock.ts",
    guard: "rejectIfLocked",
    writers: ["linear-lighting/backend/src/routes/projects.ts"],
    router: "linear-lighting/backend/src/routes/projects.ts",
    routes: ["/:id/clone", "/:id/report-access"],
  },
];
for (const app of APPS) {
  if (!existsSync(join(WORKSPACE, app.lock))) {
    record(`${app.name}: lib/project-lock.ts existe`, false, app.lock);
    continue;
  }
  const lock = code(readWs(app.lock));
  record(`${app.name}: lee project_order_lock con unlocked_at IS NULL`, /FROM project_order_lock/.test(lock) && /unlocked_at IS NULL/.test(lock), app.lock);
  record(`${app.name}: falla abierta sólo ante 42P01 (tabla ausente)`, /42P01/.test(lock), app.lock);
  const guardCalls = app.writers.reduce((n, rel) => {
    const src = code(readWs(rel));
    return n + (src.match(new RegExp(`await ${app.guard}\\(`, "g")) ?? []).length;
  }, 0);
  record(`${app.name}: ≥3 escrituras llaman ${app.guard} (PUT, repin, DELETE)`, guardCalls >= 3, `${guardCalls} llamadas (sin imports)`);
  const router = code(readWs(app.router));
  for (const route of app.routes) {
    record(`${app.name}: ruta ${route} registrada`, router.includes(`'${route}'`), app.router);
  }
}

// ── (g) DB local: la tabla existe ──────────────────────────────────────────
async function checkDb(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* sin URL */
  }
  if (host !== "localhost" && host !== "127.0.0.1") {
    record("db: (omitido — DATABASE_URL no es local)", true, host || "sin DATABASE_URL");
    return;
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'project_order_lock'`
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    const expected = ["app", "project_id", "order_id", "reason", "locked_at", "unlocked_at", "created_by", "facts"];
    const missing = expected.filter((c) => !names.has(c));
    record("db: project_order_lock con sus 8 columnas", cols.rows.length > 0 && missing.length === 0, missing.length ? `faltan ${missing.join(",")}` : `${host}`);
    const locks = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM project_order_lock WHERE unlocked_at IS NULL`);
    record("db: candados vigentes (informativo)", true, `${locks.rows[0]?.n ?? 0} locks activos`);
  } finally {
    await client.end();
  }
}

checkDb()
  .catch((e) => record("db: consulta", false, (e as Error).message))
  .finally(() => {
    let failed = 0;
    for (const c of checks) {
      if (!c.pass) failed += 1;
      console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
    }
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed > 0 ? 1 : 0);
  });
