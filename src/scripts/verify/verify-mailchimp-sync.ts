/**
 * Verify a random sample of synced customers against what's actually in Mailchimp.
 *
 * Useful after a backfill or when a deploy might have caused drift.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/verify/verify-mailchimp-sync.ts
 *   SAMPLE=50 yarn medusa exec ./src/scripts/verify/verify-mailchimp-sync.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";
import {
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  subscriberHash,
  type MailchimpSyncMetadata,
} from "../../modules/mailchimp";

const LOG = "[mailchimp-verify]";
const SAMPLE_SIZE = parseInt(process.env.SAMPLE ?? "20", 10);

export default async function verifyMailchimpSync({
  container,
}: ExecArgs): Promise<void> {
  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) {
    throw new Error(`${LOG} MAILCHIMP_API_KEY / MAILCHIMP_AUDIENCE_ID missing`);
  }

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });
  const mailchimpService = container.resolve<MailchimpModuleService>(MAILCHIMP_MODULE);

  try {
    const totalRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM customer
      WHERE deleted_at IS NULL
        AND metadata->'mailchimp'->>'synced_at' IS NOT NULL
    `;
    const total = parseInt(totalRows[0]?.count ?? "0", 10);
    console.log(`${LOG} ${total} customers with a local Mailchimp tracker`);

    const sample = await sql<
      {
        id: string;
        email: string;
        first_name: string | null;
        last_name: string | null;
        company_name: string | null;
        metadata: Record<string, unknown> | null;
      }[]
    >`
      SELECT id, email, first_name, last_name, company_name, metadata
      FROM customer
      WHERE deleted_at IS NULL
        AND metadata->'mailchimp'->>'synced_at' IS NOT NULL
        AND email IS NOT NULL AND email <> ''
      ORDER BY RANDOM()
      LIMIT ${SAMPLE_SIZE}
    `;

    console.log(`${LOG} sampling ${sample.length} customers for drift check\n`);

    let matched = 0;
    let mismatched = 0;
    let missing = 0;
    let lastActionCounts: Record<string, number> = {};

    for (const row of sample) {
      const tracker = (row.metadata as Record<string, unknown> | null)?.mailchimp as
        | MailchimpSyncMetadata
        | undefined;
      if (tracker?.last_action) {
        lastActionCounts[tracker.last_action] = (lastActionCounts[tracker.last_action] ?? 0) + 1;
      }

      const mcMember = await mailchimpService.getMember(row.email);
      if (!mcMember) {
        console.log(`${LOG} ❌ MISSING in Mailchimp: ${row.email}`);
        missing++;
        continue;
      }

      const mcMerge = (mcMember.merge_fields ?? {}) as Record<string, unknown>;
      const expectedFname = row.first_name?.trim() ?? "";
      const expectedLname = row.last_name?.trim() ?? "";
      const expectedCompany = row.company_name?.trim() ?? "";

      const drift: string[] = [];
      if ((mcMerge.FNAME ?? "") !== expectedFname) {
        drift.push(`FNAME local="${expectedFname}" mc="${mcMerge.FNAME ?? ""}"`);
      }
      if ((mcMerge.LNAME ?? "") !== expectedLname) {
        drift.push(`LNAME local="${expectedLname}" mc="${mcMerge.LNAME ?? ""}"`);
      }
      if ((mcMerge.MMERGE5 ?? "") !== expectedCompany) {
        drift.push(`Company local="${expectedCompany}" mc="${mcMerge.MMERGE5 ?? ""}"`);
      }
      if (tracker?.subscriber_hash && tracker.subscriber_hash !== subscriberHash(row.email)) {
        drift.push(`subscriberHash recomputes differently — email may have changed`);
      }

      if (drift.length > 0) {
        console.log(`${LOG} ⚠️  DRIFT ${row.email}: ${drift.join(" | ")}`);
        mismatched++;
      } else {
        matched++;
      }
    }

    console.log(`\n${LOG} ──────────── RESULTS ────────────`);
    console.log(`${LOG} sample size:        ${sample.length}`);
    console.log(`${LOG} matched:            ${matched}`);
    console.log(`${LOG} drifted:            ${mismatched}`);
    console.log(`${LOG} missing in MC:      ${missing}`);
    console.log(`${LOG} last_action breakdown: ${JSON.stringify(lastActionCounts)}`);
  } finally {
    await sql.end();
  }
}
