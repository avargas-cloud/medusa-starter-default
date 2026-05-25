/**
 * Backfill ALL customers (with a valid email) into Mailchimp.
 *
 * Run:
 *   # Dry run (default) — prints what would happen, no API calls
 *   yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 *
 *   # Real run, limited smoke test
 *   APPLY=true LIMIT=10 yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 *
 *   # Full backfill
 *   APPLY=true yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 *
 *   # Re-sync customers already tracked
 *   APPLY=true INCLUDE_SYNCED=true yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 *
 *   # Override cutoff (default: 2026-04-14 America/New_York)
 *   APPLY=true CUTOFF=2026-04-14T04:00:00Z yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 *
 *   # Tune concurrency (default 5; cap is Mailchimp's 10 connection limit per API key)
 *   APPLY=true CONCURRENCY=3 yarn medusa exec ./src/scripts/sync/sync-customers-to-mailchimp.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";
import {
  customerToMailchimpPayload,
  deriveCustomerStatus,
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  NEW_CUSTOMER_CUTOFF_UTC,
  type CustomerForMailchimp,
  type MailchimpInitialStatus,
  type MailchimpSyncMetadata,
  type MailchimpSyncResult,
} from "../../modules/mailchimp";

const LOG = "[mailchimp-backfill]";

const APPLY = process.env.APPLY === "true";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;
const INCLUDE_SYNCED = process.env.INCLUDE_SYNCED === "true";
/** Default true — placeholder emails (noemail@*, etc.) are dummy values from
 *  the QB legacy import and should NOT be pushed to Mailchimp. Override with
 *  INCLUDE_PLACEHOLDERS=true only if you have a specific reason. */
const INCLUDE_PLACEHOLDERS = process.env.INCLUDE_PLACEHOLDERS === "true";
const CONCURRENCY = Math.min(
  Math.max(parseInt(process.env.CONCURRENCY ?? "5", 10), 1),
  10
);
const CUTOFF = process.env.CUTOFF
  ? new Date(process.env.CUTOFF)
  : NEW_CUSTOMER_CUTOFF_UTC;

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

