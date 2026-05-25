/**
 * Export to CSV every Mailchimp member whose email does NOT match any
 * customer in our Medusa DB. These are "orphans" — contacts paying for an
 * audience slot but with no business value in the POS.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/verify/export-mailchimp-orphans.ts
 *   OUTPUT=/tmp/orphans.csv yarn medusa exec ./src/scripts/verify/export-mailchimp-orphans.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import fs from "fs";
import path from "path";
import postgres from "postgres";

const LOG = "[mailchimp-orphans]";
const PAGE_SIZE = 1000;

interface McMemberFull {
  email_address: string;
  status: string;
  merge_fields: Record<string, unknown>;
  timestamp_signup: string | null;
  timestamp_opt: string | null;
  last_changed: string | null;
}

interface McResponse {
  members: McMemberFull[];
  total_items: number;
}

async function fetchAllMembers(audienceId: string, apiKey: string): Promise<McMemberFull[]> {
  const server = apiKey.split("-")[1];
  const auth = Buffer.from(`anystring:${apiKey}`).toString("base64");
  const all: McMemberFull[] = [];
  let offset = 0;

  while (true) {
    const url =
      `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members` +
      `?count=${PAGE_SIZE}&offset=${offset}` +
      `&fields=members.email_address,members.status,members.merge_fields,members.timestamp_signup,members.timestamp_opt,members.last_changed,total_items`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) throw new Error(`Mailchimp fetch failed at offset ${offset}: ${res.status}`);
    const data = (await res.json()) as McResponse;
    all.push(...data.members);
    console.log(`${LOG} fetched ${all.length}/${data.total_items} members`);
    if (data.members.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default async function exportMailchimpOrphans({
  container: _container,
}: ExecArgs): Promise<void> {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    throw new Error(`${LOG} MAILCHIMP_API_KEY + MAILCHIMP_AUDIENCE_ID required`);
  }

  const outputPath =
    process.env.OUTPUT ??
    path.join(
      process.cwd(),
      `mailchimp-orphans-${new Date().toISOString().slice(0, 10)}.csv`
    );

  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    const members = await fetchAllMembers(audienceId, apiKey);
    console.log(`${LOG} total Mailchimp members: ${members.length}`);

    const emails = members
      .map((m) => m.email_address?.trim().toLowerCase())
      .filter((e): e is string => !!e);

    // Which of these match a customer? Anything NOT in this set is an orphan.
    const matched = await sql<{ email: string }[]>`
      SELECT DISTINCT LOWER(email) AS email
      FROM customer
      WHERE deleted_at IS NULL
        AND email IS NOT NULL
        AND LOWER(email) = ANY(${emails})
    `;
    const matchedSet = new Set(matched.map((r) => r.email));

    const orphans = members.filter((m) => {
      const email = m.email_address?.trim().toLowerCase();
      return email && !matchedSet.has(email);
    });

    console.log(`${LOG} orphans (in Mailchimp, no customer in DB): ${orphans.length}`);

    const headers = [
      "email",
      "first_name",
      "last_name",
      "company",
      "customer_type",
      "acquisition_channel",
      "phone",
      "status",
      "last_changed",
      "first_purchase",
      "last_purchase",
      "total_purchases",
      "total_amount",
    ];

    const lines: string[] = [headers.join(",")];
    for (const m of orphans) {
      const mf = (m.merge_fields ?? {}) as Record<string, unknown>;
      lines.push(
        [
          m.email_address,
          mf.FNAME,
          mf.LNAME,
          mf.MMERGE5,
          mf.CUSTYPE,
          mf.ACQCHN,
          mf.PHONE,
          m.status,
          m.last_changed,
          mf.MMERGE9, // First Purchase
          mf.MMERGE10, // Last Purchase
          mf.MMERGE11, // Number of Purchases
          mf.MMERGE12, // Total Amount
        ]
          .map(csvEscape)
          .join(",")
      );
    }

    fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
    console.log(`${LOG} ✅ wrote ${orphans.length} rows to ${outputPath}`);

    // Print first 5 to console for a quick sanity peek
    console.log(`${LOG} ── First 5 ──`);
    for (const m of orphans.slice(0, 5)) {
      const mf = (m.merge_fields ?? {}) as Record<string, unknown>;
      console.log(
        `${LOG}   ${m.email_address}  (${mf.FNAME ?? ""} ${mf.LNAME ?? ""}) [${m.status}] last_changed=${m.last_changed}`
      );
    }
  } finally {
    await sql.end();
  }
}
