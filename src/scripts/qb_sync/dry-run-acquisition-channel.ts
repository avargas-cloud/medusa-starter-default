/**
 * src/scripts/qb_sync/dry-run-acquisition-channel.ts
 *
 * DRY-RUN: jala todos los customers de QB, extrae el DataExt
 * "Distribution Channel" (custom field), cruza con Medusa por qb_list_id,
 * y reporta cuántos customers quedarían con acquisition_channel poblado
 * si corriéramos el import real.
 *
 * Policy: solo se "actualizarían" customers con metadata.acquisition_channel
 * vacío/null/undefined. Los que ya tienen valor NO se tocan.
 *
 * Valores válidos se validan contra system_defaults (context='Customer Defaults',
 * field_name='Acquisition Channel'). Si QB trae un valor no listado, se reporta
 * como "unknown" y se skipea.
 *
 * NO ESCRIBE NADA. Solo reporta.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/qb_sync/dry-run-acquisition-channel.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 180; // 15 min

const DISTRIBUTION_CHANNEL_FIELD = "Distribution Channel";

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

export default async function dryRun({
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
  logger.info(
    `📋 Valid acquisition_channel values (${validValues.size}): ${[...validValues].join(", ")}`
  );

  // 2. Fetch all QB customers
  logger.info("📡 Requesting all QB customers via bridge...");
  const initRes = await fetch(
    `${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`,
    {
      headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
    }
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
    throw new Error(`No operationId in bridge response: ${JSON.stringify(initJson)}`);
  }
  logger.info(`✅ Operation queued: ${operationId}`);

  // 3. Poll for results
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
      const raw =
        op.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet;
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

  // 4. Index QB customers by ListID + count DataExt presence
  const qbById = new Map<string, { name: string; channel: string | null }>();
  let qbWithChannel = 0;
  const qbValueCounts = new Map<string, number>();
  const qbUnknownValues = new Map<string, number>();
  for (const c of qbCustomers) {
    if (!c.ListID) continue;
    const channel = extractDistributionChannel(c);
    qbById.set(c.ListID, { name: c.Name || "", channel });
    if (channel) {
      qbWithChannel++;
      if (validValues.has(channel)) {
        qbValueCounts.set(channel, (qbValueCounts.get(channel) || 0) + 1);
      } else {
        qbUnknownValues.set(channel, (qbUnknownValues.get(channel) || 0) + 1);
      }
    }
  }

  logger.info(
    `📊 QB: ${qbWithChannel}/${qbCustomers.length} customers have Distribution Channel set`
  );

  // 5. Fetch Medusa customers with qb_list_id
  logger.info("🔍 Fetching Medusa customers with qb_list_id...");
  const [medusaCustomers] = await customerModule.listAndCountCustomers(
    {},
    { take: null as any, select: ["id", "email", "metadata"] }
  );
  const medusaByQbId = new Map<
    string,
    { id: string; email: string | null; currentValue: string | null }
  >();
  for (const m of medusaCustomers) {
    const qbListId = (m.metadata as any)?.qb_list_id as string | undefined;
    if (!qbListId) continue;
    const current = ((m.metadata as any)?.acquisition_channel ?? "") as string;
    medusaByQbId.set(qbListId, {
      id: m.id,
      email: m.email,
      currentValue: current.trim() || null,
    });
  }
  logger.info(
    `📊 Medusa: ${medusaByQbId.size} customers have qb_list_id set`
  );

  // 6. Cross-reference and categorize
  let wouldUpdate = 0;
  let skipAlreadyHasValue = 0;
  let skipNotInMedusa = 0;
  let skipNoChannelInQb = 0;
  let skipUnknownValue = 0;
  const wouldUpdateByValue = new Map<string, number>();

  for (const [listId, qb] of qbById) {
    const medusa = medusaByQbId.get(listId);
    if (!qb.channel) {
      skipNoChannelInQb++;
      continue;
    }
    if (!medusa) {
      skipNotInMedusa++;
      continue;
    }
    if (medusa.currentValue) {
      skipAlreadyHasValue++;
      continue;
    }
    if (!validValues.has(qb.channel)) {
      skipUnknownValue++;
      continue;
    }
    wouldUpdate++;
    wouldUpdateByValue.set(
      qb.channel,
      (wouldUpdateByValue.get(qb.channel) || 0) + 1
    );
  }

  // 7. Report
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("   DRY-RUN REPORT: Acquisition Channel Import");
  console.log("═══════════════════════════════════════════════════════\n");

  console.log("📦 QB Distribution Channel distribution:");
  const sortedQbValues = [...qbValueCounts.entries()].sort(
    (a, b) => b[1] - a[1]
  );
  for (const [v, n] of sortedQbValues) console.log(`   ${v.padEnd(22)} ${n}`);

  if (qbUnknownValues.size > 0) {
    console.log("\n⚠️  QB values NOT in system_defaults (will be skipped):");
    for (const [v, n] of qbUnknownValues)
      console.log(`   ${v.padEnd(22)} ${n}`);
  }

  console.log("\n✅ Would UPDATE (would write to Medusa):");
  console.log(`   Total: ${wouldUpdate} customers`);
  const sortedUpdates = [...wouldUpdateByValue.entries()].sort(
    (a, b) => b[1] - a[1]
  );
  for (const [v, n] of sortedUpdates) console.log(`   ${v.padEnd(22)} ${n}`);

  console.log("\n⏭️  Would SKIP:");
  console.log(`   ${skipAlreadyHasValue.toString().padStart(6)} — Medusa already has acquisition_channel set`);
  console.log(`   ${skipNotInMedusa.toString().padStart(6)} — QB customer not linked in Medusa (no match by qb_list_id)`);
  console.log(`   ${skipNoChannelInQb.toString().padStart(6)} — QB customer has no Distribution Channel set`);
  console.log(`   ${skipUnknownValue.toString().padStart(6)} — QB value not in system_defaults`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log(`   Summary: ${wouldUpdate} customers would be updated`);
  console.log("═══════════════════════════════════════════════════════\n");
}
