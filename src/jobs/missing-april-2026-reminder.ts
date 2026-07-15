/**
 * Daily reminder cron — alerts loudly if April 2026 QuickBooks data hasn't
 * been imported yet. April 2026 is the unique handover month: Medusa went
 * live mid-month so it can't generate a complete April from pos_invoice.
 * Without the QB Excel import, every product shows 0 sales for that quarter
 * slot. The cron self-silences once data is loaded.
 *
 * Runs daily at 09:00 ET. Active window: 2026-05-01 → 2026-06-30. Outside
 * that window the warning is suppressed (April either has time, or the rolling
 * 12-month window has already moved past it).
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import { checkMissingSalesData } from "../services/purchasing/missing-month-check";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
export const config = {
  name: "missing-april-2026-reminder",
  schedule: "0 9 * * *",
};

export default async function missingApril2026Reminder(
  _container: MedusaContainer
) {
  if (isScheduledJobsDisabled(_container)) return;

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const warnings = await checkMissingSalesData(db);
    if (warnings.length === 0) return;
    for (const w of warnings) {
      console.error("");
      console.error(
        "════════════════════════════════════════════════════════════════════"
      );
      console.error(`  ⚠️  ${w.level.toUpperCase()} — ${w.code}`);
      console.error(`  ${w.message}`);
      if (w.action) console.error(`  → ${w.action}`);
      console.error(
        "════════════════════════════════════════════════════════════════════"
      );
      console.error("");
    }
  } finally {
    await db.end();
  }
}
