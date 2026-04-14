import { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";
import { syncPricesCore } from "../lib/quickbooks/sync-prices-core";
import { syncCustomersCore } from "../lib/quickbooks/sync-customers-core";
import { isQbIntegrationEnabled } from "../lib/quickbooks/qb-integration-guard";
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger";

/**
 * QuickBooks Daily Sync — runs every 30 minutes; executes at the configured hour.
 *
 * Price sync: uses price_sync_hour (0–23) in the store timezone to decide when to run.
 *   - Checks if today's scheduled sync has already run (anti-duplicate).
 *   - Manual "Sync Now" does NOT prevent the scheduled run (independent).
 *
 * Customer sync: runs once at the same hour if configured.
 *
 * Schedule: every 30 min — hour check done internally.
 */
export default async function qbDailySyncHandler(container: MedusaContainer) {
  const TAG = "[QB-AUTO-SYNC]";
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // Master kill switch
    if (!(await isQbIntegrationEnabled())) {
      console.log(`${TAG} Integration disabled — skipping all syncs.`);
      return;
    }

    const { rows } = await client.query(`
            SELECT
                price_interval_minutes,
                customer_interval_minutes,
                last_price_sync,
                last_customer_sync,
                price_sync_hour,
                price_sync_timezone
            FROM quickbooks_config
            WHERE id = 'default'
        `);

    if (!rows.length) {
      console.warn(`${TAG} No config row found — skipping.`);
      return;
    }

    const cfg = rows[0];

    // ─── Determine current hour in configured timezone ──────────────────
    const tz = cfg.price_sync_timezone || "America/New_York";
    const now = new Date();
    const currentHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hour12: false,
        timeZone: tz,
      }).format(now),
      10
    );

    // Helper: get "YYYY-MM-DD" in the store timezone
    const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
      now
    );

    // ─── Price Sync ────────────────────────────────────────────────────────
    if (cfg.price_interval_minutes) {
      const isDaily = cfg.price_interval_minutes >= 1440;
      let shouldRunPrice = false;

      if (isDaily) {
        // ── Daily mode: run once a day at the configured hour ──────────
        const targetHour: number = cfg.price_sync_hour ?? 0;

        if (currentHour !== targetHour) {
          console.log(
            `${TAG} Price sync not due yet (Daily: target ${targetHour}:00, current ${currentHour}:xx ${tz}).`
          );
        } else {
          let alreadyRan = false;
          if (cfg.last_price_sync) {
            const lastDateStr = new Intl.DateTimeFormat("en-CA", {
              timeZone: tz,
            }).format(new Date(cfg.last_price_sync));
            const lastHour = parseInt(
              new Intl.DateTimeFormat("en-US", {
                hour: "numeric",
                hour12: false,
                timeZone: tz,
              }).format(new Date(cfg.last_price_sync)),
              10
            );
            if (lastDateStr === todayStr && lastHour === targetHour) {
              alreadyRan = true;
              console.log(
                `${TAG} Price sync already completed today at ${targetHour}:00 ${tz}. Skipping.`
              );
            }
          }
          if (!alreadyRan) shouldRunPrice = true;
        }
      } else {
        // ── Interval mode: slot-based scheduling ──────────────────────────
        // Runs at exact clock-aligned multiples (e.g. 1h → :00, 2h → :00/:02…)
        const intervalMs = cfg.price_interval_minutes * 60 * 1000;
        const nowSlot = Math.floor(Date.now() / intervalMs);
        const lastSlot = cfg.last_price_sync
          ? Math.floor(new Date(cfg.last_price_sync).getTime() / intervalMs)
          : -1;
        if (nowSlot === lastSlot) {
          const nextInMin = Math.round(
            ((nowSlot + 1) * intervalMs - Date.now()) / 60000
          );
          console.log(
            `${TAG} Price sync: already ran in this ${cfg.price_interval_minutes}m slot — next in ~${nextInMin} min.`
          );
        } else {
          shouldRunPrice = true;
        }
      }

      if (shouldRunPrice) {
        const modeLabel = isDaily
          ? `daily at ${cfg.price_sync_hour ?? 0}:00 ${tz}`
          : `every ${cfg.price_interval_minutes}min`;
        console.log(`${TAG} ⏰ Running price sync (${modeLabel})...`);
        const logId = await QbSyncLogger.start({
          operation: "price_sync",
          syncType: "price",
          triggeredBy: "auto",
          message: `Scheduled price sync started (${modeLabel})`,
          db: client,
        });
        try {
          const result = await syncPricesCore(container as any);
          if (result.success) {
            await client.query(
              `UPDATE quickbooks_config SET last_price_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
            );
            const msg = `Prices: ${result.stats.updatedPrice} retail + ${result.stats.updatedWholesale ?? 0} wholesale updated`;
            console.log(`${TAG} ✅ ${msg}`);
            await QbSyncLogger.complete(logId, { message: msg, db: client });
          } else {
            console.error(`${TAG} ❌ Price sync failed: ${result.error}`);
            await QbSyncLogger.fail(logId, result.error || "Unknown error", {
              db: client,
            });
          }
        } catch (e: any) {
          console.error(`${TAG} ❌ Price sync threw: ${e.message}`);
          await QbSyncLogger.fail(logId, e.message, { db: client });
        }
      }
    }

    // ─── Customer Sync ─────────────────────────────────────────────────────
    if (cfg.customer_interval_minutes) {
      const isCustomerDaily = cfg.customer_interval_minutes >= 1440;
      let shouldRunCustomer = false;

      if (isCustomerDaily) {
        // Daily mode: run once at the configured hour
        const targetHour: number = cfg.price_sync_hour ?? 0;
        if (currentHour !== targetHour) {
          // skip silently
        } else {
          let alreadyRan = false;
          if (cfg.last_customer_sync) {
            const lastDateStr = new Intl.DateTimeFormat("en-CA", {
              timeZone: tz,
            }).format(new Date(cfg.last_customer_sync));
            if (lastDateStr === todayStr) {
              alreadyRan = true;
              console.log(
                `${TAG} Customer sync already completed today. Skipping.`
              );
            }
          }
          if (!alreadyRan) shouldRunCustomer = true;
        }
      } else {
        // Interval mode: slot-based scheduling
        const cIntervalMs = cfg.customer_interval_minutes * 60 * 1000;
        const nowSlot = Math.floor(Date.now() / cIntervalMs);
        const lastSlot = cfg.last_customer_sync
          ? Math.floor(new Date(cfg.last_customer_sync).getTime() / cIntervalMs)
          : -1;
        if (nowSlot === lastSlot) {
          const nextInMin = Math.round(
            ((nowSlot + 1) * cIntervalMs - Date.now()) / 60000
          );
          console.log(
            `${TAG} Customer sync: already ran in this ${cfg.customer_interval_minutes}m slot — next in ~${nextInMin} min.`
          );
        } else {
          shouldRunCustomer = true;
        }
      }

      if (shouldRunCustomer) {
        console.log(`${TAG} ⏰ Running customer sync...`);
        const logId = await QbSyncLogger.start({
          operation: "customer_sync",
          syncType: "customer",
          triggeredBy: "auto",
          message: "Scheduled customer sync started",
          db: client,
        });
        try {
          const result = await syncCustomersCore(container as any);
          if (result.success) {
            await client.query(
              `UPDATE quickbooks_config SET last_customer_sync = NOW(), updated_at = NOW() WHERE id = 'default'`
            );
            const msg = `Customers: ${result.stats?.imported ?? 0} imported`;
            console.log(`${TAG} ✅ ${msg}`);
            await QbSyncLogger.complete(logId, { message: msg, db: client });
          } else {
            console.error(`${TAG} ❌ Customer sync failed: ${result.error}`);
            await QbSyncLogger.fail(logId, result.error || "Unknown error", {
              db: client,
            });
          }
        } catch (e: any) {
          console.error(`${TAG} ❌ Customer sync threw: ${e.message}`);
          await QbSyncLogger.fail(logId, e.message, { db: client });
        }
      }
    }

    // ─── Log Cleanup (fallback if pg_cron not available) ───────────────────
    try {
      const deleted = await QbSyncLogger.cleanup(90, client);
      if (deleted > 0)
        console.log(
          `${TAG} 🗑️ Cleaned up ${deleted} old QB sync log entries (>90 days)`
        );
    } catch {
      /* non-blocking */
    }
  } catch (error: any) {
    console.error(`${TAG} Job outer failure: ${error.message}`);
  } finally {
    await client.end();
  }
}

/**
 * Medusa scheduled job config.
 * Fires every 30 minutes — hour-based trigger done internally.
 * This replaces the old "0 0 * * *" (midnight-only) cron.
 */
export const config = {
  name: "quickbooks-daily-sync",
  schedule: "*/30 * * * *",
};
