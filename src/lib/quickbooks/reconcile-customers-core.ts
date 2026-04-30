import { ICustomerModuleService } from "@medusajs/framework/types";
import { pollBridgeStatus } from "./bridge-fetch";
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils";

import { isQbIntegrationEnabled } from "./qb-integration-guard";
// using native fetch

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const INITIAL_WAIT_MS = 2 * 60 * 1000; // wait 2 min before first poll
const MAX_POLL_ATTEMPTS = 8; // up to 16 min total

export interface ReconcileIssue {
  medusa_id: string;
  email: string;
  name: string;
  issue: "wrong_id" | "missing_id" | "unmatched";
  old_qb_id?: string;
  new_qb_id?: string;
  match_method: "id" | "email" | "name" | "company" | "none";
}

export interface ReconcileResult {
  success: boolean;
  stats: {
    total: number;
    correct: number;
    wrong_id: number;
    missing_id: number;
    unmatched: number;
  };
  issues: ReconcileIssue[];
  error?: string;
}

export async function reconcileCustomersCore(
  container: any,
  options: { onLog?: (line: string) => void; dryRun?: boolean } = {}
): Promise<ReconcileResult> {
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

  const isDryRun = options.dryRun ?? false;

  const stats = {
    total: 0,
    correct: 0,
    wrong_id: 0,
    missing_id: 0,
    unmatched: 0,
  };
  const issues: ReconcileIssue[] = [];

  try {
    if (!(await isQbIntegrationEnabled())) {
      log("[QB] Integration is DISABLED. Skipping customer reconciliation.");
      return { success: false, stats, issues, error: "Integration Disabled" };
    }

    if (isDryRun) {
      log("=========================================");
      log("🔍 DRY RUN MODE: No DB changes will occur");
      log("=========================================\n");
    }
    log(
      `⏰ Reconcile initiated: ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" })}`
    );

    // 1. Fetch QB Customers
    log("📡 Requesting Customer Data from Bridge for Reconciliation...");
    const initRes = await fetch(
      `${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`,
      {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
      }
    );

    if (!initRes.ok) {
      const error = `Bridge Error: ${initRes.status} ${initRes.statusText}`;
      warn(`❌ ${error}`);
      return { success: false, stats, issues, error };
    }

    const initJson: any = await initRes.json();
    const operationId = initJson.operationId;
    log(`✅ Operation Queued! ID: ${operationId}`);

    // 2. Poll for Results
    let qbCustomers: any[] = [];
    let attempts = 0;

    log(`⏳ Waiting 2 minutes before first poll (large dataset)...`);
    await new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));

    while (attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      log(`⏳ Polling Status (${attempts}/${MAX_POLL_ATTEMPTS})...`);

      const polled = await pollBridgeStatus(operationId);
      if (polled.status === "expired") {
        const error = `QB reconcile op ${operationId} expired (bridge returned 404)`;
        warn(`   ${error}`);
        return { success: false, stats, error, issues: [] };
      }
      const statusJson: any = polled.data;

      if (statusJson.success && statusJson.operation) {
        if (statusJson.operation.status === "completed") {
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
          warn(`❌ ${error}`);
          return { success: false, stats, issues, error };
        }
        log(`   Status: ${statusJson.operation.status} — waiting...`);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    if (qbCustomers.length === 0) {
      const error = "No customer data received from QB";
      warn(`❌ ${error}`);
      return { success: false, stats, issues, error };
    }

    // 3. Build QB Maps for matching
    log("🗺️ Building QuickBooks Customer Index maps...");
    const qbByEmail = new Map<string, any>();
    const qbByName = new Map<string, any>();
    const qbByCompany = new Map<string, any>();
    const qbById = new Map<string, any>();

    for (const qb of qbCustomers) {
      if (qb.ListID) {
        qbById.set(qb.ListID, qb);
      }
      if (qb.Email?.trim() && qb.Email.includes("@")) {
        qbByEmail.set(qb.Email.toLowerCase().trim(), qb);
      }
      if (qb.Name) {
        // Normalize names: lowercase, remove extra spaces
        const normalName = qb.Name.toLowerCase().replace(/\s+/g, " ").trim();
        qbByName.set(normalName, qb);
      }
      if (qb.CompanyName) {
        const normalCompany = qb.CompanyName.toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        qbByCompany.set(normalCompany, qb);
      }
    }

    // 4. Fetch Existing Medusa Customers
    log("🔍 Fetching existing Medusa customers...");
    const [medusaCustomers] = await customerModule.listAndCountCustomers(
      {},
      {
        take: 100000,
        select: [
          "id",
          "email",
          "first_name",
          "last_name",
          "company_name",
          "metadata",
        ],
      }
    );

    stats.total = medusaCustomers.length;
    log(
      `📊 Found ${medusaCustomers.length} customers in Medusa database to review.`
    );

    // 5. Reconcile
    log(`\n🔄 Starting Reconciliation Process...`);

    const updates: { id: string; qb_id: string }[] = [];

    for (const customer of medusaCustomers) {
      const medusaFullName =
        `${customer.first_name || ""} ${customer.last_name || ""}`
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      const isPlaceholderEmail = !!customer.metadata?.email_is_placeholder;
      const currentQbId = customer.metadata?.qb_list_id as string | undefined;
      const actualEmail = customer.email?.toLowerCase().trim();

      let match: any = null;
      let matchType: "id" | "email" | "name" | "company" | "none" = "none";

      // Logic 0: ID Match
      if (currentQbId && qbById.has(currentQbId)) {
        match = qbById.get(currentQbId);
        matchType = "id";
      }
      // Logic 1: Exact Email Match (if not dummy)
      else if (
        actualEmail &&
        !isPlaceholderEmail &&
        qbByEmail.has(actualEmail)
      ) {
        match = qbByEmail.get(actualEmail);
        matchType = "email";
      }
      // Logic 2: Name match
      else if (medusaFullName && qbByName.has(medusaFullName)) {
        match = qbByName.get(medusaFullName);
        matchType = "name";
      }
      // Logic 3: Company Match
      else if (
        customer.company_name &&
        qbByCompany.has(
          customer.company_name.toLowerCase().replace(/\s+/g, " ").trim()
        )
      ) {
        match = qbByCompany.get(
          customer.company_name.toLowerCase().replace(/\s+/g, " ").trim()
        );
        matchType = "company";
      }

      // Analyze Match Result
      const nameDisplay =
        `${customer.first_name || ""} ${customer.last_name || ""}`.trim() ||
        customer.company_name ||
        "Unknown";

      if (match) {
        const foundQbId = match.ListID;
        if (currentQbId === foundQbId) {
          stats.correct++;
        } else if (currentQbId) {
          // ID Exists but is wrong
          stats.wrong_id++;
          issues.push({
            medusa_id: customer.id,
            email: customer.email || "",
            name: nameDisplay,
            issue: "wrong_id",
            old_qb_id: currentQbId,
            new_qb_id: foundQbId,
            match_method: matchType,
          });
          updates.push({ id: customer.id, qb_id: foundQbId });
        } else {
          // Missing ID entirely
          stats.missing_id++;
          issues.push({
            medusa_id: customer.id,
            email: customer.email || "",
            name: nameDisplay,
            issue: "missing_id",
            new_qb_id: foundQbId,
            match_method: matchType,
          });
          updates.push({ id: customer.id, qb_id: foundQbId });
        }
      } else {
        stats.unmatched++;
        if (currentQbId) {
          // Has an ID, but that ID / Email / Name doesn't exist in QB
          issues.push({
            medusa_id: customer.id,
            email: customer.email || "",
            name: nameDisplay,
            issue: "unmatched",
            old_qb_id: currentQbId,
            match_method: "none",
          });
        }
      }
    }

    // Output short summary log
    log(`\n==================================================`);
    log(`RECONCILIATION SUMMARY ${isDryRun ? "(DRY RUN)" : ""}`);
    log(`==================================================`);
    log(`Medusa Customers: ${stats.total}`);
    log(`✅ Correct IDs:   ${stats.correct}`);
    log(
      `⚠️ Wrong IDs:     ${stats.wrong_id} ${isDryRun ? "(would fix)" : "(fixed)"}`
    );
    log(
      `⚠️ Missing IDs:   ${stats.missing_id} ${isDryRun ? "(would assign)" : "(assigned)"}`
    );
    log(`❌ Unmatched:     ${stats.unmatched} (no QB equivalent found)`);
    log(`==================================================\n`);

    // Execute Updates (if live)
    if (!isDryRun && updates.length > 0) {
      log(`💾 Applying ${updates.length} fixes to the Medusa database...`);
      for (const fix of updates) {
        try {
          // listAndCountCustomers returns [Customer[], count]
          const [customers] = await customerModule.listAndCountCustomers(
            { id: [fix.id] },
            { select: ["id", "metadata"], take: 1 }
          );
          const existingMeta = (customers[0]?.metadata || {}) as Record<
            string,
            unknown
          >;

          await customerModule.updateCustomers(fix.id, {
            metadata: {
              ...existingMeta,
              qb_list_id: fix.qb_id,
            },
          });
        } catch (e: any) {
          warn(`❌ Failed to update ID for medusa_id ${fix.id}: ${e.message}`);
        }
      }
      log(`✅ All database updates finished.`);
    } else if (isDryRun && updates.length > 0) {
      log(`✨ Dry Run summary: would update ${updates.length} records.`);
      // Print top 10 as examples
      if (issues.length > 0) {
        log(`\n📋 Fix Examples (first 10):`);
        const examples = issues
          .filter((i) => i.issue !== "unmatched")
          .slice(0, 10);
        for (const ex of examples) {
          log(
            `   - ${ex.name} (${ex.email}) [via ${ex.match_method}] -> ID: ${ex.new_qb_id}`
          );
        }
      }
    }

    return { success: true, stats, issues };
  } catch (error: any) {
    warn(`❌ Reconciliation failed: ${error.message}`);
    return { success: false, stats, issues, error: error.message };
  }
}
