import { defineRouteConfig } from "@medusajs/admin-sdk";
import { CloudArrowUp } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Text, toast } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";

/**
 * Website → "Publish web changes".
 *
 * La web (ecopowertech.com) prerenderiza TODAS las fichas de producto en el
 * build: un atributo cambiado acá no se ve hasta el próximo deploy. Este botón
 * dispara ese deploy (Deploy Hook de Vercel) vía POST /admin/web/redeploy.
 * Ver src/lib/web-redeploy.ts para el contrato (dedupe 2 min, 503 sin hook).
 */

interface RedeployRecord {
  at: string;
  by: string;
  status: "triggering" | "ok" | "failed";
  job_id?: string | null;
  job_state?: string | null;
  error?: string | null;
}

interface DeploymentStatus {
  state: string; // BUILDING | QUEUED | INITIALIZING | READY | ERROR | CANCELED
  sha: string | null;
  created_at: string;
  ready_at: string | null;
  via: "hook" | "git" | "other";
  url: string | null;
}

interface StatusResponse {
  configured: boolean;
  /** Hay VERCEL_TOKEN → `deployment` trae el estado real del último deploy de prod. */
  status_configured: boolean;
  dedupe_seconds: number;
  last: RedeployRecord | null;
  deployment: DeploymentStatus | null;
}

const BUILD_MINUTES = "3-5";

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleString("en-US");
}

/** Sin estado real (sin token): un build disparado hace < 5 min probablemente sigue corriendo. */
function likelyBuilding(last: RedeployRecord | null): boolean {
  return !!last && last.status === "ok" && Date.now() - Date.parse(last.at) < 5 * 60 * 1000;
}

const IN_PROGRESS = new Set(["BUILDING", "QUEUED", "INITIALIZING"]);

/** Con estado real: el deploy que disparó el botón (o cualquiera posterior) sigue en curso. */
function isBuilding(status: StatusResponse | null): boolean {
  if (!status) return false;
  if (status.deployment) return IN_PROGRESS.has(status.deployment.state);
  return likelyBuilding(status.last);
}

const WebsitePage = () => {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/admin/web/redeploy", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus((await r.json()) as StatusResponse);
    } catch (e) {
      toast.error("Could not read deploy status", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresca el "N min ago"; y mientras hay un build en curso, vuelve a pedir el
  // estado real cada 15 s para que "Building…" pase a "Live" solo.
  useEffect(() => {
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (isBuilding(status)) void load();
    }, 15_000);
    return () => window.clearInterval(id);
  }, [status, load]);

  const publish = async () => {
    setBusy(true);
    try {
      const r = await fetch("/admin/web/redeploy", { method: "POST", credentials: "include" });
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        deduped?: boolean;
        triggered?: boolean;
        last?: RedeployRecord;
      };
      if (r.status === 202) {
        toast.success("Deploy triggered", { description: `The website rebuilds now — live in about ${BUILD_MINUTES} minutes.` });
      } else if (r.status === 200 && body.deduped) {
        toast.info("Already building", { description: `A deploy was triggered ${body.last ? ago(body.last.at) : "moments ago"}. Wait for it to finish.` });
      } else {
        toast.error("Deploy not triggered", { description: body.error ?? `HTTP ${r.status}` });
      }
    } catch (e) {
      toast.error("Deploy not triggered", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const last = status?.last ?? null;
  const building = isBuilding(status);
  const dep = status?.deployment ?? null;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Website</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            ecopowertech.com is built as static pages. Product, attribute and category changes made here become visible only after a rebuild.
          </Text>
        </div>
      </div>

      <div className="px-6 py-6 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="large"
            onClick={publish}
            disabled={busy || loading || status?.configured === false}
            isLoading={busy}
            data-testid="publish-web-changes"
          >
            <CloudArrowUp />
            {building ? "Building…" : "Publish web changes"}
          </Button>
          {status && !status.configured && (
            <Badge color="orange" data-testid="web-redeploy-not-configured">Not configured</Badge>
          )}
          {building && <Badge color="blue">Deploy in progress</Badge>}
        </div>

        {status && !status.configured && (
          <Text size="small" className="text-ui-fg-subtle">
            Set <code>VERCEL_WEB_DEPLOY_HOOK_URL</code> in Railway (Vercel → project <em>web</em> → Settings → Git → Deploy Hooks, branch <code>main</code>). The button stays disabled until then.
          </Text>
        )}

        <div className="rounded-md border border-ui-border-base bg-ui-bg-subtle px-4 py-3">
          <Text size="small" weight="plus">Last publish</Text>
          {loading ? (
            <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
          ) : last ? (
            <div className="mt-1 flex flex-col gap-0.5" data-testid="web-redeploy-last">
              <Text size="small">
                {ago(last.at)} · by <code>{last.by}</code> ·{" "}
                {last.status === "ok" ? (
                  <Badge color="green" size="2xsmall">triggered</Badge>
                ) : last.status === "failed" ? (
                  <Badge color="red" size="2xsmall">failed</Badge>
                ) : (
                  <Badge color="grey" size="2xsmall">triggering</Badge>
                )}
              </Text>
              {last.job_id && (
                <Text size="xsmall" className="text-ui-fg-subtle">
                  Vercel job <code>{last.job_id}</code>{last.job_state ? ` · ${last.job_state}` : ""}
                </Text>
              )}
              {last.error && <Text size="xsmall" className="text-ui-fg-error">{last.error}</Text>}
            </div>
          ) : (
            <Text size="small" className="text-ui-fg-subtle">Never triggered from here.</Text>
          )}
        </div>

        <div className="rounded-md border border-ui-border-base bg-ui-bg-subtle px-4 py-3" data-testid="web-deployment-status">
          <Text size="small" weight="plus">Website build</Text>
          {loading ? (
            <Text size="small" className="text-ui-fg-subtle">Loading…</Text>
          ) : dep ? (
            <div className="mt-1 flex flex-col gap-0.5">
              <Text size="small">
                {IN_PROGRESS.has(dep.state) ? (
                  <Badge color="blue" size="2xsmall">Building…</Badge>
                ) : dep.state === "READY" ? (
                  <Badge color="green" size="2xsmall">Live</Badge>
                ) : (
                  <Badge color="red" size="2xsmall">{dep.state}</Badge>
                )}{" "}
                · started {ago(dep.created_at)}
                {dep.ready_at ? ` · live ${ago(dep.ready_at)}` : ""}
                {" · "}
                {dep.via === "hook" ? "from this button" : dep.via === "git" ? "from a git push" : "manual"}
              </Text>
              {dep.sha && (
                <Text size="xsmall" className="text-ui-fg-subtle">
                  commit <code>{dep.sha.slice(0, 8)}</code>
                </Text>
              )}
            </div>
          ) : status?.status_configured ? (
            <Text size="small" className="text-ui-fg-subtle">Could not read the deploy status from Vercel right now.</Text>
          ) : (
            <Text size="small" className="text-ui-fg-subtle">
              Set <code>VERCEL_TOKEN</code> (read-only) in Railway to see the real build status here.
            </Text>
          )}
        </div>

        <Text size="small" className="text-ui-fg-subtle">
          A build takes about {BUILD_MINUTES} minutes. Visitors see the new content on their next page load once it is live — no cache to clear. Repeated clicks within {status ? Math.round(status.dedupe_seconds / 60) : 2} minutes reuse the same build.
        </Text>
      </div>
    </Container>
  );
};

export const config = defineRouteConfig({
  label: "Website",
  icon: CloudArrowUp,
});

export default WebsitePage;
