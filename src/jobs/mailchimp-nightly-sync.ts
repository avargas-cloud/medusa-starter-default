/**
 * Mailchimp nightly sync — runs every day at 3:00 AM EDT (07:00 UTC).
 *
 * Catches customers the live subscriber missed (e.g., direct SQL inserts/
 * updates from import scripts) and refreshes stale Mailchimp data for
 * customers whose POS record changed but the subscriber didn't fire.
 *
 * Scope:
 *   - Customers in the "active buyers since 2026-04-14" cohort
 *     (same as the backfill script — see sync-customers-to-mailchimp.ts)
 *   - Whose Mailchimp tracker is missing OR stale (synced_at < updated_at)
 *
 * Result is logged to `mailchimp_sync_runs` so the /email-marketing
 * dashboard can show "Último sync: hace 4h, +5 nuevos, 0 errores".
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import postgres from "postgres";
import { generateEntityId } from "@medusajs/utils";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
import {
  customerToMailchimpPayload,
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  NEW_CUSTOMER_CUTOFF_UTC,
  type CustomerForMailchimp,
  type MailchimpInitialStatus,
  type MailchimpSyncMetadata,
} from "../modules/mailchimp";

export const config = {
  name: "mailchimp-nightly-sync",
  // Daily at 07:00 UTC = 3:00 AM EDT (matches QB digest cadence).
  schedule: "0 7 * * *",
};

const MAX_PER_RUN = 500;
const CONCURRENCY = 5;

function defaultStatusFromEnv(): MailchimpInitialStatus {
  const raw = (process.env.MAILCHIMP_DEFAULT_STATUS ?? "transactional").toLowerCase();
  if (raw === "subscribed" || raw === "transactional" || raw === "pending") return raw;
  return "transactional";
}

interface CustomerRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  company_name: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country_code: string | null;
  address_phone: string | null;
}

function rowToCustomer(row: CustomerRow): CustomerForMailchimp {
  return {
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    company_name: row.company_name,
    created_at: row.created_at,
    metadata: row.metadata,
    defaultAddress: row.address_1
      ? {
          address_1: row.address_1,
          address_2: row.address_2,
          city: row.city,
          province: row.province,
          postal_code: row.postal_code,
          country_code: row.country_code,
          phone: row.address_phone,
        }
      : null,
  };
}

export default async function mailchimpNightlySync(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };

  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) {
    logger.info("[mailchimp-nightly] skipped — env vars missing");
    return;
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 3 });
  const runId = generateEntityId("", "mcrun");

  try {
    // Open a run row immediately so the dashboard can show "running now".
    await sql`
      INSERT INTO mailchimp_sync_runs (id, triggered_by, scope, cutoff_used)
      VALUES (${runId}, 'cron', 'active-buyers-stale-or-missing', ${NEW_CUSTOMER_CUTOFF_UTC})
    `;

    const rows = await sql<CustomerRow[]>`
      WITH active_buyers AS (
        SELECT DISTINCT customer_id FROM pos_invoice
          WHERE customer_id IS NOT NULL AND created_at >= ${NEW_CUSTOMER_CUTOFF_UTC}
        UNION
        SELECT DISTINCT customer_id FROM "order"
          WHERE customer_id IS NOT NULL AND created_at >= ${NEW_CUSTOMER_CUTOFF_UTC}
            AND deleted_at IS NULL
      )
      SELECT
        c.id, c.email, c.first_name, c.last_name, c.phone, c.company_name,
        c.created_at, c.metadata,
        a.address_1, a.address_2, a.city, a.province, a.postal_code,
        a.country_code, a.phone AS address_phone
      FROM customer c
      JOIN active_buyers ab ON ab.customer_id = c.id
      LEFT JOIN LATERAL (
        SELECT * FROM customer_address ca
        WHERE ca.customer_id = c.id AND ca.deleted_at IS NULL
        ORDER BY (ca.is_default_billing IS TRUE) DESC, (ca.is_default_shipping IS TRUE) DESC, ca.created_at ASC
        LIMIT 1
      ) a ON TRUE
      WHERE c.deleted_at IS NULL
        AND c.email IS NOT NULL AND c.email <> ''
        AND COALESCE(c.metadata->>'email_is_placeholder', 'false') <> 'true'
        AND (
          c.metadata->'mailchimp'->>'synced_at' IS NULL
          OR (c.metadata->'mailchimp'->>'synced_at')::timestamptz < c.updated_at
        )
      ORDER BY c.updated_at DESC
      LIMIT ${MAX_PER_RUN}
    `;

    const status = defaultStatusFromEnv();
    const mailchimpService = container.resolve<MailchimpModuleService>(MAILCHIMP_MODULE);

    const stats = {
      created: 0,
      updated: 0,
      skipped_compliance: 0,
      email_changed: 0,
      error: 0,
      errors: 0, // duplicate counter for stats[action]==='error' indexing
    };
    const errorSample: { email: string; error: string }[] = [];

    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        if (!row) break;
        const customer = rowToCustomer(row);
        const payload = customerToMailchimpPayload(customer, status);

        const result = await mailchimpService
          .upsertMember(payload)
          .catch((err: Error) => ({
            email: payload.email,
            subscriberHash: "",
            action: "error" as const,
            status: null,
            isOptedOut: false,
            error: err.message,
          }));

        stats[result.action]++;
        if (result.action === "error") {
          stats.errors++;
          if (errorSample.length < 10) {
            errorSample.push({ email: payload.email, error: result.error ?? "unknown" });
          }
        }

        const tracker: MailchimpSyncMetadata = {
          synced_at: new Date().toISOString(),
          subscriber_hash: result.subscriberHash,
          last_email: payload.email,
          last_status: result.status,
          last_action: result.action,
          is_opted_out: result.isOptedOut,
          last_error: result.error ?? null,
        };
        const trackerJsonValue = JSON.parse(JSON.stringify(tracker));
        await sql`
          UPDATE customer
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('mailchimp', ${sql.json(trackerJsonValue)}),
              updated_at = NOW()
          WHERE id = ${row.id}
        `;
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    await sql`
      UPDATE mailchimp_sync_runs
      SET ended_at = NOW(),
          processed = ${rows.length},
          created = ${stats.created},
          updated = ${stats.updated},
          skipped_compliance = ${stats.skipped_compliance},
          errors = ${stats.errors},
          error_sample = ${sql.json(JSON.parse(JSON.stringify(errorSample)))}
      WHERE id = ${runId}
    `;

    logger.info(
      `[mailchimp-nightly] run=${runId} processed=${rows.length} created=${stats.created} updated=${stats.updated} skipped=${stats.skipped_compliance} errors=${stats.errors}`
    );
  } catch (err: unknown) {
    const msg = (err as Error).message;
    await sql`
      UPDATE mailchimp_sync_runs
      SET ended_at = NOW(),
          notes = ${`fatal: ${msg}`}
      WHERE id = ${runId}
    `.catch(() => {});
    logger.error(`[mailchimp-nightly] fatal: ${msg}`);
  } finally {
    await sql.end();
  }
}
