/**
 * Reverse backfill: pull EVERY member from the Mailchimp audience, match by
 * email to customers in Medusa DB, and write the `metadata.mailchimp`
 * tracker for matches.
 *
 * Why:
 *   The /email-marketing dashboard shows "N tracked locally" — the count of
 *   customers in our DB with a Mailchimp tracker. After the initial outbound
 *   backfill (sync-customers-to-mailchimp.ts), this number is bounded by the
 *   active-buyers cohort (~207). Mailchimp itself may hold ~600+ extra
 *   contacts imported manually in the past (QB exports, signup forms, etc.).
 *   Those contacts exist in Mailchimp but lack the tracker in our DB, so the
 *   dashboard understates coverage and we can't tell "is this customer in
 *   Mailchimp?" without a Mailchimp API call.
 *
 *   This script closes that gap WITHOUT pushing any new data to Mailchimp —
 *   it only reads from Mailchimp and writes the tracker locally.
 *
 * Idempotent: skips customers that already have a tracker (overridable with
 * OVERWRITE=true). Safe to re-run.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/sync/reverse-backfill-mailchimp-to-db.ts
 *
 *   APPLY=true yarn medusa exec ./src/scripts/sync/reverse-backfill-mailchimp-to-db.ts
 *
 *   OVERWRITE=true APPLY=true yarn medusa exec \
 *     ./src/scripts/sync/reverse-backfill-mailchimp-to-db.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";
import {
  subscriberHash,
  type MailchimpMemberStatus,
  type MailchimpSyncMetadata,
} from "../../modules/mailchimp";

const LOG = "[mailchimp-reverse-backfill]";
const APPLY = process.env.APPLY === "true";
const OVERWRITE = process.env.OVERWRITE === "true";
const PAGE_SIZE = 1000; // Mailchimp max

interface McMember {
  email_address: string;
  status: MailchimpMemberStatus;
}

interface McResponse {
  members: McMember[];
  total_items: number;
}

async function fetchAllMembers(
  audienceId: string,
  apiKey: string
): Promise<McMember[]> {
  const server = apiKey.split("-")[1];
  const auth = Buffer.from(`anystring:${apiKey}`).toString("base64");
  const all: McMember[] = [];
  let offset = 0;

  while (true) {
    const url = `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members?count=${PAGE_SIZE}&offset=${offset}&fields=members.email_address,members.status,total_items`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) {
      throw new Error(`Mailchimp page fetch failed at offset ${offset}: ${res.status}`);
    }
    const data = (await res.json()) as McResponse;
    all.push(...data.members);
    console.log(`${LOG} fetched ${all.length}/${data.total_items} members`);
    if (data.members.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

function isOptedOut(status: MailchimpMemberStatus): boolean {
  return status === "unsubscribed" || status === "cleaned" || status === "archived";
}

export default async function reverseBackfill({ container: _container }: ExecArgs): Promise<void> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    throw new Error(`${LOG} MAILCHIMP_API_KEY + MAILCHIMP_AUDIENCE_ID required`);
  }

  console.log(`${LOG} mode=${APPLY ? "APPLY" : "DRY-RUN"} overwrite=${OVERWRITE}`);
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    // ── 1. Pull all Mailchimp members ────────────────────────────────
    const members = await fetchAllMembers(audienceId, apiKey);
    console.log(`${LOG} total members in Mailchimp: ${members.length}`);

    // ── 2. Build email → status map (last-write-wins on duplicates) ──
    const byEmail = new Map<string, MailchimpMemberStatus>();
    for (const m of members) {
      const email = m.email_address?.trim().toLowerCase();
      if (!email) continue;
      byEmail.set(email, m.status);
    }
    console.log(`${LOG} distinct emails: ${byEmail.size}`);

    // ── 3. Query DB for customers matching those emails ──────────────
    const emails = [...byEmail.keys()];
    const customers = await sql<
      { id: string; email: string; has_tracker: boolean }[]
    >`
      SELECT
        id,
        LOWER(email) AS email,
        (metadata->'mailchimp'->>'synced_at' IS NOT NULL) AS has_tracker
      FROM customer
      WHERE deleted_at IS NULL
        AND email IS NOT NULL
        AND LOWER(email) = ANY(${emails})
    `;

    console.log(`${LOG} customers in DB matching Mailchimp emails: ${customers.length}`);

    const stats = {
      matched_no_tracker: 0,
      matched_already_tracked: 0,
      orphans_in_mailchimp: 0,
      written: 0,
    };

    const matchedEmails = new Set<string>();
    for (const c of customers) {
      matchedEmails.add(c.email);
      if (c.has_tracker && !OVERWRITE) {
        stats.matched_already_tracked++;
        continue;
      }
      stats.matched_no_tracker++;

      const status = byEmail.get(c.email);
      if (!status) continue;

      const tracker: MailchimpSyncMetadata = {
        synced_at: new Date().toISOString(),
        subscriber_hash: subscriberHash(c.email),
        last_email: c.email,
        last_status: status,
        last_action: "updated",
        is_opted_out: isOptedOut(status),
        last_error: null,
      };

      if (!APPLY) continue;

      await sql`
        UPDATE customer
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object('mailchimp', ${sql.json(
                       JSON.parse(JSON.stringify(tracker))
                     )}),
            updated_at = NOW()
        WHERE id = ${c.id}
      `;
      stats.written++;
    }

    // ── 4. Count orphans (in Mailchimp, no matching customer in DB) ──
    stats.orphans_in_mailchimp = byEmail.size - matchedEmails.size;

    console.log(`${LOG} ──────── SUMMARY ────────`);
    console.log(`${LOG} mailchimp members:           ${members.length}`);
    console.log(`${LOG} distinct emails:             ${byEmail.size}`);
    console.log(`${LOG} matched in DB:               ${customers.length}`);
    console.log(`${LOG}   already tracked:           ${stats.matched_already_tracked}`);
    console.log(`${LOG}   needed tracker write:      ${stats.matched_no_tracker}`);
    console.log(`${LOG}   wrote tracker:             ${stats.written} ${APPLY ? "" : "(DRY-RUN)"}`);
    console.log(`${LOG} orphans (only in Mailchimp): ${stats.orphans_in_mailchimp}`);
  } finally {
    await sql.end();
  }
}
