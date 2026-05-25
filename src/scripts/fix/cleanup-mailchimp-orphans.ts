/**
 * One-shot cleanup of the 15 Mailchimp orphans discovered 2026-05-25.
 *
 *  - 7 customer orphans: same person already in Mailchimp under a corrected
 *    email. We ARCHIVE the old record (Mailchimp's archive = soft delete:
 *    frees the audience slot, doesn't count toward billing, can be restored
 *    later if needed; not a hard purge).
 *
 *  - 8 internal staff: tag with `staff` so future segments can exclude them
 *    from customer-facing campaigns. We don't archive them — they're useful
 *    for QA of campaigns.
 *
 * Idempotent: archiving an already-archived member returns 404 (handled).
 * Tagging is additive (won't remove other tags they may already have).
 *
 *   yarn medusa exec ./src/scripts/fix/cleanup-mailchimp-orphans.ts          # dry run
 *   APPLY=true yarn medusa exec ./src/scripts/fix/cleanup-mailchimp-orphans.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import {
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  subscriberHash,
} from "../../modules/mailchimp";

const APPLY = process.env.APPLY === "true";
const LOG = "[mc-cleanup]";

/** Customer orphans to archive — phone-matched 1:1 to existing customers in DB. */
const ORPHAN_ARCHIVE: { old: string; superseded_by: string; reason: string }[] = [
  { old: "ENRAJO@HOTMAIL.COM",            superseded_by: "goldenwoodinc@gmail.com",  reason: "Joel Couret (Golden Wood Inc) — email changed" },
  { old: "projectsdg@gmail.com",          superseded_by: "projectsdgllc@gmail.com",  reason: "Projects DG LLC — email variant" },
  { old: "vdastudiodesign@gmail.com",     superseded_by: "brinzicorp@gmail.com",     reason: "Christian Bonzi (Brinzi Corp) — email changed" },
  { old: "AFRANCO@ALONSOFRANCON.COM",     superseded_by: "afranco@alonsofranco.com", reason: "Alonso Franco — typo francon→franco" },
  { old: "ORANSHREM@GMAIL.COM",           superseded_by: "rcrr923@gmail.com",        reason: "Roberto Ramirez — email changed" },
  { old: "BRAVO'SCARPENTER@GMAIL.COM",    superseded_by: "bravoscarpenter@gmail.com",reason: "Allan Hernandez — typo apostrophe removed" },
  { old: "INFO@ROYALTY_CC.COM",           superseded_by: "info@royaltycc.com",       reason: "Yasmany Oliva — typo underscore removed" },
];

/** Internal EcoPowerTech staff — tag with `staff`, don't archive. */
const STAFF_EMAILS: string[] = [
  "j.peralta@ecopowertech.com",
  "a.arenas@ecopowertech.com",
  "j.vargas@ecopowertech.com",
  "r.peralta@fx-aa.com",
  "andreavillamizarvc@gmail.com",
  "e.peralta@ecopowertech.com",
  "a.guedez@ecopowertech.com",
  "m.perez@ecopowertech.com",
];

export default async function cleanupMailchimpOrphans({ container }: ExecArgs): Promise<void> {
  const log = (m: string) => console.log(`${LOG} ${m}`);
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  log(`will archive ${ORPHAN_ARCHIVE.length} customer orphans`);
  log(`will tag ${STAFF_EMAILS.length} staff emails with 'staff'`);

  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) {
    throw new Error(`${LOG} MAILCHIMP_API_KEY / MAILCHIMP_AUDIENCE_ID required`);
  }

  const mailchimpService = container.resolve<MailchimpModuleService>(MAILCHIMP_MODULE);
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;
  const server = apiKey.split("-")[1];
  const auth = Buffer.from(`anystring:${apiKey}`).toString("base64");

  const stats = { archived: 0, archive_skipped: 0, archive_errors: 0, tagged: 0, tag_errors: 0 };

  // ── 1. Archive orphans ──────────────────────────────────────────────
  log(`──── ARCHIVE ORPHANS ────`);
  for (const o of ORPHAN_ARCHIVE) {
    const hash = subscriberHash(o.old);
    log(`  ${o.old} → archive (superseded by ${o.superseded_by}, ${o.reason})`);
    if (!APPLY) continue;

    try {
      const res = await fetch(
        `https://${server}.api.mailchimp.com/3.0/lists/${audienceId}/members/${hash}`,
        { method: "DELETE", headers: { Authorization: `Basic ${auth}` } }
      );
      if (res.status === 204) {
        stats.archived++;
      } else if (res.status === 404) {
        log(`    ⚠️  not found in Mailchimp (already archived?) — skipping`);
        stats.archive_skipped++;
      } else {
        const body = await res.text();
        log(`    ❌ archive failed: ${res.status} ${body.slice(0, 200)}`);
        stats.archive_errors++;
      }
    } catch (err: unknown) {
      log(`    ❌ archive threw: ${(err as Error).message}`);
      stats.archive_errors++;
    }
  }

  // ── 2. Tag staff ────────────────────────────────────────────────────
  log(`──── TAG STAFF ────`);
  for (const email of STAFF_EMAILS) {
    log(`  ${email} → +tag 'staff'`);
    if (!APPLY) continue;

    try {
      // Verify the member exists first — `syncTags` would throw on 404.
      const existing = await mailchimpService.getMember(email);
      if (!existing) {
        log(`    ⚠️  not in Mailchimp — skipping`);
        continue;
      }
      await mailchimpService.syncTags(email, ["staff"]);
      stats.tagged++;
    } catch (err: unknown) {
      log(`    ❌ tag failed: ${(err as Error).message}`);
      stats.tag_errors++;
    }
  }

  log(`──── SUMMARY ────`);
  log(`archived:        ${stats.archived}`);
  log(`archive skipped: ${stats.archive_skipped}`);
  log(`archive errors:  ${stats.archive_errors}`);
  log(`tagged:          ${stats.tagged}`);
  log(`tag errors:      ${stats.tag_errors}`);
  if (!APPLY) log(`(DRY-RUN — set APPLY=true to execute)`);
}
