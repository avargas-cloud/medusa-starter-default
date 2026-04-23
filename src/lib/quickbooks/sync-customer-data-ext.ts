/**
 * src/lib/quickbooks/sync-customer-data-ext.ts
 *
 * Sincroniza un custom field (DataExt) de un customer desde Medusa hacia QB
 * a través del bridge. Por ahora se usa exclusivamente para
 * "Distribution Channel" ↔ customer.metadata.acquisition_channel.
 *
 * Pattern: DataExtAdd primero. Si QB responde que el campo ya existe,
 * reintentamos con DataExtMod. Idempotente.
 */

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 60; // 2 min

export interface CustomerDataExtResult {
  success: boolean;
  action: "add" | "mod" | null;
  error?: string;
}

async function enqueueDataExt(
  action: "add" | "mod",
  listId: string,
  dataExtName: string,
  dataExtValue: string
): Promise<string> {
  const res = await fetch(`${BRIDGE_URL}/api/sync/enqueue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({
      type: "data-ext",
      action,
      data: {
        OwnerID: "0",
        DataExtName: dataExtName,
        ListDataExtType: "Customer",
        ListObjRef: { ListID: listId },
        DataExtValue: dataExtValue,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Bridge enqueue failed: ${res.status} ${res.statusText}`
    );
  }
  const json = (await res.json()) as {
    operation_id?: string;
    operationId?: string;
  };
  const id = json.operation_id || json.operationId;
  if (!id) throw new Error(`Bridge returned no operation id: ${JSON.stringify(json)}`);
  return id;
}

interface PollResult {
  status: "completed" | "failed";
  error?: string;
  statusCode?: string;
}

async function pollOperation(operationId: string): Promise<PollResult> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const res = await fetch(
      `${BRIDGE_URL}/api/sync/status/${operationId}`,
      { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
    );
    if (!res.ok) continue;
    const json = (await res.json()) as any;
    const op = json?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      // Inspect QBXML response — DataExtAddRs may have statusCode != 0 for "already exists"
      const msgs = op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs || {};
      const rs = msgs?.DataExtAddRs || msgs?.DataExtModRs;
      const code = rs?.statusCode ?? rs?.["$"]?.statusCode;
      const msg = rs?.statusMessage ?? rs?.["$"]?.statusMessage;
      if (code && String(code) !== "0") {
        return { status: "failed", error: msg || `QB status ${code}`, statusCode: String(code) };
      }
      return { status: "completed" };
    }
    if (op.status === "failed") {
      // op.error may be "QB status 3200: ..." — capture for fallback logic
      const msg = typeof op.error === "string" ? op.error : "Unknown QB error";
      const codeMatch = msg.match(/\b(3\d{3})\b/);
      return {
        status: "failed",
        error: msg,
        statusCode: codeMatch ? codeMatch[1] : undefined,
      };
    }
  }
  return { status: "failed", error: "Timeout waiting for bridge operation" };
}

// Códigos QB que indican "ya existe" (Add) o "no existe" (Mod).
// 3100: record does not exist. 3200: record already exists (DataExt duplicate).
function isAlreadyExistsError(code?: string, msg?: string): boolean {
  if (code === "3200") return true;
  if (msg && /already exists|already been added|duplicate/i.test(msg)) return true;
  return false;
}

function isDoesNotExistError(code?: string, msg?: string): boolean {
  if (code === "3100" || code === "3120") return true;
  if (msg && /does not exist|not exist|cannot be found/i.test(msg)) return true;
  return false;
}

export async function syncCustomerDataExtToQb(params: {
  qbListId: string;
  dataExtName: string;
  dataExtValue: string;
  logger?: { info: (m: string) => void; warn: (m: string) => void };
}): Promise<CustomerDataExtResult> {
  const { qbListId, dataExtName, dataExtValue, logger } = params;
  const log = logger?.info ?? (() => {});
  const warn = logger?.warn ?? (() => {});

  // 1. Try Add first
  try {
    const opId = await enqueueDataExt("add", qbListId, dataExtName, dataExtValue);
    log(`[data-ext] Add enqueued op=${opId} for ${qbListId} (${dataExtName}="${dataExtValue}")`);
    const result = await pollOperation(opId);
    if (result.status === "completed") {
      return { success: true, action: "add" };
    }
    if (isAlreadyExistsError(result.statusCode, result.error)) {
      log(`[data-ext] Add reported "already exists" → falling back to Mod`);
      // continue to Mod below
    } else {
      return { success: false, action: "add", error: result.error };
    }
  } catch (err: any) {
    warn(`[data-ext] Add exception: ${err.message}`);
    // fall through to Mod
  }

  // 2. Fallback: Mod
  try {
    const opId = await enqueueDataExt("mod", qbListId, dataExtName, dataExtValue);
    log(`[data-ext] Mod enqueued op=${opId} for ${qbListId}`);
    const result = await pollOperation(opId);
    if (result.status === "completed") {
      return { success: true, action: "mod" };
    }
    return { success: false, action: "mod", error: result.error };
  } catch (err: any) {
    return { success: false, action: "mod", error: err.message };
  }
}

export { isAlreadyExistsError, isDoesNotExistError };
