/**
 * One-shot diagnostic: find FERNANDO RODRIGUEZ in QB Desktop and report the
 * current ListID. Compares against the qb_list_id stored in Medusa metadata
 * to detect drift (customer deleted / merged / renamed in QB).
 *
 * Usage: yarn medusa exec src/scripts/fix/find-fernando-in-qb.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { bridgeFetch } from "../../lib/quickbooks/bridge-fetch";

const TARGET_EMAIL = "rffurniture081118@gmail.com";
const TARGET_NAME = "FERNANDO RODRIGUEZ";

async function runDirectQuery(qbxml: string): Promise<unknown> {
  const enq = await bridgeFetch<{
    operationId?: string;
    operation_id?: string;
  }>("/api/sync/direct-query", { method: "POST", body: { qbxml } });
  const opId = enq?.operationId || enq?.operation_id;
  if (!opId) throw new Error("no operationId");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await bridgeFetch<{
      operation?: { status?: string; result?: unknown; error?: string };
    }>(`/api/sync/status/${opId}`);
    const op = st?.operation;
    if (!op) continue;
    if (op.status === "completed") return op.result;
    if (op.status === "failed")
      throw new Error(op.error || "bridge query failed");
  }
  throw new Error("timeout");
}

function unwrap(result: unknown, rsKey: string, retKey: string): any[] {
  const msgs =
    ((result as any)?.QBXML?.QBXMLMsgsRs as Record<string, unknown>) ??
    ((result as any)?.QBXMLMsgsRs as Record<string, unknown>) ??
    result;
  const ret = (msgs as any)?.[rsKey]?.[retKey] ?? null;
  if (!ret) return [];
  return Array.isArray(ret) ? ret : [ret];
}

export default async function findFernando({ container }: ExecArgs) {
  const knex = (container as any).resolve("__pg_connection__");
  const logger = container.resolve("logger") as any;

  // 1. Current Medusa state
  const { rows } = await knex.raw(
    `SELECT id, email, first_name, last_name,
            metadata->>'qb_list_id' AS qb_list_id
       FROM customer
      WHERE email = ?`,
    [TARGET_EMAIL]
  );
  if (rows.length === 0) {
    logger.error(`No customer with email ${TARGET_EMAIL}`);
    return;
  }
  const c = rows[0];
  logger.info(
    `\nMedusa: ${c.first_name} ${c.last_name} <${c.email}> qb_list_id=${c.qb_list_id}`
  );

  // 2. Query QB by FullName
  logger.info(`\nQuerying QB by FullName="${TARGET_NAME}"...`);
  const qbxmlByName = `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><CustomerQueryRq requestID="1"><FullName>${TARGET_NAME}</FullName><IncludeRetElement>ListID</IncludeRetElement><IncludeRetElement>Name</IncludeRetElement><IncludeRetElement>FullName</IncludeRetElement><IncludeRetElement>Email</IncludeRetElement><IncludeRetElement>EditSequence</IncludeRetElement><IncludeRetElement>IsActive</IncludeRetElement></CustomerQueryRq></QBXMLMsgsRq></QBXML>`;
  let nameHits: any[] = [];
  try {
    const result = await runDirectQuery(qbxmlByName);
    nameHits = unwrap(result, "CustomerQueryRs", "CustomerRet");
  } catch (err: any) {
    logger.warn(`  FullName query failed: ${err.message}`);
  }
  logger.info(`  → ${nameHits.length} hits by FullName`);
  for (const h of nameHits) {
    logger.info(
      `    ListID=${h.ListID} Name=${h.Name} Email=${h.Email ?? "—"} Active=${h.IsActive ?? "?"}`
    );
  }

  // 3. Query QB scanning by email (less efficient — uses NameRangeFilter or full scan)
  // Use email filter directly via DataExt or just MaxReturned trick
  logger.info(`\nQuerying QB by Email contains "${TARGET_EMAIL}"...`);
  const qbxmlByEmail = `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?><QBXML><QBXMLMsgsRq onError="stopOnError"><CustomerQueryRq requestID="2"><MaxReturned>500</MaxReturned><NameFilter><MatchCriterion>Contains</MatchCriterion><Name>RODRIGUEZ</Name></NameFilter><IncludeRetElement>ListID</IncludeRetElement><IncludeRetElement>Name</IncludeRetElement><IncludeRetElement>FullName</IncludeRetElement><IncludeRetElement>Email</IncludeRetElement><IncludeRetElement>IsActive</IncludeRetElement></CustomerQueryRq></QBXMLMsgsRq></QBXML>`;
  let emailHits: any[] = [];
  try {
    const result = await runDirectQuery(qbxmlByEmail);
    const allMatching = unwrap(result, "CustomerQueryRs", "CustomerRet");
    emailHits = allMatching.filter(
      (h) =>
        typeof h.Email === "string" &&
        h.Email.toLowerCase().includes(TARGET_EMAIL)
    );
  } catch (err: any) {
    logger.warn(`  Email filter query failed: ${err.message}`);
  }
  logger.info(`  → ${emailHits.length} hits with this email`);
  for (const h of emailHits) {
    logger.info(
      `    ListID=${h.ListID} FullName=${h.FullName} Email=${h.Email} Active=${h.IsActive ?? "?"}`
    );
  }

  logger.info(`\nDone.`);
}
