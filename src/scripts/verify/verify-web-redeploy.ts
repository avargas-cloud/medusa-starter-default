/**
 * verify-web-redeploy — el botón "Publish web changes" (POST /admin/web/redeploy).
 *
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-web-redeploy.ts
 *
 * Sandbox ÚNICAMENTE (exige :5499). Todo corre dentro de una transacción que se
 * revierte: la fila `store` queda como estaba. No llama a Vercel: `fetch` se
 * reemplaza por un doble en cada caso.
 *
 * Qué afirma:
 *  1. Sin VERCEL_WEB_DEPLOY_HOOK_URL la ruta contesta 503 HOOK_NOT_CONFIGURED (y no escribe).
 *  2. El claim es atómico: dos claims seguidos → el segundo pierde (dedupe en DB).
 *  3. RMW: escribir `web_redeploy_last` NO pisa otras claves de store.metadata.
 *  4. Hook OK → 202 + registro `ok` con job_id; hook 500 → 502 + registro `failed`.
 *  5. Dentro de la ventana, POST → 200 deduped con el registro vigente.
 *  6. Estado real del build: sin VERCEL_TOKEN → null; con token, READY/BUILDING se
 *     mapean (state, sha, via hook/git) y un 401 de Vercel devuelve null, nunca tira.
 */
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  callDeployHook,
  claimTrigger,
  hookUrl,
  lastRecord,
  loadStore,
  withinDedupeWindow,
  vercelConfig,
  latestProductionDeployment,
  type KnexLike,
} from "../../lib/web-redeploy";
import { GET, POST } from "../../api/admin/web/redeploy/route";

const DB = process.env.DATABASE_URL ?? "";
if (!/:5499\//.test(DB)) {
  console.error("Sólo sandbox: DATABASE_URL debe apuntar a :5499");
  process.exit(2);
}

/** knex.raw usa `?`; pg usa `$n`. Adaptador mínimo sobre UN client (misma transacción). */
function knexOver(client: Client): KnexLike {
  return {
    raw: async (sql, bindings = []) => {
      let i = 0;
      const text = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(text, bindings as unknown[]);
      return { rows: r.rows };
    },
  };
}

