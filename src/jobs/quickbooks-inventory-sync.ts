import { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard";
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger";
import { syncInventoryCore } from "../lib/quickbooks/sync-inventory-core";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
/**
 * QuickBooks Inventory Auto-Sync — cron fires every 10 minutes.
 *
 * The actual sync only executes when:
 *  1. No inventory sync is currently in progress (in-progress guard via qb_sync_log)
 *  2. The configured interval has elapsed since the last sync attempt
 *     (slot-based check against last_inventory_sync in the DB)
 *  3. Store hours allow it (if inventory_respect_hours is enabled)
 *
 * last_inventory_sync is updated at the START of a sync (not just on success).
 * This prevents two backend instances (local + Railway) from both passing the
 * slot check and launching concurrent syncs.
 */
export default async function qbInventorySyncHandler(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const TAG = "[QB-INVENTORY-AUTO]";
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Master kill switch
    if (!(await isQbIntegrationEnabled())) {
      console.log(`${TAG} Integration disabled — skipping.`);
      return;
    }

    // Read config — uses store_hours_* columns (unified with config UI)
    const { rows } = await client.query(`
            SELECT
                inventory_interval_minutes,
                last_inventory_sync,
                inventory_respect_hours,
                store_hours_open_hour,
                store_hours_close_hour,
                store_hours_timezone
            FROM quickbooks_config
            WHERE id = 'default'
        `);

    if (!rows.length) {
      console.warn(`${TAG} No config found — skipping.`);
      return;
    }

    const {
      inventory_interval_minutes,
      last_inventory_sync,
      inventory_respect_hours,
      store_hours_open_hour,
      store_hours_close_hour,
      store_hours_timezone,
    } = rows[0];

    // Respect the "Disabled" setting in the UI
    if (!inventory_interval_minutes) {
      console.log(
        `${TAG} Inventory auto-sync is disabled (interval = null). Skipping.`
      );
      return;
    }

    // ─── In-progress guard ────────────────────────────────────────────────────
    // Prevents concurrent syncs when two backend instances (e.g. local + Railway)
    // are running simultaneously, or when a previous sync is still polling.
    // Looks for any inventory_sync entry with status='processing' in the last
    // (interval + 5 min) window — generous enough to cover the 10-min poll timeout.
    const guardWindowMin = inventory_interval_minutes + 5;
    const { rows: inProgress } = await client.query(
      `SELECT id FROM qb_sync_log
             WHERE operation = 'inventory_sync'
               AND status = 'processing'
               AND initiated_at > NOW() - ($1 || ' minutes')::INTERVAL
             LIMIT 1`,
      [guardWindowMin]
    );
    if (inProgress.length > 0) {
      console.log(
        `${TAG} ⚠️  Sync already in progress — skipping to avoid concurrent runs.`
      );
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

    // ─── Slot-based interval check ────────────────────────────────────────────
    // Runs at exact clock-aligned multiples of the interval (e.g. 20min → :00,:20,:40,…).
    // last_inventory_sync is updated at START (see below) so both local + Railway
    // instances will see the same slot and the second one will skip.
    const intervalMs = inventory_interval_minutes * 60 * 1000;
    const nowSlot = Math.floor(Date.now() / intervalMs);
    const lastSlot = last_inventory_sync
      ? Math.floor(new Date(last_inventory_sync).getTime() / intervalMs)
      : -1;

    if (nowSlot === lastSlot) {
      const nextSlotMs = (nowSlot + 1) * intervalMs;
      const nextInMin = Math.round((nextSlotMs - Date.now()) / 60000);
      console.log(
        `${TAG} ⏳ Already ran in this ${inventory_interval_minutes}m slot — next slot in ~${nextInMin} min.`
      );
      return;
    }
    // ─────────────────────────────────────────────────────────────────────

    // ─── Store hours check ────────────────────────────────────────────────
    if (
      inventory_respect_hours &&
      store_hours_open_hour != null &&
      store_hours_close_hour != null
    ) {
      const tz = store_hours_timezone || "America/New_York";
      const now = new Date();

      const currentHour = parseInt(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hour12: false,
          timeZone: tz,
        }).format(now),
        10
      );

      const start = Number(store_hours_open_hour);
      const end = Number(store_hours_close_hour);

      if (currentHour < start || currentHour >= end) {
        console.log(
          `${TAG} Outside store hours (${currentHour}:xx — window is ${start}:00–${end}:00 ${tz}). Skipping sync.`
        );
        return;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Mark the slot as taken BEFORE starting — prevents a second instance from
    // passing the slot check while this sync is still running (takes 2–10 min).
    await client.query(
      `UPDATE quickbooks_config SET last_inventory_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
    );

    const logId = await QbSyncLogger.start({
      operation: "inventory_sync",
      syncType: "inventory",
      triggeredBy: "auto",
      message: `Inventory sync started (interval: ${inventory_interval_minutes}m)`,
      db: client,
    });

    console.log(
      `${TAG} ⏰ Running inventory sync (interval: ${inventory_interval_minutes}m)...`
    );
    const result = await syncInventoryCore(container as any);

    if (result.success) {
      const msg = `Done: ${result.stats.updatedStock} levels updated`;
      console.log(`${TAG} ✅ ${msg}`);

      // Filter out QB negative-to-zero corrections (not real inventory changes)
      // and store up to 200 changed items in the log for ActivityLog display.
      const displayItems = (result.preview ?? [])
        .filter((i) => !i.wasNegativeInQb)
        .slice(0, 200)
        .map((i) => ({
          sku: i.sku,
          name: i.name,
          prev: i.currentStock,
          next: i.newStock,
          delta: i.delta,
          anomaly: i.isAnomaly || undefined,
        }));

      await QbSyncLogger.complete(logId, {
        message: msg,
        db: client,
        metadata:
          displayItems.length > 0 ? { changedItems: displayItems } : undefined,
      });
    } else {
      console.error(`${TAG} ❌ Sync failed: ${result.error}`);
      await QbSyncLogger.fail(logId, result.error || "Unknown error", {
        db: client,
      });
    }
  } catch (error: any) {
    console.error(`${TAG} Job error: ${error.message}`);
  } finally {
    await client.end();
  }
}

export const config = {
  name: "quickbooks-inventory-sync",
  schedule: "*/10 * * * *", // fires every 10 min; interval check done internally
};
