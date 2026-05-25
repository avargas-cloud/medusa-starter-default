/**
 * GET /admin/email-marketing/activity?days=30
 *
 * Daily breakdown of customer syncs (from customer.metadata.mailchimp tracker)
 * + the most recent 50 sync events for the dashboard's table.
 *
 * Designed to power both:
 *   - Stacked bar chart: created/updated/skipped/errors per day, last N days
 *   - "Recent syncs" table: 50 most recent with action + status + opt-out
 */
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import postgres from "postgres";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const daysParam = parseInt(
    String((req.query as { days?: string }).days ?? "30"),
    10
  );
  const days = isFinite(daysParam) && daysParam > 0 && daysParam <= 365 ? daysParam : 30;

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    // Daily aggregation. Generate the full date series so days with 0
    // activity still appear in the chart (avoids visual gaps).
    const daily = await sql<
      {
        day: string;
        created: string;
        updated: string;
        skipped_compliance: string;
        errors: string;
      }[]
    >`
      WITH per_customer AS (
        SELECT
          (c.metadata->'mailchimp'->>'synced_at')::timestamptz AS synced_at,
          c.metadata->'mailchimp'->>'last_action' AS action
        FROM customer c
        WHERE c.metadata->'mailchimp'->>'synced_at' IS NOT NULL
      ),
      day_series AS (
        SELECT generate_series(
          (NOW() - (${days} || ' days')::interval)::date,
          NOW()::date,
          '1 day'::interval
        )::date AS day
      )
      SELECT
        d.day::text AS day,
        COALESCE(COUNT(*) FILTER (WHERE p.action = 'created'), 0)::text AS created,
        COALESCE(COUNT(*) FILTER (WHERE p.action = 'updated'), 0)::text AS updated,
        COALESCE(COUNT(*) FILTER (WHERE p.action = 'skipped_compliance'), 0)::text AS skipped_compliance,
        COALESCE(COUNT(*) FILTER (WHERE p.action = 'error'), 0)::text AS errors
      FROM day_series d
      LEFT JOIN per_customer p
        ON DATE(p.synced_at) = d.day
      GROUP BY d.day
      ORDER BY d.day ASC
    `;

    const recent = await sql<
      {
        id: string;
        email: string;
        action: string | null;
        last_status: string | null;
        is_opted_out: boolean | null;
        last_error: string | null;
        synced_at: string | null;
      }[]
    >`
      SELECT
        c.id,
        c.email,
        c.metadata->'mailchimp'->>'last_action' AS action,
        c.metadata->'mailchimp'->>'last_status' AS last_status,
        (c.metadata->'mailchimp'->>'is_opted_out')::boolean AS is_opted_out,
        c.metadata->'mailchimp'->>'last_error' AS last_error,
        c.metadata->'mailchimp'->>'synced_at' AS synced_at
      FROM customer c
      WHERE c.metadata->'mailchimp'->>'synced_at' IS NOT NULL
      ORDER BY (c.metadata->'mailchimp'->>'synced_at')::timestamptz DESC
      LIMIT 50
    `;

    res.json({
      daily: daily.map((d) => ({
        day: d.day,
        created: parseInt(d.created, 10),
        updated: parseInt(d.updated, 10),
        skipped_compliance: parseInt(d.skipped_compliance, 10),
        errors: parseInt(d.errors, 10),
      })),
      recent: recent.map((r) => ({
        customer_id: r.id,
        email: r.email,
        action: r.action,
        last_status: r.last_status,
        is_opted_out: r.is_opted_out ?? false,
        last_error: r.last_error,
        synced_at: r.synced_at,
      })),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await sql.end();
  }
}
