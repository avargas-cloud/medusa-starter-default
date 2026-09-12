/**
 * target-guard — UN solo guard para los write paths de los scripts QB→POS
 * (`import-qb-general-ledger`, `backfill-qb-purchases`, `relink-qb-backfill-bills`,
 * `backfill-qb-sales-apply`, `fulfill-backfilled-qb-orders`, `reprice-backfilled-qb-orders`).
 *
 * Dos destinos, ninguno implícito:
 *
 *   sandbox    = `ECOPOWERTECH_ENV=sandbox` Y `DATABASE_URL` apunta a
 *                `localhost:5499` / `127.0.0.1:5499` (el Postgres del sandbox Docker).
 *                Es el default — sin flag — igual que hasta hoy.
 *   production = TODAS: flag `--target-production` (o env `TARGET_PRODUCTION=1`
 *                para los scripts que corren bajo `medusa exec`) Y
 *                `ECOPOWERTECH_ENV=production` Y `DATABASE_URL` que NO apunte a
 *                `:5499` ni contenga `sandbox` Y `CONFIRM_PRODUCTION_RUN` igual al
 *                run id que recibió el script (el operador tipea el run id exacto
 *                que aprobó).
 *
 * Cualquier otra combinación tira `WriteTargetError` con la lista de condiciones
 * que fallaron. Nunca imprime la DATABASE_URL: sólo host:puerto/db, sin credenciales.
 *
 * Precondición de producción, aparte del resolver: el script tiene que encontrar
 * el reporte del DRY-RUN previo para el mismo run id e imprimir su cardinalidad
 * antes de escribir (`assertDryRunEvidence`). Sin reporte → se niega.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type WriteTarget = "sandbox" | "production";

export type ResolveWriteTargetInput = {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  databaseUrl: string | undefined;
  /** run id que recibió el script; en producción debe coincidir con CONFIRM_PRODUCTION_RUN */
  runId: string | undefined;
};

export type WriteTargetResolution = {
  target: WriteTarget;
  reason: string;
  /** host:puerto/db — sin usuario ni password */
  dbTarget: string;
};

export class WriteTargetError extends Error {
  readonly failures: string[];
  constructor(requested: WriteTarget, failures: string[]) {
    super(
      `destino de escritura '${requested}' rechazado — condiciones que fallan:\n` +
        failures.map((f) => `  ✗ ${f}`).join("\n")
    );
    this.name = "WriteTargetError";
    this.failures = failures;
  }
}

const SANDBOX_HOSTS = new Set(["localhost", "127.0.0.1"]);
const SANDBOX_PORT = "5499";

/** `host:puerto/db` de una URL de conexión, sin credenciales. Ilegible → marcador. */
export function describeDbTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl) return "<sin DATABASE_URL>";
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<url ilegible>";
  }
}

function parseHostPort(databaseUrl: string | undefined): { host: string; port: string } | null {
  if (!databaseUrl) return null;
  try {
    const u = new URL(databaseUrl);
    return { host: u.hostname, port: u.port || "5432" };
  } catch {
    return null;
  }
}

export function isSandboxDatabaseUrl(databaseUrl: string | undefined): boolean {
  const hp = parseHostPort(databaseUrl);
  return !!hp && SANDBOX_HOSTS.has(hp.host) && hp.port === SANDBOX_PORT;
}

/** ¿El flag/env de producción está presente? (`--target-production` o `TARGET_PRODUCTION=1`) */
export function productionRequested(argv: readonly string[], env: ResolveWriteTargetInput["env"]): boolean {
  return argv.includes("--target-production") || env.TARGET_PRODUCTION === "1";
}

/**
 * Resolver puro: decide sandbox | production o tira. No lee process.*: el script
 * le pasa argv/env/DATABASE_URL/run id.
 */
