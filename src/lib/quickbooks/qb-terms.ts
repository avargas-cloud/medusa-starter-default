/**
 * QuickBooks Terms (payment terms) catalog reader.
 *
 * QB stores the authoritative "days until due" for every payment term in its
 * Terms list — `StandardTermsRet.StdDueDays` (Net-30 → 30, Consignment → 90,
 * "Due on receipt" → 0). A Vendor only carries the term's NAME
 * (`TermsRef.FullName`), so turning a vendor into a due-days number requires
 * this list. Parsing the name with a regex is NOT viable: the real company file
 * holds names like "Consignment", "Special", "30% Deposit, 70% upon delivery",
 * "1 Year" and "Receiver ACC".
 *
 * TWO GOTCHAS, both verified live against the company file (2026-07-23):
 *
 * 1. `ActiveStatus` MUST be `All`. QB defaults to ActiveOnly, which returns 15
 *    of the 31 terms and silently drops Net-10 (25 vendors), Consignment,
 *    "1 Year", "6 Month" — inactive terms are still assigned to live vendors.
 *
 * 2. The bridge's `raw` passthrough (`POST /api/sync/direct-query`) returns
 *    `operation.data.qbxml` VERBATIM — it does NOT add the
 *    `<?qbxml?><QBXML><QBXMLMsgsRq>` envelope that the typed builders add, so a
 *    bare `<TermsQueryRq/>` dies with QB HRESULT 0x80040400. We send the full
 *    envelope. (An earlier pass hit exactly this and wrongly concluded QB Terms
 *    were unreachable from the bridge.)
 *
 * `DateDrivenTermsRet` ("120" = due the 20th of the following month) has no day
 * count at all: we surface `day_of_month_due` and leave `days` null so callers
 * fall back to the system default instead of inventing a number.
 *
 * Read-only — this never writes to QuickBooks.
 */
import { bridgeFetch, pollBridgeStatus } from "./bridge-fetch";

export interface QbTermEntry {
  /** Term name exactly as QuickBooks spells it (e.g. "Net-30"). */
  name: string;
  /** Days from bill date until due. `null` for date-driven terms. */
  days: number | null;
  /** Day of month the bill is due — date-driven terms only. */
  day_of_month_due: number | null;
  is_active: boolean;
}

/** Keyed by `normalizeTermsKey(name)`. */
export type QbTermsMap = Record<string, QbTermEntry>;

/**
 * Full QBXML envelope (see gotcha #2 above). `ActiveStatus=All` is load-bearing
 * (gotcha #1) — do not "simplify" it away.
 */
export const QB_TERMS_QUERY_QBXML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<?qbxml version="10.0"?>' +
  "<QBXML><QBXMLMsgsRq onError=\"stopOnError\">" +
  "<TermsQueryRq><ActiveStatus>All</ActiveStatus></TermsQueryRq>" +
  "</QBXMLMsgsRq></QBXML>";

/**
 * Case/whitespace-insensitive key. Punctuation is deliberately PRESERVED —
 * "Net 30" and "Net-30" are two distinct terms in the company file (both live,
 * both 30 days, but distinct rows), so collapsing the dash would be a guess.
 */
export function normalizeTermsKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Queue the Terms query on the bridge. Returns the bridge operation id to poll.
 * Query ops only dedupe against IN-FLIGHT operations, so calling this on every
 * resync always gets fresh data.
 */
export async function enqueueQbTermsQuery(): Promise<string> {
  const data = await bridgeFetch<{ operationId?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml: QB_TERMS_QUERY_QBXML }, timeoutMs: 30_000 }
  );
  if (!data?.operationId) {
    throw new Error("Bridge did not return an operationId for the Terms query");
  }
  return data.operationId;
}

const toNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const asArray = (raw: unknown): Record<string, unknown>[] => {
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
};

/**
 * Build the name → days map from a completed bridge operation payload
 * (the object returned by `pollBridgeStatus(...).data`).
 */
export function parseQbTermsMap(polled: unknown): QbTermsMap {
  const rs = (polled as Record<string, any>)?.operation?.result?.QBXML
    ?.QBXMLMsgsRs?.TermsQueryRs as Record<string, unknown> | undefined;

  if (!rs) return {};

  const map: QbTermsMap = {};

  const add = (t: Record<string, unknown>, dateDriven: boolean): void => {
    const name = typeof t.Name === "string" ? t.Name : null;
    if (!name) return;
    map[normalizeTermsKey(name)] = {
      name,
      days: dateDriven ? null : toNumber(t.StdDueDays),
      day_of_month_due: dateDriven ? toNumber(t.DayOfMonthDue) : null,
      is_active: t.IsActive !== "false" && t.IsActive !== false,
    };
  };

  for (const t of asArray(rs.StandardTermsRet)) add(t, false);
  for (const t of asArray(rs.DateDrivenTermsRet)) add(t, true);

  return map;
}

/**
 * Queue + poll the Terms query to completion. Used by one-off scripts; the
 * vendor sync runner drives its own polling across cron ticks instead so a
 * backend restart never loses an in-flight run.
 */
export async function fetchQbTermsMap(
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<QbTermsMap> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;

  const operationId = await enqueueQbTermsQuery();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const polled = await pollBridgeStatus(operationId);
    if (polled.status === "expired") {
      throw new Error(`Terms query op ${operationId} expired (HTTP 404)`);
    }
    const status = (polled.data as Record<string, any>)?.operation?.status;
    if (status === "failed") {
      throw new Error(
        (polled.data as Record<string, any>)?.operation?.error ??
          "Terms query failed on the bridge"
      );
    }
    if (status === "completed") {
      return parseQbTermsMap(polled.data);
    }
  }

  throw new Error(
    `Terms query op ${operationId} did not complete within ${Math.round(timeoutMs / 1000)}s`
  );
}
