/**
 * Runs the daily digest once, against the SANDBOX only, and prints the email it
 * would have sent instead of sending it.
 *
 * Exists to verify the orders-index drift section end to end: inject drift into
 * the sandbox index by hand, run this, and read the report.
 *
 * THREE THINGS STOP THIS FROM MAILING PRODUCTION:
 *   1. It calls buildDigestEmail, not the job. The send lives in the job's default
 *      export and is never reached from here — there is no mail provider in this
 *      code path at all.
 *   2. It refuses to run unless DATABASE_URL and MEILISEARCH_HOST both point at
 *      the sandbox ports (5499 / 7799).
 *   3. It deletes RESEND_API_KEY and SENDGRID_API_KEY from the environment first.
 *      `medusa exec` runs dotenv over backend/.env, which HAS the production
 *      Resend key — verified: without this the key is present. Being in the
 *      sandbox is not by itself enough.
 *
 * A sent email is not undoable, so all three stay.
 *
 * Usage (from backend/):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *       REDIS_URL='redis://localhost:6399' \
 *       MEILISEARCH_HOST='http://localhost:7799' \
 *       MEILISEARCH_API_KEY='sandbox_master_key' \
 *     ./node_modules/.bin/medusa exec ./src/scripts/debug/run-qb-digest-once.ts
 *
 * Set DIGEST_DUMP_HTML=/tmp/digest.html to also write the body to a file.
 */
import { writeFileSync } from "fs";

import type { ExecArgs } from "@medusajs/framework/types";

import { buildDigestEmail } from "../../jobs/qb-pipeline-error-digest";

const SANDBOX_DB_PORT = ":5499";
const SANDBOX_MEILI_PORT = ":7799";

export default async function run({ container }: ExecArgs): Promise<void> {
  const db = process.env.DATABASE_URL ?? "";
  const meili = process.env.MEILISEARCH_HOST ?? "";

  if (!db.includes(SANDBOX_DB_PORT) || !meili.includes(SANDBOX_MEILI_PORT)) {
    console.error(
      `\nREFUSING TO RUN — this is not the sandbox.\n` +
        `  DATABASE_URL must contain ${SANDBOX_DB_PORT} (got ${db ? "something else" : "nothing"})\n` +
        `  MEILISEARCH_HOST must contain ${SANDBOX_MEILI_PORT} (got ${meili || "nothing"})\n` +
        `Running the digest against production would email the real recipient.\n`
    );
    process.exit(2);
  }

  delete process.env.RESEND_API_KEY;
  delete process.env.SENDGRID_API_KEY;

  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
  };
  const knex = (container as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  );

  const mail = await buildDigestEmail(container, knex, logger);

  console.log("\n──────── digest result ────────");
  if (!mail) {
    console.log(
      "NO EMAIL — nothing to report (no pipeline errors, no orders index drift)."
    );
    console.log("───────────────────────────────\n");
    return;
  }

  console.log(`subject   : ${mail.subject}`);
  console.log(`qb errors : ${mail.qbErrors}`);
  console.log(`drift rows: ${mail.driftRows}`);
  console.log(`bytes     : ${mail.html.length}`);
  // The send path cannot run from here, so the closest thing to verifying the
  // digest_notified_at stamping is checking that the ids it would stamp are the
  // ids that were actually reported.
  console.log(
    `stamp ids : item=${mail.stampItemIds.length} sales=${mail.stampSalesIds.length}` +
      (mail.stampSalesIds.length ? ` e.g. ${mail.stampSalesIds[0]}` : "")
  );

  const hasDriftSection = mail.html.includes("Orders Search Index");
  console.log(`orders index section present: ${hasDriftSection ? "YES" : "no"}`);

  if (hasDriftSection) {
    // Strip tags so the drift table is readable in a terminal.
    const section = mail.html.slice(mail.html.indexOf("Orders Search Index"));
    const text = section
      .replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim();
    console.log("\n--- orders index section (text) ---");
    console.log(text.slice(0, 4000));
  }

  const dumpPath = process.env.DIGEST_DUMP_HTML;
  if (dumpPath) {
    writeFileSync(dumpPath, mail.html, "utf8");
    console.log(`\nfull html written to ${dumpPath}`);
  }
  console.log("───────────────────────────────\n");
}
