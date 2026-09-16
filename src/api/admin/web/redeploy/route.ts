import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  callDeployHook,
  claimTrigger,
  hookUrl,
  lastRecord,
  loadStore,
  saveRecord,
  withinDedupeWindow,
  DEDUPE_WINDOW_SECONDS,
  type KnexLike,
} from "../../../../lib/web-redeploy";

/**
 * GET  /admin/web/redeploy → { configured, dedupe_seconds, last }
 * POST /admin/web/redeploy → 202 { triggered: true, last } | 200 { deduped: true, last }
 *                            503 HOOK_NOT_CONFIGURED · 502 HOOK_FAILED
 *
 * Auth: la que Medusa aplica a todo /admin/*. Un cajero también puede
 * disparar un rebuild — es inocuo (no cambia datos) y el registro dice quién.
 */

const actorOf = (req: MedusaRequest): string =>
  (req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id ?? "unknown";

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as KnexLike;
  try {
    const store = await loadStore(knex);
    return res.json({
      configured: hookUrl() !== null,
      dedupe_seconds: DEDUPE_WINDOW_SECONDS,
      last: lastRecord(store),
    });
  } catch {
    return res.status(500).json({ error: "No se pudo leer el estado del último deploy", code: "READ_FAILED" });
  }
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as KnexLike;
  const url = hookUrl();
  if (!url) {
    return res.status(503).json({
      error: "El Deploy Hook de Vercel no está configurado (VERCEL_WEB_DEPLOY_HOOK_URL). Creá el hook en Vercel → proyecto web → Settings → Git → Deploy Hooks y ponelo en las variables de Railway.",
      code: "HOOK_NOT_CONFIGURED",
    });
  }

  const store = await loadStore(knex);
  if (!store) {
    return res.status(500).json({ error: "No hay store", code: "NO_STORE" });
  }
  const last = lastRecord(store);
  if (withinDedupeWindow(last)) {
    return res.status(200).json({ deduped: true, last });
  }

  const claimed = await claimTrigger(knex, store.id, actorOf(req));
  if (!claimed) {
    // Otro request ganó la ventana entre la lectura y el UPDATE.
    return res.status(200).json({ deduped: true, last: lastRecord(await loadStore(knex)) });
  }

  const result = await callDeployHook(url);
  const record = result.ok
    ? { ...claimed, status: "ok" as const, job_id: result.job.id ?? null, job_state: result.job.state ?? null, error: null }
    : { ...claimed, status: "failed" as const, job_id: null, job_state: null, error: result.error };
  await saveRecord(knex, store.id, record);

  if (!result.ok) {
    return res.status(502).json({ error: `No se pudo disparar el deploy: ${result.error}`, code: "HOOK_FAILED", last: record });
  }
  return res.status(202).json({ triggered: true, last: record });
};
