/**
 * src/scripts/qb_sync/import-acquisition-channel.ts
 *
 * REAL IMPORT: jala todos los customers de QB, extrae el DataExt
 * "Distribution Channel" y escribe el valor a customer.metadata.acquisition_channel
 * en Medusa. Solo actualiza customers cuyo acquisition_channel está vacío.
 *
 * Legacy mapping (valores QB que ya no se usan → valor actual):
 *   "Walk In"       → "Sign"
 *   "International" → "Referred"
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/qb_sync/import-acquisition-channel.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 180;

const DISTRIBUTION_CHANNEL_FIELD = "Distribution Channel";

// Legacy QB values that no longer should be used — mapped to current values.
const LEGACY_VALUE_MAP: Record<string, string> = {
  "Walk In": "Sign",
  International: "Referred",
};

interface DataExtEntry {
  OwnerID?: string;
  DataExtName?: string;
  DataExtType?: string;
  DataExtValue?: string;
}

interface QbCustomer {
  ListID?: string;
  Name?: string;
  DataExtRet?: DataExtEntry | DataExtEntry[];
}

function extractDistributionChannel(c: QbCustomer): string | null {
  const raw = c.DataExtRet;
  if (!raw) return null;
  const list: DataExtEntry[] = Array.isArray(raw) ? raw : [raw];
  for (const d of list) {
    if (d.DataExtName === DISTRIBUTION_CHANNEL_FIELD) {
      const v = (d.DataExtValue || "").trim();
      return v || null;
    }
  }
  return null;
}

function normalizeChannelValue(raw: string): string {
  return LEGACY_VALUE_MAP[raw] ?? raw;
}

export default async function importChannels({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve("logger") as {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  const customerModule = container.resolve(Modules.CUSTOMER);
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };

  // 1. Valid values from system_defaults
  const defaultsRes = await pg.raw(
    `SELECT value FROM system_defaults
     WHERE context = 'Customer Defaults'
       AND field_name = 'Acquisition Channel'
     ORDER BY sort_order ASC;`
  );
  const validValues = new Set(
    (defaultsRes.rows as Array<{ value: string }>).map((r) => r.value)
  );
  if (validValues.size === 0) {
    throw new Error(
      "No valid values in system_defaults. Run seed-acquisition-channel-defaults first."
    );
  }
  logger.info(`📋 ${validValues.size} valid channel values from system_defaults`);

  // 2. Fetch QB customers
  logger.info("📡 Requesting all QB customers via bridge...");
  const initRes = await fetch(
    `${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`,
    { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
  );
  if (!initRes.ok) {
    throw new Error(`Bridge error: ${initRes.status} ${initRes.statusText}`);
  }
  const initJson = (await initRes.json()) as {
    operationId?: string;
    operation_id?: string;
  };
  const operationId = initJson.operationId || initJson.operation_id;
  if (!operationId) {
    throw new Error(`No operationId: ${JSON.stringify(initJson)}`);
  }
  logger.info(`✅ Operation queued: ${operationId}`);

  // 3. Poll
  let qbCustomers: QbCustomer[] = [];
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );
    if (!statusRes.ok) continue;
    const statusJson = (await statusRes.json()) as any;
    const op = statusJson?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const raw = op.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet;
      qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw];
      logger.info(`✅ Received ${qbCustomers.length} customers from QB.`);
      break;
    }
    if (op.status === "failed") {
      throw new Error(`QB query failed: ${op.error || "unknown"}`);
    }
    logger.info(`   Poll ${attempt}/${MAX_POLL_ATTEMPTS}: ${op.status}`);
  }
  if (qbCustomers.length === 0) {
    throw new Error("No customers returned from QB within timeout");
  }

  // 4. Build QB map
  const qbChannelByListId = new Map<string, string>();
  for (const c of qbCustomers) {
    if (!c.ListID) continue;
    const raw = extractDistributionChannel(c);
    if (!raw) continue;
    const normalized = normalizeChannelValue(raw);
    if (!validValues.has(normalized)) continue;
    qbChannelByListId.set(c.ListID, normalized);
  }
  logger.info(
    `📊 ${qbChannelByListId.size} QB customers have a valid (or mappable) channel.`
  );

  // 5. Fetch Medusa customers
  logger.info("🔍 Fetching Medusa customers with qb_list_id...");
  const [medusaCustomers] = await customerModule.listAndCountCustomers(
    {},
    { take: null as any, select: ["id", "metadata"] }
  );

  // 6. Update empty acquisition_channel
  let updated = 0;
  let skipAlreadyHasValue = 0;
  let skipNoChannelForCustomer = 0;
  const counts = new Map<string, number>();
  let processed = 0;
  const total = medusaCustomers.length;

  for (const m of medusaCustomers) {
    processed++;
    if (processed % 500 === 0) {
      logger.info(`   ${processed}/${total} processed...`);
    }
    const qbListId = (m.metadata as any)?.qb_list_id as string | undefined;
    if (!qbListId) continue;
    const channel = qbChannelByListId.get(qbListId);
    if (!channel) {
      skipNoChannelForCustomer++;
      continue;
    }
    const current = (
      ((m.metadata as any)?.acquisition_channel ?? "") as string
    ).trim();
    if (current) {
      skipAlreadyHasValue++;
      continue;
    }
    const newMeta = { ...(m.metadata || {}), acquisition_channel: channel };
    await customerModule.updateCustomers(m.id, { metadata: newMeta });
    updated++;
    counts.set(channel, (counts.get(channel) || 0) + 1);
  }

  // 7. Report
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("   IMPORT COMPLETE: Acquisition Channel");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`   ✅ Updated: ${updated}`);
  console.log(`   ⏭️  Already had value (skip): ${skipAlreadyHasValue}`);
  console.log(`   ⏭️  No channel in QB (skip): ${skipNoChannelForCustomer}`);
  console.log("\n   Distribution of updated:");
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [v, n] of sorted) console.log(`     ${v.padEnd(22)} ${n}`);
  console.log("═══════════════════════════════════════════════════════\n");
}