export function resolveWriteTarget(input: ResolveWriteTargetInput): WriteTargetResolution {
  const { argv, env, databaseUrl, runId } = input;
  const dbTarget = describeDbTarget(databaseUrl);
  const ecoEnv = env.ECOPOWERTECH_ENV;

  if (!productionRequested(argv, env)) {
    const failures: string[] = [];
    if (ecoEnv !== "sandbox") failures.push(`ECOPOWERTECH_ENV debe ser 'sandbox' (es '${ecoEnv ?? ""}')`);
    if (!databaseUrl) failures.push("DATABASE_URL es obligatoria");
    else if (!isSandboxDatabaseUrl(databaseUrl))
      failures.push(`DATABASE_URL debe apuntar a localhost:${SANDBOX_PORT} / 127.0.0.1:${SANDBOX_PORT} (apunta a ${dbTarget})`);
    if (failures.length) {
      failures.push("para escribir en producción: --target-production (o TARGET_PRODUCTION=1) + ECOPOWERTECH_ENV=production + CONFIRM_PRODUCTION_RUN=<run id>");
      throw new WriteTargetError("sandbox", failures);
    }
    return { target: "sandbox", reason: `ECOPOWERTECH_ENV=sandbox y DATABASE_URL en ${dbTarget}`, dbTarget };
  }

  const failures: string[] = [];
  if (ecoEnv !== "production") failures.push(`ECOPOWERTECH_ENV debe ser 'production' (es '${ecoEnv ?? ""}')`);
  if (!databaseUrl) failures.push("DATABASE_URL es obligatoria");
  else {
    const hp = parseHostPort(databaseUrl);
    if (!hp) failures.push("DATABASE_URL ilegible");
    else if (hp.port === SANDBOX_PORT) failures.push(`DATABASE_URL apunta al puerto del sandbox (${dbTarget})`);
    if (/sandbox/i.test(databaseUrl)) failures.push(`DATABASE_URL contiene 'sandbox' (${dbTarget})`);
  }
  const confirm = env.CONFIRM_PRODUCTION_RUN;
  if (!runId) failures.push("run id vacío: producción exige un run id explícito");
  if (!confirm) failures.push("CONFIRM_PRODUCTION_RUN ausente: debe ser exactamente el run id");
  else if (runId && confirm !== runId) failures.push(`CONFIRM_PRODUCTION_RUN ('${confirm}') no coincide con el run id ('${runId}')`);
  if (failures.length) throw new WriteTargetError("production", failures);
  return {
    target: "production",
    reason: `--target-production + ECOPOWERTECH_ENV=production + CONFIRM_PRODUCTION_RUN=${runId} · DATABASE_URL en ${dbTarget}`,
    dbTarget,
  };
}

// ── Evidencia del dry-run previo ──────────────────────────────────────────────

export type DryRunEvidence = {
  path: string;
  cardinality: Record<string, number | string | null | undefined>;
};

/** El archivo MÁS RECIENTE (mtime) de `dir` cuyo nombre matchea `pattern`, o null. */
export function latestFile(dir: string, pattern: RegExp): string | null {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

export function readJsonFile<T = Record<string, unknown>>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * En producción, exige el reporte del dry-run del mismo run id e imprime su
 * cardinalidad. En sandbox no exige nada (igual que hoy). Tira si falta.
 */
export function assertDryRunEvidence(
  target: WriteTarget,
  runId: string,
  evidence: DryRunEvidence | null,
  log: (line: string) => void
): void {
  if (target !== "production") return;
  if (!evidence) {
    throw new WriteTargetError("production", [
      `no hay reporte de DRY-RUN para el run '${runId}' — corré el dry-run primero (mismo run id, sin --apply / sin APPLY=true)`,
    ]);
  }
  log(`dry-run previo (${runId}): ${evidence.path}`);
  for (const [k, v] of Object.entries(evidence.cardinality)) log(`  ${k}: ${v ?? "—"}`);
}

/** Formato uniforme para los scripts CLI: mensaje + hint, sin stack ni URL. */
export function formatWriteTargetError(err: unknown): string {
  if (err instanceof WriteTargetError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
