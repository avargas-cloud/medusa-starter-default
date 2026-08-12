/**
 * migrate-order-status-sent-by-email
 *
 * Consolidates the legacy `"order".metadata.order_status` values 'Sent' and
 * 'Email Sent' into the canonical 'Sent by Email'. Measured in prod on
 * 2026-08-12: 1 row with 'Sent' + 43 rows with 'Email Sent' (28 estimates,
 * 16 real orders) = 44 rows expected.
 *
 * `metadata.estimate_status` is a SEPARATE legacy key and is measured at 0
 * rows with these values — this script never touches it, only warns if the
 * measurement has drifted.
 *
 * The 16 real orders updated here fire the `order` row trigger into
 * `meili_sync_queue`; the `orderReconciler` re-syncs their Meili doc on its
 * own — no manual reindex needed after this runs.
 *
 * Dry run (default):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     ./node_modules/.bin/tsx src/scripts/fix/migrate-order-status-sent-by-email.ts
 *
 * Apply:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) APPLY=true \
 *     ./node_modules/.bin/tsx src/scripts/fix/migrate-order-status-sent-by-email.ts
 */
import { existsSync, writeFileSync } from "fs";

import { Client } from "pg";

const APPLY = process.env.APPLY === "true";
const CARDINALITY_GUARD = 60;

interface LegacyRow {
  id: string;
  display_id: string | null;
  is_draft_order: boolean;
  status: string;
}

interface BackupRow {
  id: string;
  display_id: string | null;
  old_status: string;
}

const FIND_LEGACY = `
  SELECT id, display_id, is_draft_order, metadata->>'order_status' AS status
    FROM "order"
   WHERE deleted_at IS NULL
     AND metadata->>'order_status' IN ('Sent','Email Sent')
   ORDER BY display_id
`;

const FIND_ESTIMATE_STATUS_LEGACY = `
  SELECT id, display_id
    FROM "order"
   WHERE deleted_at IS NULL
     AND metadata->>'estimate_status' IN ('Sent','Email Sent')
   ORDER BY display_id
`;

const APPLY_UPDATE = `
  UPDATE "order"
     SET metadata = metadata || jsonb_build_object('order_status', 'Sent by Email')
   WHERE deleted_at IS NULL
     AND metadata->>'order_status' IN ('Sent','Email Sent')
  RETURNING id
`;

function defaultBackupPath(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `/tmp/order-status-migration-backup-${iso}.json`;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log(`\n${APPLY ? "APPLY" : "DRY RUN"}\n`);

    const { rows: legacy } = await client.query<LegacyRow>(FIND_LEGACY);

    console.log(`  legacy rows found: ${legacy.length}\n`);
    for (const r of legacy) {
      console.log(
        `    ${String(r.display_id ?? r.id).padEnd(9)} ${r.status.padEnd(11)} ` +
          `${r.is_draft_order ? "estimate" : "order"}`
      );
    }

    const byStatus = new Map<string, number>();
    const byDraft = new Map<string, number>();
    for (const r of legacy) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      const key = r.is_draft_order ? "estimate" : "order";
      byDraft.set(key, (byDraft.get(key) ?? 0) + 1);
    }
    console.log("\n  by status:");
    for (const [status, n] of byStatus) console.log(`    ${status}: ${n}`);
    console.log("  by is_draft_order:");
    for (const [key, n] of byDraft) console.log(`    ${key}: ${n}`);
    console.log("");

    if (legacy.length === 0) {
      console.log("  nothing to migrate\n");
      return;
    }

    if (legacy.length > CARDINALITY_GUARD) {
      throw new Error(
        `guard tripped: ${legacy.length} legacy rows found, expected <= ${CARDINALITY_GUARD}. ` +
          `Something changed since the measurement (44 rows on 2026-08-12) — refusing to apply blind.`
      );
    }

    const { rows: estimateStatusLegacy } = await client.query<{
      id: string;
      display_id: string | null;
    }>(FIND_ESTIMATE_STATUS_LEGACY);
    if (estimateStatusLegacy.length > 0) {
      console.warn(
        `\n  WARN: ${estimateStatusLegacy.length} row(s) carry legacy values in ` +
          `metadata.estimate_status (expected 0) — NOT touched by this script:`
      );
      for (const r of estimateStatusLegacy) {
        console.warn(`    ${r.display_id ?? r.id}`);
      }
      console.warn("");
    }

    if (!APPLY) {
      console.log("DRY RUN — no se escribió nada. Para aplicar: APPLY=true\n");
      return;
    }

    const backupPath = process.env.BACKUP_PATH || defaultBackupPath();
    if (existsSync(backupPath)) {
      throw new Error(
        `refusing to overwrite existing backup at ${backupPath} — set BACKUP_PATH to a new path`
      );
    }
    const backup: BackupRow[] = legacy.map((r) => ({
      id: r.id,
      display_id: r.display_id,
      old_status: r.status,
    }));
    writeFileSync(backupPath, JSON.stringify(backup, null, 2), "utf8");
    console.log(`  backup written: ${backupPath} (${backup.length} row(s))\n`);

    const { rows: updated } = await client.query<{ id: string }>(APPLY_UPDATE);
    console.log(`  UPDATE affected ${updated.length} row(s)`);

    const { rows: postLegacy } = await client.query<LegacyRow>(FIND_LEGACY);
    const { rows: postCanonical } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM "order"
        WHERE deleted_at IS NULL AND metadata->>'order_status' = 'Sent by Email'`
    );
    const canonicalCount = Number(postCanonical[0]?.n ?? 0);

    if (postLegacy.length !== 0) {
      console.error(
        `\n  POST-VERIFY FAILED: ${postLegacy.length} legacy row(s) remain\n`
      );
      process.exitCode = 1;
      return;
    }
    if (canonicalCount < updated.length) {
      console.error(
        `\n  POST-VERIFY FAILED: only ${canonicalCount} row(s) carry 'Sent by Email', ` +
          `expected at least ${updated.length}\n`
      );
      process.exitCode = 1;
      return;
    }

    console.log(`\nMIGRADAS: ${updated.length} · backup: ${backupPath}\n`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
