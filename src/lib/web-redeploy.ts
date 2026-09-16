/**
 * "Publish web changes": dispara el Deploy Hook de Vercel del proyecto `web`
 * desde el admin de Medusa.
 *
 * Por qué existe: TODAS las fichas de producto de la web se prerenderizan en el
 * build, así que un atributo cambiado en Medusa no se ve hasta el próximo deploy.
 * El operador decidió (09/16/2026) NO ir a ISR on-demand — los atributos cambian
 * poco — sino un botón que rebuildea cuando él quiere.
 *
 * Reglas:
 * - La URL del hook es un SECRETO (quien la tenga dispara deploys): vive en
 *   `VERCEL_WEB_DEPLOY_HOOK_URL` (Railway) y jamás se devuelve al cliente.
 * - Sin la variable la ruta contesta 503 con código: nunca falla mudo.
 * - Anti doble-clic ATÓMICO en Postgres: el "claim" es un UPDATE condicional
 *   sobre `store.metadata.web_redeploy_last` (sobrevive reinicios e instancias,
 *   a diferencia de un flag en memoria). Dentro de la ventana devuelve el
 *   disparo vigente en vez de encolar otro build.
 * - `store.metadata` se escribe con `||` (merge top-level): sólo se reemplaza
 *   la clave `web_redeploy_last`, nunca el resto (regla RMW de metadata).
 */

export const DEDUPE_WINDOW_SECONDS = 120;
export const HOOK_TIMEOUT_MS = 10_000;
export const METADATA_KEY = "web_redeploy_last";

export interface RedeployRecord {
  at: string;
  by: string;
  /** `triggering` mientras se llama al hook; después `ok` o `failed`. */
  status: "triggering" | "ok" | "failed";
  job_id?: string | null;
  job_state?: string | null;
  error?: string | null;
}

export interface KnexLike {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface StoreRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

export function hookUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.VERCEL_WEB_DEPLOY_HOOK_URL?.trim();
  return v && /^https:\/\//.test(v) ? v : null;
}

export async function loadStore(knex: KnexLike): Promise<StoreRow | null> {
  const { rows } = await knex.raw(`SELECT id, metadata FROM store ORDER BY id LIMIT 1`);
  return (rows[0] as StoreRow | undefined) ?? null;
}

export function lastRecord(store: StoreRow | null): RedeployRecord | null {
  const raw = store?.metadata?.[METADATA_KEY];
  return raw && typeof raw === "object" ? (raw as RedeployRecord) : null;
}

export function withinDedupeWindow(last: RedeployRecord | null, now = Date.now()): boolean {
  if (!last) return false;
  const at = Date.parse(last.at);
  return Number.isFinite(at) && now - at < DEDUPE_WINDOW_SECONDS * 1000;
}

/**
 * Reclama el disparo: UPDATE condicional que sólo pasa si no hay un registro
 * más nuevo que la ventana. Devuelve false si otro request ganó.
 */
export async function claimTrigger(knex: KnexLike, storeId: string, by: string): Promise<RedeployRecord | null> {
  const record: RedeployRecord = { at: new Date().toISOString(), by, status: "triggering" };
  const { rows } = await knex.raw(
    `UPDATE store
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
            updated_at = NOW()
      WHERE id = ?
        AND (
          (metadata->'${METADATA_KEY}'->>'at') IS NULL
          OR (metadata->'${METADATA_KEY}'->>'at')::timestamptz < NOW() - (? || ' seconds')::interval
        )
      RETURNING id`,
    [JSON.stringify({ [METADATA_KEY]: record }), storeId, String(DEDUPE_WINDOW_SECONDS)]
  );
  return rows.length > 0 ? record : null;
}

export async function saveRecord(knex: KnexLike, storeId: string, record: RedeployRecord): Promise<void> {
  await knex.raw(
    `UPDATE store SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify({ [METADATA_KEY]: record }), storeId]
  );
}

interface HookJob {
  id?: string;
  state?: string;
}

/** Llama al Deploy Hook. Vercel contesta `{ job: { id, state, createdAt } }`. */
export async function callDeployHook(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; job: HookJob } | { ok: false; error: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HOOK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "POST", signal: ctl.signal });
    const body = (await res.json().catch(() => ({}))) as { job?: HookJob; error?: { message?: string } };
    if (!res.ok) {
      return { ok: false, error: body?.error?.message || `Vercel respondió ${res.status}` };
    }
    return { ok: true, job: body.job ?? {} };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? `sin respuesta en ${HOOK_TIMEOUT_MS / 1000} s` : e.message) : String(e);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