export default async function syncCustomersToMailchimp({
  container,
}: ExecArgs): Promise<void> {
  const log = (m: string) => console.log(`${LOG} ${m}`);
  log(`mode=${APPLY ? "APPLY (live)" : "DRY-RUN"}`);
  log(`cutoff=${CUTOFF.toISOString()} (created_at ≥ cutoff → "New Customer", else → "Active")`);
  log(`concurrency=${CONCURRENCY}, include_synced=${INCLUDE_SYNCED}, limit=${LIMIT ?? "none"}`);

  if (APPLY && (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID)) {
    throw new Error(`${LOG} MAILCHIMP_API_KEY and MAILCHIMP_AUDIENCE_ID are required when APPLY=true`);
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  let mailchimpService: MailchimpModuleService | null = null;
  if (APPLY) {
    mailchimpService = container.resolve<MailchimpModuleService>(MAILCHIMP_MODULE);
  }

  try {
    const skipSyncedClause = INCLUDE_SYNCED
      ? sql``
      : sql`AND (c.metadata->'mailchimp'->>'synced_at' IS NULL)`;
    const placeholderClause = INCLUDE_PLACEHOLDERS
      ? sql``
      : sql`AND COALESCE(c.metadata->>'email_is_placeholder', 'false') <> 'true'`;
    const limitClause = LIMIT ? sql`LIMIT ${LIMIT}` : sql``;

    // Universe: customers who have at least one POS invoice OR order since the
    // cutoff. Excludes placeholder emails by default and customers we've already
    // synced (unless INCLUDE_SYNCED=true).
    const rows = await sql<CustomerRow[]>`
      WITH active_buyers AS (
        SELECT DISTINCT customer_id FROM pos_invoice
        WHERE customer_id IS NOT NULL AND created_at >= ${CUTOFF}
        UNION
        SELECT DISTINCT customer_id FROM "order"
        WHERE customer_id IS NOT NULL AND created_at >= ${CUTOFF} AND deleted_at IS NULL
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
        ORDER BY
          (ca.is_default_billing IS TRUE) DESC,
          (ca.is_default_shipping IS TRUE) DESC,
          ca.created_at ASC
        LIMIT 1
      ) a ON TRUE
      WHERE c.deleted_at IS NULL
        AND c.email IS NOT NULL
        AND c.email <> ''
        ${placeholderClause}
        ${skipSyncedClause}
      ORDER BY c.created_at ASC
      ${limitClause}
    `;

    log(`fetched ${rows.length} customers to process`);
    if (rows.length === 0) return;

    const stats = { created: 0, updated: 0, skipped_compliance: 0, error: 0, dryrun: 0 };
    const errors: { email: string; error: string }[] = [];
    const status = defaultStatusFromEnv();

    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const myIndex = cursor++;
        const row = rows[myIndex];
        const customer = rowToCustomer(row);
        const payload = customerToMailchimpPayload(customer, status);

        if (!APPLY) {
          stats.dryrun++;
          if (myIndex < 5 || myIndex % 100 === 0) {
            console.log(
              `${LOG} [dryrun ${myIndex + 1}/${rows.length}] ${payload.email} → MMERGE7="${deriveCustomerStatus(
                row.created_at
              )}" CUSTYPE="${payload.mergeFields.CUSTYPE ?? ""}" ACQCHN="${payload.mergeFields.ACQCHN ?? ""}"`
            );
          }
          continue;
        }

        let result: MailchimpSyncResult;
        try {
          result = await mailchimpService!.upsertMember(payload);
        } catch (err: unknown) {
          result = {
            email: payload.email,
            subscriberHash: "",
            action: "error",
            status: null,
            isOptedOut: false,
            error: (err as Error).message,
          };
        }

        stats[result.action]++;
        if (result.action === "error") {
          errors.push({ email: payload.email, error: result.error ?? "unknown" });
        }

        const tracker: MailchimpSyncMetadata = {
          synced_at: new Date().toISOString(),
          subscriber_hash: result.subscriberHash,
          last_status: result.status,
          last_action: result.action,
          is_opted_out: result.isOptedOut,
          last_error: result.error ?? null,
        };

        // Direct SQL update — bypasses customer.updated event so the live
        // subscriber doesn't re-fire during a backfill run. Roundtrip through
        // JSON.parse(JSON.stringify) coerces the typed tracker into a plain
        // JSON-shaped value so sql.json() emits a native JSONB object.
        const trackerJsonValue = JSON.parse(JSON.stringify(tracker));
        await sql`
          UPDATE customer
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('mailchimp', ${sql.json(trackerJsonValue)}),
              updated_at = NOW()
          WHERE id = ${row.id}
        `;

        if ((myIndex + 1) % 25 === 0) {
          log(
            `progress ${myIndex + 1}/${rows.length} — created=${stats.created} updated=${stats.updated} skipped=${stats.skipped_compliance} err=${stats.error}`
          );
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    log(`──────────── DONE ────────────`);
    log(`total: ${rows.length}`);
    if (APPLY) {
      log(`created (new in mailchimp):  ${stats.created}`);
      log(`updated (existing in mc):    ${stats.updated}`);
      log(`skipped_compliance (optout): ${stats.skipped_compliance}`);
      log(`errors:                       ${stats.error}`);
      if (errors.length > 0) {
        log(`── ERROR SAMPLE (first 10) ──`);
        errors.slice(0, 10).forEach((e) => log(`  ${e.email}: ${e.error}`));
      }
    } else {
      log(`dry-run processed: ${stats.dryrun}`);
      log(`set APPLY=true to execute`);
    }
  } finally {
    await sql.end();
  }
}
