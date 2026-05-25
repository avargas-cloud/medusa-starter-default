/**
 * GET /admin/email-marketing/overview
 *
 * Provider-agnostic dashboard payload — the only place that knows the
 * provider name is the env var + the Mailchimp API call below. If we ever
 * switch to Klaviyo/Brevo/Mailerlite, change this file and the dashboard
 * keeps working.
 *
 * Returns:
 *   {
 *     provider, audience: { id, name, total_contacts },
 *     last_cron_run: { started_at, ended_at, ...stats } | null,
 *     rolling_7d:  { created, updated, skipped_compliance, errors },
 *     rolling_30d: { created, updated, skipped_compliance, errors },
 *     local_synced_count
 *   }
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import postgres from "postgres";

const PROVIDER = "Mailchimp";

export async function GET(
  _req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  const apiKey = process.env.MAILCHIMP_API_KEY;

  if (!apiKey || !audienceId) {
    res.status(503).json({ error: "Mailchimp env vars not configured" });
    return;
  }

  const server = apiKey.split("-")[1];
  if (!server) {
    res.status(500).json({ error: "MAILCHIMP_API_KEY is malformed" });
    return;
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    // ── Mailchimp side: audience info ─────────────────────────────────
    const auth = Buffer.from(`anystring:${apiKey}`).toString("base64");
    const audienceRes = await fetch(
      `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}?fields=id,name`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!audienceRes.ok) {
      res.status(502).json({
        error: `Mailchimp audience fetch failed: ${audienceRes.status} ${audienceRes.statusText}`,
      });
      return;
    }
    const audience = (await audienceRes.json()) as { id: string; name: string };

    // Total contacts (all statuses incl. transactional) — Mailchimp's
    // `stats.member_count` only counts subscribed, which is misleading for
    // CRM-style integrations like ours.
    const totalsRes = await fetch(
      `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members?count=1&fields=total_items`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const totals = (await totalsRes.json()) as { total_items: number };

    // ── Local side: cron history + rolling windows ────────────────────
    const lastCron = await sql<
      {
        started_at: Date;
        ended_at: Date | null;
        processed: number;
        created: number;
        updated: number;
        skipped_compliance: number;
        errors: number;
      }[]
    >`
      SELECT started_at, ended_at, processed, created, updated, skipped_compliance, errors
      FROM mailchimp_sync_runs
      WHERE triggered_by = 'cron' AND ended_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 1
    `;

    const rollingRows = await sql<
      {
        window_days: number;
        created: string;
        updated: string;
        skipped_compliance: string;
        errors: string;
      }[]
    >`
      WITH per_customer AS (
        SELECT
          c.metadata->'mailchimp'->>'last_action' AS action,
          (c.metadata->'mailchimp'->>'synced_at')::timestamptz AS synced_at
        FROM customer c
        WHERE c.metadata->'mailchimp'->>'synced_at' IS NOT NULL
      )
      SELECT
        w.days AS window_days,
        COUNT(*) FILTER (WHERE p.action = 'created') AS created,
        COUNT(*) FILTER (WHERE p.action = 'updated') AS updated,
        COUNT(*) FILTER (WHERE p.action = 'skipped_compliance') AS skipped_compliance,
        COUNT(*) FILTER (WHERE p.action = 'error') AS errors
      FROM (VALUES (7), (30)) AS w(days)
      LEFT JOIN per_customer p ON p.synced_at >= NOW() - (w.days || ' days')::interval
      GROUP BY w.days
    `;

    const rolling7 = rollingRows.find((r) => r.window_days === 7);
    const rolling30 = rollingRows.find((r) => r.window_days === 30);

    const localSynced = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM customer
      WHERE metadata->'mailchimp'->>'synced_at' IS NOT NULL
    `;

    res.json({
      provider: PROVIDER,
      audience: {
        id: audience.id,
        name: audience.name,
        total_contacts: totals.total_items,
      },
      last_cron_run: lastCron[0]
        ? {
            started_at: lastCron[0].started_at,
            ended_at: lastCron[0].ended_at,
            processed: lastCron[0].processed,
            created: lastCron[0].created,
            updated: lastCron[0].updated,
            skipped_compliance: lastCron[0].skipped_compliance,
            errors: lastCron[0].errors,
          }
        : null,
      rolling_7d: rolling7
        ? {
            created: parseInt(rolling7.created, 10),
            updated: parseInt(rolling7.updated, 10),
            skipped_compliance: parseInt(rolling7.skipped_compliance, 10),
            errors: parseInt(rolling7.errors, 10),
          }
        : { created: 0, updated: 0, skipped_compliance: 0, errors: 0 },
      rolling_30d: rolling30
        ? {
            created: parseInt(rolling30.created, 10),
            updated: parseInt(rolling30.updated, 10),
            skipped_compliance: parseInt(rolling30.skipped_compliance, 10),
            errors: parseInt(rolling30.errors, 10),
          }
        : { created: 0, updated: 0, skipped_compliance: 0, errors: 0 },
      local_synced_count: parseInt(localSynced[0]?.count ?? "0", 10),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await sql.end();
  }
}
