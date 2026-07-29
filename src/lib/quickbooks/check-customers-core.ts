import { ICustomerModuleService } from "@medusajs/types";
import { pollBridgeStatus } from "./bridge-fetch";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { Client } from "pg";
import { requireBridgeUrl } from "./bridge-url";

// Config — from env vars

const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 30000; // 30 seconds
const MAX_POLL_ATTEMPTS = 20; // 10 minutes max

export interface QBCustomer {
  ListID: string;
  Name: string;
  FirstName?: string;
  LastName?: string;
  CompanyName: string;
  Email: string;
  Phone?: string;
  CustomerType: string;
  PriceLevel: string;
}

export interface MedusaCustomerSummary {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  qb_list_id: string;
}

export interface CheckCustomersResult {
  success: boolean;
  stats: {
    totalInQb: number;
    totalInMedusa: number;
    onlyInQb: number;
    onlyInMedusa: number;
    inBoth: number;
  };
  customersOnlyInQb: QBCustomer[];
  customersOnlyInMedusa: MedusaCustomerSummary[];
  error?: string;
}

/**
 * Core logic for checking customer differences between QB and Medusa
 * Compares and generates lists of customers only in QB, only in Medusa, and in both
 */
export async function checkCustomersCore(
  container: any
): Promise<CheckCustomersResult> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerModule: ICustomerModuleService = container.resolve(
    Modules.CUSTOMER
  );

  const stats = {
    totalInQb: 0,
    totalInMedusa: 0,
    onlyInQb: 0,
    onlyInMedusa: 0,
    inBoth: 0,
  };

  try {
    logger.info(`👥 Starting QuickBooks Customer Check...`);

    // 1. Fetch QB Customers via Bridge
    logger.info("📡 Requesting Customer Data from Bridge...");
    const initRes = await fetch(`${requireBridgeUrl()}/api/customers`, {
      headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
    });

    if (!initRes.ok) {
      const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`;
      logger.error(`❌ ${error}`);
      return {
        success: false,
        stats,
        customersOnlyInQb: [],
        customersOnlyInMedusa: [],
        error,
      };
    }

    const initJson: any = await initRes.json();
    const operationId = initJson.operationId;
    logger.info(`✅ Operation Queued! ID: ${operationId}`);

    // 2. Poll for Results
    let qbCustomers: QBCustomer[] = [];
    let attempts = 0;

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      logger.info(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`);

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const polled = await pollBridgeStatus(operationId);
      if (polled.status === "expired") {
        const error = `QB check op ${operationId} expired (bridge returned 404)`;
        logger.warn(`   ${error}`);
        return {
          success: false,
          stats,
          error,
          customersOnlyInQb: [],
          customersOnlyInMedusa: [],
        };
      }
      const statusJson: any = polled.data;

      if (statusJson.success && statusJson.operation) {
        if (statusJson.operation.status === "completed") {
          qbCustomers = statusJson.data || [];
          logger.info(
            `✅ Data Received! ${qbCustomers.length} customers from QuickBooks.`
          );
          break;
        }

        if (statusJson.operation.status === "failed") {
          const error = `QB sync failed: ${statusJson.operation.error || "Unknown"}`;
          logger.error(`❌ ${error}`);
          return {
            success: false,
            stats,
            customersOnlyInQb: [],
            customersOnlyInMedusa: [],
            error,
          };
        }
      }
    }

    if (qbCustomers.length === 0) {
      const error = "No customer data received from QB";
      logger.error(`❌ ${error}`);
      return {
        success: false,
        stats,
        customersOnlyInQb: [],
        customersOnlyInMedusa: [],
        error,
      };
    }

    stats.totalInQb = qbCustomers.length;

    // 3. Fetch Medusa Customers with QB ID
    logger.info("🔍 Fetching Medusa Customers...");
    const [medusaCustomers] = await customerModule.listAndCountCustomers(
      {},
      {
        take: 10000,
        select: ["id", "email", "first_name", "last_name", "metadata"],
      }
    );

    const medusaWithQbId = medusaCustomers
      .filter((c: any) => c.metadata?.qb_list_id)
      .map((c: any) => ({
        id: c.id,
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        qb_list_id: c.metadata.qb_list_id,
      }));

    stats.totalInMedusa = medusaWithQbId.length;
    logger.info(
      `📊 Found ${medusaWithQbId.length} Medusa customers with QB IDs`
    );

    // 4. Compare
    const qbMap = new Map(qbCustomers.map((c) => [c.ListID, c]));
    const medusaMap = new Map(medusaWithQbId.map((c) => [c.qb_list_id, c]));

    const customersOnlyInQb: QBCustomer[] = [];
    const customersOnlyInMedusa: MedusaCustomerSummary[] = [];

    // Find customers only in QB
    for (const qb of qbCustomers) {
      if (!medusaMap.has(qb.ListID)) {
        customersOnlyInQb.push(qb);
      }
    }

    // Find customers only in Medusa
    for (const medusa of medusaWithQbId) {
      if (!qbMap.has(medusa.qb_list_id)) {
        customersOnlyInMedusa.push(medusa);
      }
    }

    stats.onlyInQb = customersOnlyInQb.length;
    stats.onlyInMedusa = customersOnlyInMedusa.length;
    stats.inBoth = stats.totalInQb - stats.onlyInQb;

    logger.info(`\n${"=".repeat(50)}`);
    logger.info("✅ CUSTOMER CHECK SUMMARY");
    logger.info(`${"=".repeat(50)}`);
    logger.info(`Total in QB:           ${stats.totalInQb}`);
    logger.info(`Total in Medusa:       ${stats.totalInMedusa}`);
    logger.info(`Only in QB:            ${stats.onlyInQb}`);
    logger.info(`Only in Medusa:        ${stats.onlyInMedusa}`);
    logger.info(`In Both:               ${stats.inBoth}`);
    logger.info(`${"=".repeat(50)}\n`);

    // 5. Save to Database
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    await client.query(
      `
            INSERT INTO quickbooks_customer_audit (
                id, total_in_qb, total_in_medusa, only_in_qb, only_in_medusa, in_both,
                customers_only_in_qb, customers_only_in_medusa, last_check_at
            ) VALUES (
                'latest', $1, $2, $3, $4, $5, $6, $7, NOW()
            )
            ON CONFLICT (id) DO UPDATE SET
                total_in_qb = $1,
                total_in_medusa = $2,
                only_in_qb = $3,
                only_in_medusa = $4,
                in_both = $5,
                customers_only_in_qb = $6,
                customers_only_in_medusa = $7,
                last_check_at = NOW()
        `,
      [
        stats.totalInQb,
        stats.totalInMedusa,
        stats.onlyInQb,
        stats.onlyInMedusa,
        stats.inBoth,
        JSON.stringify(customersOnlyInQb),
        JSON.stringify(customersOnlyInMedusa),
      ]
    );

    await client.end();
    logger.info("💾 Audit results saved to database");

    return {
      success: true,
      stats,
      customersOnlyInQb,
      customersOnlyInMedusa,
    };
  } catch (error: any) {
    logger.error(`❌ Check failed: ${error.message}`);
    return {
      success: false,
      stats,
      customersOnlyInQb: [],
      customersOnlyInMedusa: [],
      error: error.message,
    };
  }
}
