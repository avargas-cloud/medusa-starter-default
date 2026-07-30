import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { ICustomerModuleService } from "@medusajs/types";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

/**
 * Fix Missing Company Names from QuickBooks
 *
 * The initial QB customer import (Jan 27, 2026) ran an older version of
 * sync-customers-core.ts that did not persist company_name. This script
 * corrects all 7,437 affected customers by:
 *
 *   1. Fetching the full customer list from QB (via the bridge — same approach
 *      as sync-customers-core.ts).
 *   2. Building a Map:  qb_list_id → companyName
 *   3. Querying Medusa for every customer that has qb_list_id but no
 *      company_name.
 *   4. Batch-updating those customers with the value from QB.
 *
 * MODES
 *   DRY_RUN=true  (default) — logs what would change, touches nothing.
 *   DRY_RUN=false           — applies updates.
 *
 * USAGE
 *   DRY_RUN=true  yarn medusa exec ./src/scripts/migrations/fix-missing-company-names.ts
 *   DRY_RUN=false yarn medusa exec ./src/scripts/migrations/fix-missing-company-names.ts
 */

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 min between polls
const INITIAL_WAIT_MS = 2 * 60 * 1000; // wait before first poll (QB needs time)
const MAX_POLL_ATTEMPTS = 8; // up to ~16 min total
const UPDATE_BATCH_SIZE = 200; // customers per Medusa batch update (loaded in RAM)

export default async function fixMissingCompanyNames({ container }: ExecArgs) {
  const isDryRun = process.env.DRY_RUN !== "false";
  const customerModule = container.resolve(
    Modules.CUSTOMER
  ) as ICustomerModuleService;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);

  const log = (msg: string) => logger.info(msg);
  const warn = (msg: string) => logger.warn(msg);

  log("=".repeat(65));
  log(
    isDryRun
      ? "📋  DRY RUN — no changes will be written"
      : "⚡  LIVE MODE — updates will be applied"
  );
  log("=".repeat(65));

  // ── Step 1: Pull all customers from QB ───────────────────────────────────
  log("\n📡  Requesting full customer list from QuickBooks Bridge...");

  const initRes = await fetch(
    `${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`,
    { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
  );

  if (!initRes.ok) {
    throw new Error(`Bridge error: ${initRes.status} ${initRes.statusText}`);
  }

  const { operationId } = (await initRes.json()) as { operationId: string };
  log(`   Operation queued — ID: ${operationId}`);
  log(
    `⏳  Waiting ${INITIAL_WAIT_MS / 60000} min before first poll (large dataset)...`
  );
  await sleep(INITIAL_WAIT_MS);

  // ── Step 2: Poll until QB finishes ───────────────────────────────────────
  let qbCustomers: QBCustomer[] = [];

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    log(`⏳  Polling (${attempt}/${MAX_POLL_ATTEMPTS})...`);

    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );

    if (!statusRes.ok) {
      warn(`   Bridge status error: ${statusRes.status} — retrying...`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const statusJson = (await statusRes.json()) as StatusResponse;

    if (statusJson.success && statusJson.operation?.status === "completed") {
      const raw =
        statusJson.operation.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs
          ?.CustomerRet;
      qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw];
      log(`✅  QB returned ${qbCustomers.length} customers.`);
      break;
    }

    if (statusJson.operation?.status === "failed") {
      throw new Error(
        `QB sync failed: ${statusJson.operation.error || "unknown"}`
      );
    }

    log(`   Status: ${statusJson.operation?.status ?? "pending"} — waiting...`);
    await sleep(POLL_INTERVAL_MS);
  }

  if (qbCustomers.length === 0) {
    throw new Error("No customer data received from QuickBooks after polling.");
  }

  // ── Step 3: Build qb_list_id → companyName map ───────────────────────────
  const companyNameMap = new Map<string, string>();

  for (const qb of qbCustomers) {
    const company =
      typeof qb.CompanyName === "string" ? qb.CompanyName.trim() : "";
    if (qb.ListID && company) {
      companyNameMap.set(qb.ListID, company);
    }
  }

  log(
    `\n📊  QB customers with CompanyName: ${companyNameMap.size} / ${qbCustomers.length}`
  );

  // ── Step 4: Load ALL Medusa customers into memory at once ────────────────
  log(`\n🔍  Loading all Medusa customers into memory...`);

  const [allCustomers] = await customerModule.listAndCountCustomers(
    {},
    { take: 20000, select: ["id", "company_name", "metadata"] }
  );

  log(`   Loaded ${allCustomers.length} customers from Medusa.`);

  const toUpdate: { id: string; qbListId: string }[] = [];

  for (const c of allCustomers) {
    const meta = c.metadata as Record<string, unknown> | null;
    const qbListId =
      typeof meta?.qb_list_id === "string" ? meta.qb_list_id : null;

    if (qbListId && !c.company_name && companyNameMap.has(qbListId)) {
      toUpdate.push({ id: c.id, qbListId });
    }
  }

  log(`   Customers that need company_name: ${toUpdate.length}`);

  if (toUpdate.length === 0) {
    log("\n✅  Nothing to fix — all QB customers already have company_name.");
    return;
  }

  // Preview in dry-run mode
  if (isDryRun) {
    log("\n📋  Preview (first 20 that would be updated):");
    for (const item of toUpdate.slice(0, 20)) {
      const name = companyNameMap.get(item.qbListId) ?? "";
      log(`   ${item.qbListId}  →  "${name}"`);
    }
    if (toUpdate.length > 20) {
      log(`   ... and ${toUpdate.length - 20} more`);
    }
    log(`\n⚠️   DRY RUN complete. Run with DRY_RUN=false to apply changes.`);
    return;
  }

  // ── Step 5: Apply batch updates ──────────────────────────────────────────
  log(
    `\n🔄  Updating ${toUpdate.length} customers in batches of ${UPDATE_BATCH_SIZE}...`
  );

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < toUpdate.length; i += UPDATE_BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + UPDATE_BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ id, qbListId }) => {
        try {
          const companyName = companyNameMap.get(qbListId)!;
          await customerModule.updateCustomers(id, {
            company_name: companyName,
          });
          updated++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`   ❌ Failed to update customer ${id}: ${msg}`);
          errors++;
        }
      })
    );

    log(
      `   ✅  Progress: ${Math.min(i + UPDATE_BATCH_SIZE, toUpdate.length)} / ${toUpdate.length}`
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  log("\n" + "=".repeat(65));
  log("✅  FIX COMPLETE");
  log("=".repeat(65));
  log(`   Customers updated:     ${updated}`);
  log(`   Errors:                ${errors}`);
  log(
    `   QB customers skipped (no CompanyName in QB): ${toUpdate.length - updated - errors}`
  );
  log("=".repeat(65));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface QBCustomer {
  ListID: string;
  Name: string;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
}

interface StatusResponse {
  success: boolean;
  operation?: {
    status: string;
    error?: string;
    result?: {
      QBXML?: {
        QBXMLMsgsRs?: {
          CustomerQueryRs?: {
            CustomerRet?: QBCustomer | QBCustomer[];
          };
        };
      };
    };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
