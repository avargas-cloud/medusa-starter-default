import { randomUUID } from "crypto";
import { pollBridgeStatus } from "./bridge-fetch";

import { ICustomerModuleService } from "@medusajs/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import postgres from "postgres";

import { isQbIntegrationEnabled } from "./qb-integration-guard";
import { requireBridgeUrl } from "./bridge-url";

// Config — from env vars

const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes — 7200 customers take time to process
const INITIAL_WAIT_MS = 2 * 60 * 1000; // wait 2 min before first poll
const MAX_POLL_ATTEMPTS = 8; // up to 16 min total

// QB custom field name for acquisition channel ("Distribution Channel" en QB UI).
const DISTRIBUTION_CHANNEL_FIELD = "Distribution Channel";

// Legacy QB values that no longer should be used — mapped to current values.
const LEGACY_CHANNEL_MAP: Record<string, string> = {
  "Walk In": "Sign",
  International: "Referred",
};

function extractDistributionChannel(qb: any): string | null {
  const raw = qb?.DataExtRet;
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  for (const d of list) {
    if (d?.DataExtName === DISTRIBUTION_CHANNEL_FIELD) {
      const v = (d.DataExtValue || "").trim();
      return v || null;
    }
  }
  return null;
}

export interface SyncCustomersResult {
  success: boolean;
  stats: {
    totalInQb: number;
    alreadyInMedusa: number;
    imported: number;
    emailsUpdated: number;
    errors: number;
  };
  error?: string;
}

/**
 * Core logic for syncing customers from QuickBooks to Medusa
 * Only imports customers that don't exist in Medusa yet
 *
 * @NOTE: This is a simplified version. The full import logic from
 * import-customers-from-qb.ts includes address parsing, name parsing, etc.
 * For now, this imports basic customer data and saves for Phase 2.
 */