interface Res {
  code: number;
  body: unknown;
}
function fakeRes(): { res: unknown; out: Res } {
  const out: Res = { code: 200, body: null };
  const res = {
    status(c: number) {
      out.code = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  return { res, out };
}
function fakeReq(knex: KnexLike, actor = "user_verify") {
  return { scope: { resolve: () => knex }, auth_context: { actor_id: actor } } as unknown;
}

type Handler = (req: never, res: never) => Promise<unknown>;

async function main(): Promise<void> {
  const client = new Client({ connectionString: DB });
  await client.connect();
  await client.query("BEGIN");
  const knex = knexOver(client);
  const results: string[] = [];
  const ok = (name: string) => results.push(`✓ ${name}`);

  try {
    // Estado previo + una clave ajena que debe sobrevivir al RMW.
    const store0 = await loadStore(knex);
    assert.ok(store0, "hay store");
    await knex.raw(`UPDATE store SET metadata = COALESCE(metadata,'{}'::jsonb) || ?::jsonb WHERE id = ?`, [
      JSON.stringify({ verify_web_redeploy_sentinel: "keep-me", web_redeploy_last: null }),
      store0.id,
    ]);

    // 0. hookUrl
    assert.equal(hookUrl({} as NodeJS.ProcessEnv), null);
    assert.equal(hookUrl({ VERCEL_WEB_DEPLOY_HOOK_URL: "http://insecure" } as NodeJS.ProcessEnv), null);
    assert.equal(hookUrl({ VERCEL_WEB_DEPLOY_HOOK_URL: " https://api.vercel.com/v1/integrations/deploy/p/x " } as NodeJS.ProcessEnv), "https://api.vercel.com/v1/integrations/deploy/p/x");
    ok("hookUrl: sólo https, trim, ausente → null");

    // 1. Sin env → 503 y nada escrito.
    delete process.env.VERCEL_WEB_DEPLOY_HOOK_URL;
    {
      const { res, out } = fakeRes();
      await (POST as unknown as Handler)(fakeReq(knex) as never, res as never);
      assert.equal(out.code, 503);
      assert.equal((out.body as { code: string }).code, "HOOK_NOT_CONFIGURED");
      assert.equal(lastRecord(await loadStore(knex)), null, "503 no escribe registro");
      const g = fakeRes();
      await (GET as unknown as Handler)(fakeReq(knex) as never, g.res as never);
      assert.equal((g.out.body as { configured: boolean }).configured, false);
    }
    ok("sin VERCEL_WEB_DEPLOY_HOOK_URL → 503 HOOK_NOT_CONFIGURED, GET.configured=false, sin escritura");

    // 2. Claim atómico.
    const first = await claimTrigger(knex, store0.id, "a");
    assert.ok(first, "primer claim gana");
    const second = await claimTrigger(knex, store0.id, "b");
    assert.equal(second, null, "segundo claim dentro de la ventana pierde");
    assert.equal(withinDedupeWindow(lastRecord(await loadStore(knex))), true);
    ok("claim atómico: el segundo dentro de la ventana pierde");

    // 3. RMW: la clave ajena sigue.
    const s3 = await loadStore(knex);
    assert.equal(s3?.metadata?.verify_web_redeploy_sentinel, "keep-me", "RMW no pisa otras claves");
    ok("RMW: store.metadata conserva las claves ajenas");

    // Limpio la ventana para probar la ruta entera.
    await knex.raw(`UPDATE store SET metadata = metadata - 'web_redeploy_last' WHERE id = ?`, [store0.id]);

    // 4a. Hook OK → 202 + registro ok.
    process.env.VERCEL_WEB_DEPLOY_HOOK_URL = "https://api.vercel.com/v1/integrations/deploy/prj_x/hook_y";
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(String(url), process.env.VERCEL_WEB_DEPLOY_HOOK_URL);
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ job: { id: "job_123", state: "PENDING" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const { res, out } = fakeRes();
      await (POST as unknown as Handler)(fakeReq(knex, "user_ok") as never, res as never);
      assert.equal(out.code, 202);
      const rec = lastRecord(await loadStore(knex));
      assert.equal(rec?.status, "ok");
      assert.equal(rec?.job_id, "job_123");
      assert.equal(rec?.by, "user_ok");
      assert.equal(calls, 1);
      ok("hook OK → 202, registro ok con job_id y actor");

      // 5. Dentro de la ventana → 200 deduped, sin llamar al hook.
      const d = fakeRes();
      await (POST as unknown as Handler)(fakeReq(knex, "user_dup") as never, d.res as never);
      assert.equal(d.out.code, 200);
      assert.equal((d.out.body as { deduped: boolean }).deduped, true);
      assert.equal(calls, 1, "deduped no llama al hook");
      ok("dentro de la ventana → 200 deduped y el hook no se llama");

      // 4b. Hook 500 → 502 + registro failed.
      await knex.raw(`UPDATE store SET metadata = metadata - 'web_redeploy_last' WHERE id = ?`, [store0.id]);
      globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })) as typeof fetch;
      const f = fakeRes();
      await (POST as unknown as Handler)(fakeReq(knex, "user_fail") as never, f.res as never);
      assert.equal(f.out.code, 502);
      const rec2 = lastRecord(await loadStore(knex));
      assert.equal(rec2?.status, "failed");
      assert.match(rec2?.error ?? "", /boom/);
      ok("hook 500 → 502 HOOK_FAILED, registro failed con el motivo");

      // 4c. Abort (timeout) → {ok:false} con mensaje legible, nunca throw.
      const aborted = await callDeployHook("https://x", (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch);
      assert.equal(aborted.ok, false);
      assert.match((aborted as { error: string }).error, /sin respuesta/);
      ok("callDeployHook: abort → {ok:false, error:'sin respuesta…'} en vez de tirar");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.VERCEL_WEB_DEPLOY_HOOK_URL;
    }

    // 6. Estado real del build.
    assert.equal(vercelConfig({} as NodeJS.ProcessEnv), null, "sin token → sin config");
    const cfg = vercelConfig({ VERCEL_TOKEN: "t" } as NodeJS.ProcessEnv);
    assert.ok(cfg && cfg.projectId.startsWith("prj_") && cfg.teamId.startsWith("team_"), "defaults del proyecto web");
    const fakeDeployments = (list: unknown[], status = 200) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        assert.match(String(url), /api\.vercel\.com\/v6\/deployments\?projectId=prj_.*target=production&limit=1/);
        assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer t");
        return new Response(JSON.stringify({ deployments: list }), { status });
      }) as unknown as typeof fetch;
    const ready = await latestProductionDeployment(cfg!, fakeDeployments([{ readyState: "READY", created: 1, ready: 2, url: "x.vercel.app", meta: { githubCommitSha: "abc", deployHookId: "h" } }]));
    assert.deepEqual({ state: ready?.state, sha: ready?.sha, via: ready?.via, url: ready?.url }, { state: "READY", sha: "abc", via: "hook", url: "https://x.vercel.app" });
    const building = await latestProductionDeployment(cfg!, fakeDeployments([{ state: "BUILDING", created: 1, meta: { githubCommitSha: "def", githubDeployment: "1" } }]));
    assert.deepEqual({ state: building?.state, via: building?.via, ready_at: building?.ready_at }, { state: "BUILDING", via: "git", ready_at: null });
    assert.equal(await latestProductionDeployment(cfg!, fakeDeployments([], 401)), null, "401 de Vercel → null, no throw");
    assert.equal(await latestProductionDeployment(cfg!, fakeDeployments([])), null, "sin deploys → null");
    ok("estado del build: sin token null; READY/BUILDING mapeados con via hook/git; 401 → null");
    // GET con token pero Vercel caído → status_configured true y deployment null.
    process.env.VERCEL_TOKEN = "t";
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    try {
      const g = fakeRes();
      await (GET as unknown as Handler)(fakeReq(knex) as never, g.res as never);
      const b = g.out.body as { status_configured: boolean; deployment: unknown };
      assert.equal(b.status_configured, true);
      assert.equal(b.deployment, null);
      ok("GET con token y Vercel caído → status_configured:true, deployment:null (nunca 500)");
    } finally {
      globalThis.fetch = realFetch2;
      delete process.env.VERCEL_TOKEN;
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }

  console.log(results.join("\n"));
  console.log(`\nverify-web-redeploy: ${results.length}/${results.length} OK (transacción revertida)`);
}

main().catch((e) => {
  console.error("verify-web-redeploy FAILED:", e);
  process.exit(1);
});