export async function syncCustomersCore(
  container: any,
  options: { onLog?: (line: string) => void } = {}
): Promise<SyncCustomersResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerModule: ICustomerModuleService = container.resolve(
    Modules.CUSTOMER
  );
  const log = (line: string) => {
    logger.info(line);
    options.onLog?.(line);
  };
  const warn = (line: string) => {
    logger.warn(line);
    options.onLog?.(`⚠️ ${line}`);
  };

  const stats = {
    totalInQb: 0,
    alreadyInMedusa: 0,
    imported: 0,
    emailsUpdated: 0,
    errors: 0,
  };

  // Load valid acquisition_channel values from system_defaults.
  // Usado para validar el valor de Distribution Channel que viene de QB
  // antes de escribirlo a customer.metadata.acquisition_channel.
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  let validChannelValues = new Set<string>();
  try {
    const defaultsRes = await pg.raw(
      `SELECT value FROM system_defaults
       WHERE context = 'Customer Defaults'
         AND field_name = 'Acquisition Channel';`
    );
    validChannelValues = new Set(
      (defaultsRes.rows as Array<{ value: string }>).map((r) => r.value)
    );
  } catch {
    // Non-fatal — if the table isn't available, acquisition_channel just won't be set.
  }
  const resolveChannel = (raw: string | null): string | null => {
    if (!raw) return null;
    const mapped = LEGACY_CHANNEL_MAP[raw] ?? raw;
    return validChannelValues.has(mapped) ? mapped : null;
  };

  try {
    // Master integration kill switch
    if (!(await isQbIntegrationEnabled())) {
      logger.info("[QB] Integration is DISABLED. Skipping customer sync.");
      return {
        success: false,
        stats: {
          totalInQb: 0,
          alreadyInMedusa: 0,
          imported: 0,
          emailsUpdated: 0,
          errors: 0,
        },
        error: "QB integration is disabled",
      };
    }
    logger.info(`👥 Starting QuickBooks Customer Sync...`);
    logger.info(
      `⏰ Sync initiated: ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" })}`
    );

    // 1. Fetch QB Customers
    logger.info("📡 Requesting Customer Data from Bridge...");
    const initRes = await fetch(
      `${requireBridgeUrl()}/api/customers?MaxReturned=99999&ActiveStatus=All`,
      {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
      }
    );

    if (!initRes.ok) {
      const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`;
      logger.error(`❌ ${error}`);
      return { success: false, stats, error };
    }

    const initJson: any = await initRes.json();
    const operationId = initJson.operationId;
    logger.info(`✅ Operation Queued! ID: ${operationId}`);

    // 2. Poll for Results (7200 customers = QB takes ~10 min to process)
    let qbCustomers: any[] = [];
    let attempts = 0;

    // Wait before first poll — QB needs time to pull all 7200 customers
    log(`⏳ Waiting 2 minutes before first poll (large dataset)...`);
    await new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      log(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`);

      const polled = await pollBridgeStatus(operationId);
      if (polled.status === "expired") {
        const error = `QB sync op ${operationId} expired (bridge returned 404)`;
        warn(`   ${error}`);
        return { success: false, stats, error };
      }
      const statusJson: any = polled.data;

      if (statusJson.success && statusJson.operation) {
        if (statusJson.operation.status === "completed") {
          // Data is in operation.result.QBXML.QBXMLMsgsRs.CustomerQueryRs.CustomerRet
          // (xml2js parsed QB XML, explicitArray: false — single item = object, multi = array)
          const raw =
            statusJson.operation.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs
              ?.CustomerRet;
          qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw];
          log(
            `✅ Data Received! ${qbCustomers.length} customers from QuickBooks.`
          );
          break;
        }

        if (statusJson.operation.status === "failed") {
          const error = `QB sync failed: ${statusJson.operation.error || "Unknown"}`;
          logger.error(`❌ ${error}`);
          return { success: false, stats, error };
        }

        log(`   Status: ${statusJson.operation.status} — waiting...`);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (qbCustomers.length === 0) {
      const error = "No customer data received from QB";
      logger.error(`❌ ${error}`);
      return { success: false, stats, error };
    }

    stats.totalInQb = qbCustomers.length;

    // 3. Fetch Existing Medusa Customers (indexed by qb_list_id)
    logger.info("🔍 Checking existing customers in Medusa...");
    const [medusaCustomers] = await customerModule.listAndCountCustomers(
      {},
      {
        take: 10000,
        select: ["id", "email", "metadata"],
      }
    );

    // Map qb_list_id → { medusa_id, medusa_email }
    const qbIdToMedusa = new Map<string, { id: string; email: string }>(
      medusaCustomers
        .filter((c: any) => c.metadata?.qb_list_id)
        .map((c: any) => [c.metadata.qb_list_id, { id: c.id, email: c.email }])
    );
    const existingQbIds = new Set(qbIdToMedusa.keys());

    // Map email → medusa_id (for customers without qb_list_id yet)
    const emailToMedusaId = new Map<string, string>(
      medusaCustomers
        .filter((c: any) => !c.metadata?.qb_list_id && c.email)
        .map((c: any) => [c.email.toLowerCase(), c.id])
    );

    logger.info(`📊 Found ${existingQbIds.size} customers already in Medusa`);

    // Pre-load customer group IDs (once, before the loop)
    let wholesaleGroupId: string | null = null;
    let retailGroupId: string | null = null;
    try {
      const sql = postgres(process.env.DATABASE_URL!);
      const groups = await sql<{ id: string; name: string }[]>`
                SELECT id, name FROM customer_group WHERE deleted_at IS NULL AND name IN ('Wholesale', 'Retail')
            `;
      for (const g of groups) {
        if (g.name === "Wholesale") wholesaleGroupId = g.id;
        if (g.name === "Retail") retailGroupId = g.id;
      }
      await sql.end();
      log(
        `📦 Customer groups loaded: Wholesale=${wholesaleGroupId ? "✅" : "❌"} Retail=${retailGroupId ? "✅" : "❌"}`
      );
    } catch (e: any) {
      warn(
        `Could not load customer groups (group assignment will be skipped): ${e.message}`
      );
    }

    // 4. Detect email changes for existing customers (qb_list_id is the primary key)
    const existingCustomers = qbCustomers.filter((c) =>
      existingQbIds.has(c.ListID)
    );
    const newCustomers = qbCustomers.filter(
      (c) => !existingQbIds.has(c.ListID)
    );
    stats.alreadyInMedusa = existingCustomers.length;

    logger.info(
      `\n🔄 Checking ${existingCustomers.length} existing customers for email changes...`
    );
    let emailChangeCount = 0;

    for (const qb of existingCustomers) {
      try {
        const qbEmail = qb.Email?.trim() || "";
        const isRealEmail =
          qbEmail.includes("@") &&
          !qbEmail.toLowerCase().startsWith("customer-");
        if (!isRealEmail) continue; // Skip placeholder/blank emails

        const medusa = qbIdToMedusa.get(qb.ListID)!;
        if (!medusa) continue;

        const emailChanged =
          qbEmail.toLowerCase() !== medusa.email?.toLowerCase();

        if (emailChanged) {
          const normalizedEmail = qbEmail.toLowerCase();
          log(
            `   📧 Email changed for QB ${qb.ListID}: ${medusa.email} → ${normalizedEmail}`
          );
          await customerModule.updateCustomers(medusa.id, {
            email: normalizedEmail,
          });
          stats.emailsUpdated++;
          emailChangeCount++;
        }
      } catch (err: any) {
        warn(
          `   ❌ Failed to update email for QB ${qb.ListID}: ${err.message}`
        );
        stats.errors++;
      }
    }

    if (emailChangeCount > 0) {
      log(`   ✅ Updated emails for ${emailChangeCount} customers`);
    } else {
      log(`   ✅ No email changes detected`);
    }

    // 5. Import New Customers
    logger.info(`\n🔄 Importing ${newCustomers.length} new customers...`);

    for (const qb of newCustomers) {
      try {
        // Basic email handling
        let email = qb.Email?.trim();
        const qbOriginalEmail = email; // preserved pre-lowercase for metadata
        let isDummyEmail = false;

        if (!email || !email.includes("@")) {
          const slug =
            `${qb.FirstName || ""} ${qb.LastName || qb.Name || ""}`
              .trim()
              .toLowerCase()
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .replace(/[^a-z0-9\s]/g, "")
              .trim()
              .replace(/\s+/g, ".") || "customer";
          email = `${slug}@noemail.ecopowertech.com`;
          isDummyEmail = true;
        }

        // Normalize email to lowercase (Medusa findOrCreateCustomerStep is case-sensitive)
        email = email.toLowerCase();

        // Basic name parsing
        const firstName = qb.FirstName || qb.Name?.split(" ")[0] || "Customer";
        const lastName =
          qb.LastName || qb.Name?.split(" ").slice(1).join(" ") || "";

        // Map price level: All non-wholesale are Retail, Distributor -> Wholesale
        const qbPriceLevel = (
          qb.PriceLevelRef?.FullName ||
          qb.PriceLevel ||
          ""
        ).toLowerCase();
        const priceLevel =
          qbPriceLevel.includes("wholesale") ||
          qbPriceLevel.includes("distributor")
            ? "Wholesale"
            : "Retail";
        const customerType =
          qb.CustomerTypeRef?.FullName || qb.CustomerType || "";

        // Acquisition Channel desde QB DataExtRet["Distribution Channel"].
        // Valores legacy se mapean; valores no listados en system_defaults se ignoran.
        const channel = resolveChannel(extractDistributionChannel(qb));

        const qbMeta: Record<string, any> = {
          legacy_customer: true,
          qb_list_id: qb.ListID,
          qb_display_name: qb.Name,
          qb_customer_type: customerType,
          qb_price_level: priceLevel,
          email_is_placeholder: isDummyEmail,
          qb_original_email: isDummyEmail
            ? qb.Email || ""
            : qbOriginalEmail || email,
        };
        if (channel) {
          qbMeta.acquisition_channel = channel;
        }

        // If customer already exists by email (registered via web), link QB metadata instead of creating duplicate
        const existingId = emailToMedusaId.get(email.toLowerCase());
        let customerId: string;

        if (existingId) {
          await customerModule.updateCustomers(existingId, {
            metadata: qbMeta,
          });
          customerId = existingId;
          log(`   🔗 Linked QB data to existing customer: ${email}`);
        } else {
          const newCustomer = (await customerModule.createCustomers({
            email,
            first_name: firstName,
            last_name: lastName,
            company_name: qb.CompanyName || null,
            phone: qb.Phone || null,
            has_account: false,
            metadata: qbMeta,
          })) as any;
          customerId = newCustomer.id;
        }

        // Assign to correct Medusa customer group
        const targetGroupId =
          priceLevel === "Wholesale" ? wholesaleGroupId : retailGroupId;
        if (targetGroupId && customerId) {
          try {
            const sql = postgres(process.env.DATABASE_URL!);
            await sql`
                            INSERT INTO customer_group_customer (id, customer_id, customer_group_id)
                            VALUES (${randomUUID()}, ${customerId}, ${targetGroupId})
                            ON CONFLICT DO NOTHING
                        `;
            await sql.end();
          } catch (groupErr: any) {
            warn(
              `   ⚠️  Could not assign group to ${email}: ${groupErr.message}`
            );
          }
        }

        stats.imported++;

        if (stats.imported % 50 === 0) {
          log(`   ✅ Progress: ${stats.imported} customers imported...`);
        }
      } catch (err: any) {
        if (err.message?.includes("already exists")) {
          // QB duplicate — same email under a different ListID, already synced. Skip silently.
          stats.alreadyInMedusa++;
        } else {
          warn(`   ❌ Failed to import ${qb.Email}: ${err.message}`);
          stats.errors++;
        }
      }
    }

    log(`\n${"=".repeat(50)}`);
    log("✅ CUSTOMER SYNC SUMMARY");
    log(`${"-".repeat(50)}`);
    log(`Total in QB:           ${stats.totalInQb}`);
    log(`Already in Medusa:     ${stats.alreadyInMedusa}`);
    log(`Newly Imported:        ${stats.imported}`);
    log(`Errors:                ${stats.errors}`);
    log(`${"=".repeat(50)}\n`);

    return { success: true, stats };
  } catch (error: any) {
    logger.error(`❌ Sync failed: ${error.message}`);
    return { success: false, stats, error: error.message };
  }
}
