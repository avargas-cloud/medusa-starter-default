import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import {
  enqueueQbTermsQuery,
  normalizeTermsKey,
  parseQbTermsMap,
  type QbTermsMap,
} from "../lib/quickbooks/qb-terms";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";
const HEADERS = {
  "x-api-key": API_KEY,
  "bypass-tunnel-reminder": "true",
  "Content-Type": "application/json",
};

const CHUNK_SIZE = 300; // vendors per tick while in 'processing'
const MAX_CHUNKS_PER_TICK = 3; // up to 3 chunks per minute to reach ~1k vendors in 2 ticks
const FETCH_TIMEOUT_MINUTES = 5; // fail a 'fetching' run after this

type SyncMode = "full" | "payment_terms";

type RunRow = {
  id: string;
  status: string;
  mode: SyncMode | null;
  bridge_operation_id: string | null;
  terms_operation_id: string | null;
  vendor_snapshot: unknown;
  terms_snapshot: unknown;
  total_count: number;
  processed_count: number;
  created_count: number;
  updated_count: number;
  terms_written_count: number;
  terms_skipped_count: number;
  error_count: number;
  started_at: Date | string | null;
};

const RUN_FIELDS = [
  "id",
  "status",
  "mode",
  "bridge_operation_id",
  "terms_operation_id",
  "vendor_snapshot",
  "terms_snapshot",
  "total_count",
  "processed_count",
  "created_count",
  "updated_count",
  "terms_written_count",
  "terms_skipped_count",
  "error_count",
  "started_at",
] as const;

const modeOf = (run: RunRow): SyncMode =>
  run.mode === "payment_terms" ? "payment_terms" : "full";

/**
 * Metadata patch carrying the vendor's QB payment term.
 *
 * `default_payment_terms_days` is the number a vendor bill's Due Date is
 * computed from (bill date + days). It comes from the QB Terms list, never from
 * parsing the term name. A term QB can't express as a day count (date-driven,
 * e.g. "120" = due the 20th) writes `days: null` + the day-of-month, so the
 * caller falls back to the system default instead of inventing a number.
 */
const buildTermsMetadata = (
  termsName: string,
  entry: { days: number | null; day_of_month_due: number | null } | undefined,
  now: Date
): Record<string, unknown> => ({
  payment_terms: termsName,
  default_payment_terms_days: entry?.days ?? null,
  default_payment_terms_day_of_month: entry?.day_of_month_due ?? null,
  default_payment_terms_source: "quickbooks",
  default_payment_terms_synced_at: now.toISOString(),
});

/**
 * QB VendorRet shape we care about. The actual payload has many more fields
 * which we simply forward to the qb_vendor row via the sync script's mapping.
 */
type VendorRet = Record<string, unknown> & { ListID?: string };

const buildVendorPayload = (
  v: VendorRet,
  now: Date
): Record<string, unknown> => {
  const addr = (v.VendorAddress as Record<string, unknown> | undefined) ?? {};
  const prefillRaw = v.PrefillAccountRef;
  const prefill = Array.isArray(prefillRaw)
    ? (prefillRaw[0] as Record<string, unknown> | undefined)
    : (prefillRaw as Record<string, unknown> | undefined);
  const termsRef = v.TermsRef as Record<string, unknown> | undefined;
  const vendorTypeRef = v.VendorTypeRef as Record<string, unknown> | undefined;
  const currencyRef = v.CurrencyRef as Record<string, unknown> | undefined;

  const creditLimitRaw = v.CreditLimit as unknown;
  const creditLimit =
    creditLimitRaw != null && !Number.isNaN(Number(creditLimitRaw))
      ? Number(creditLimitRaw)
      : null;

  const eligible1099 = (() => {
    const raw = v.IsVendorEligibleFor1099 as unknown;
    if (raw === true || raw === "true" || raw === 1 || raw === "1") return true;
    if (raw === false || raw === "false" || raw === 0 || raw === "0")
      return false;
    return null;
  })();

  return {
    qb_list_id: String(v.ListID ?? ""),
    full_name: String(v.FullName ?? v.Name ?? ""),
    name: String(v.Name ?? v.FullName ?? ""),
    company_name: (v.CompanyName as string) ?? null,
    account_number: (v.AccountNumber as string) ?? null,
    is_active: v.IsActive !== false,
    first_name: (v.FirstName as string) ?? null,
    middle_initial: (v.MiddleInitial as string) ?? null,
    last_name: (v.LastName as string) ?? null,
    contact: (v.Contact as string) ?? null,
    alt_contact: (v.AltContact as string) ?? null,
    email: (v.Email as string) ?? null,
    phone: (v.Phone as string) ?? null,
    alt_phone: (v.AltPhone as string) ?? null,
    fax: (v.Fax as string) ?? null,
    addr1: (addr.Addr1 as string) ?? null,
    addr2: (addr.Addr2 as string) ?? null,
    city: (addr.City as string) ?? null,
    state: (addr.State as string) ?? null,
    postal_code: (addr.PostalCode as string) ?? null,
    country: (addr.Country as string) ?? null,
    terms_ref_name: (termsRef?.FullName as string) ?? null,
    prefill_account_ref_name: (prefill?.FullName as string) ?? null,
    vendor_type_ref_name: (vendorTypeRef?.FullName as string) ?? null,
    currency_ref_name: (currencyRef?.FullName as string) ?? null,
    tax_identity: (v.VendorTaxIdent as string) ?? null,
    is_vendor_eligible_for_1099: eligible1099,
    credit_limit: creditLimit,
    notes: (v.Notes as string) ?? null,
    last_synced_at: now,
  };
};

export default async function qbVendorSyncRunner(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger");
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;

  logger.info(`[qb-vendor-sync-runner] tick at ${new Date().toISOString()}`);

  // Pick the single active run (queued | fetching | processing).
  // If somehow multiple exist, we process the oldest — 409 on POST prevents it normally.
  const activeRun = (
    await Promise.all(
      ["queued", "fetching", "processing"].map(async (s) => {
        const { data } = await query.graph({
          entity: "qb_vendor_sync_run",
          fields: [...RUN_FIELDS],
          filters: { status: s } as any,
          pagination: { skip: 0, take: 1 },
        });
        return (data as RunRow[])[0];
      })
    )
  ).find(Boolean);

  if (!activeRun) {
    logger.info(`[qb-vendor-sync-runner] no active run`);
    return;
  }

  logger.info(
    `[qb-vendor-sync-runner] found run ${activeRun.id} status=${activeRun.status}`
  );

  try {
    if (activeRun.status === "queued") {
      await handleQueued(activeRun, catalog, logger);
      return;
    }
    if (activeRun.status === "fetching") {
      await handleFetching(activeRun, catalog, logger);
      return;
    }
    if (activeRun.status === "processing") {
      await handleProcessing(activeRun, catalog, logger);
      return;
    }
  } catch (err: any) {
    logger.error(
      `[qb-vendor-sync-runner] run ${activeRun.id} (${activeRun.status}) failed: ${err.message}`
    );
    await catalog.updateQbVendorSyncRuns({
      id: activeRun.id,
      status: "failed",
      last_error: err.message,
      completed_at: new Date(),
    });
  }
}

async function handleQueued(
  run: RunRow,
  catalog: any,
  logger: any
): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/api/vendors`, { headers: HEADERS });
  const data = await res.json();
  if (!data.operationId) {
    throw new Error("Bridge did not return operationId");
  }

  // The QB Terms list runs as a SECOND, parallel bridge query: a VendorRet only
  // carries the term NAME, so the due-days come from the Terms catalog. In
  // payment_terms mode it is the whole point of the run and a failure is fatal;
  // in full mode the vendor refresh still stands on its own, so we degrade to
  // "no terms this run" rather than fail the sync.
  let termsOperationId: string | null = null;
  try {
    termsOperationId = await enqueueQbTermsQuery();
  } catch (err: any) {
    if (modeOf(run) === "payment_terms") throw err;
    logger.warn(
      `[qb-vendor-sync-runner] run ${run.id} could not queue the Terms query ` +
        `(${err.message}) — continuing without payment terms`
    );
  }

  await catalog.updateQbVendorSyncRuns({
    id: run.id,
    status: "fetching",
    bridge_operation_id: data.operationId,
    terms_operation_id: termsOperationId,
    started_at: new Date(),
  });
  logger.info(
    `[qb-vendor-sync-runner] run ${run.id} (${modeOf(run)}) → fetching ` +
      `op=${data.operationId} termsOp=${termsOperationId ?? "none"}`
  );
}

/**
 * Poll the parallel Terms query. Returns the parsed map when it lands,
 * `"waiting"` while the bridge is still working, `null` when there is nothing
 * to wait for (no op queued, or it failed in a mode that tolerates that).
 */
async function pollTermsMap(
  run: RunRow,
  logger: any
): Promise<QbTermsMap | "waiting" | null> {
  if (!run.terms_operation_id) return null;

  const fatal = modeOf(run) === "payment_terms";
  const polled = await pollBridgeStatus(run.terms_operation_id);

  if (polled.status === "expired") {
    const msg = `Terms query op ${run.terms_operation_id} expired (HTTP 404)`;
    if (fatal) throw new Error(msg);
    logger.warn(`[qb-vendor-sync-runner] run ${run.id} ${msg} — skipping terms`);
    return null;
  }

  const op = (polled.data as Record<string, any>)?.operation;
  if (op?.status === "failed") {
    const msg = `Terms query failed: ${op?.error ?? "unknown error"}`;
    if (fatal) throw new Error(msg);
    logger.warn(`[qb-vendor-sync-runner] run ${run.id} ${msg} — skipping terms`);
    return null;
  }
  if (op?.status !== "completed") return "waiting";

  return parseQbTermsMap(polled.data);
}

async function handleFetching(
  run: RunRow,
  catalog: any,
  logger: any
): Promise<void> {
  // Time-out guard: if we've been in 'fetching' for more than FETCH_TIMEOUT_MINUTES, fail.
  if (run.started_at) {
    const startedMs =
      run.started_at instanceof Date
        ? run.started_at.getTime()
        : new Date(run.started_at).getTime();
    const ageMinutes = (Date.now() - startedMs) / 60000;
    if (ageMinutes > FETCH_TIMEOUT_MINUTES) {
      throw new Error(
        `Bridge fetch timed out after ${FETCH_TIMEOUT_MINUTES} min (op=${run.bridge_operation_id})`
      );
    }
  }

  if (!run.bridge_operation_id) {
    throw new Error("Fetching state without bridge_operation_id");
  }

  const polled = await pollBridgeStatus(run.bridge_operation_id);
  if (polled.status === "expired") {
    throw new Error(
      `Bridge sync op ${run.bridge_operation_id} expired (HTTP 404)`
    );
  }
  const data: any = polled.data;
  const status = data.operation?.status;

  if (status === "failed") {
    throw new Error(data.operation?.error ?? "Bridge op failed");
  }
  if (status !== "completed") {
    // still queued/processing on bridge side — wait for next tick
    return;
  }

  // Both bridge queries must land before we start writing: a chunk processed
  // without the terms map would stamp `days: null` on vendors that do have a
  // term in QB. The FETCH_TIMEOUT_MINUTES guard above bounds the wait.
  const termsMap = await pollTermsMap(run, logger);
  if (termsMap === "waiting") {
    logger.info(
      `[qb-vendor-sync-runner] run ${run.id} vendors ready, waiting on Terms query`
    );
    return;
  }

  const raw =
    data.operation?.result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet ?? [];
  const vendors: VendorRet[] = Array.isArray(raw) ? raw : [raw];

  await catalog.updateQbVendorSyncRuns({
    id: run.id,
    status: vendors.length === 0 ? "completed" : "processing",
    vendor_snapshot: vendors,
    terms_snapshot: termsMap ?? null,
    total_count: vendors.length,
    completed_at: vendors.length === 0 ? new Date() : null,
  });
  logger.info(
    `[qb-vendor-sync-runner] run ${run.id} → processing (${vendors.length} vendors, ` +
      `${Object.keys(termsMap ?? {}).length} QB terms)`
  );
}

async function handleProcessing(
  run: RunRow,
  catalog: any,
  logger: any
): Promise<void> {
  const snapshot = (run.vendor_snapshot as VendorRet[] | null) ?? [];
  if (snapshot.length === 0) {
    await catalog.updateQbVendorSyncRuns({
      id: run.id,
      status: "completed",
      completed_at: new Date(),
    });
    return;
  }

  const mode = modeOf(run);
  const termsMap = (run.terms_snapshot as QbTermsMap | null) ?? {};

  // Accumulate progress locally and flush to DB between chunks so the UI
  // sees fine-grained updates instead of a big jump at the end of the tick.
  let processed = run.processed_count;
  let created = run.created_count;
  let updated = run.updated_count;
  let termsWritten = run.terms_written_count;
  let termsSkipped = run.terms_skipped_count;
  let errored = run.error_count;

  for (let i = 0; i < MAX_CHUNKS_PER_TICK; i++) {
    if (processed >= snapshot.length) break;
    const from = processed;
    const to = Math.min(from + CHUNK_SIZE, snapshot.length);
    const chunk = snapshot.slice(from, to);

    const chunkListIds = chunk
      .map((v) => v.ListID)
      .filter((id): id is string => !!id);
    // `metadata` is selected too: the terms patch is a read-modify-write merge
    // (Medusa deep-merges JSONB on update, but the manual-override check needs
    // the previous value anyway).
    const existing = chunkListIds.length
      ? ((await catalog.listQbVendors(
          { qb_list_id: chunkListIds },
          {
            select: ["id", "qb_list_id", "metadata"],
            take: chunkListIds.length,
          }
        )) as {
          id: string;
          qb_list_id: string;
          metadata: Record<string, unknown> | null;
        }[])
      : [];
    const byListId = new Map(existing.map((v) => [v.qb_list_id, v]));

    const now = new Date();
    let chunkCreated = 0;
    let chunkUpdated = 0;
    let chunkErrored = 0;

    for (const v of chunk) {
      if (!v.ListID) {
        chunkErrored++;
        continue;
      }
      try {
        const payload = buildVendorPayload(v, now);
        const termsName = payload.terms_ref_name as string | null;
        const termsEntry = termsName
          ? termsMap[normalizeTermsKey(termsName)]
          : undefined;
        const prev = byListId.get(String(v.ListID));

        if (prev) {
          const prevMeta = (prev.metadata ?? {}) as Record<string, unknown>;
          // A term set by hand in the POS wins over QuickBooks — the accountant
          // negotiated it there and a resync must not silently undo it. The QB
          // term NAME still refreshes; only the day count is left alone.
          const isManual = prevMeta.default_payment_terms_days_manual === true;
          const writeTerms = !!termsName && !isManual;

          if (writeTerms) termsWritten++;
          else termsSkipped++;

          const fields =
            mode === "payment_terms"
              ? {
                  terms_ref_name: payload.terms_ref_name,
                  last_synced_at: payload.last_synced_at,
                }
              : payload;

          await catalog.updateQbVendors({
            id: prev.id,
            ...fields,
            ...(writeTerms
              ? {
                  metadata: {
                    ...prevMeta,
                    ...buildTermsMetadata(termsName!, termsEntry, now),
                  },
                }
              : {}),
          });
          chunkUpdated++;
        } else {
          if (termsName) termsWritten++;
          else termsSkipped++;

          const metadata = termsName
            ? buildTermsMetadata(termsName, termsEntry, now)
            : { payment_terms: null };

          try {
            await catalog.createQbVendors({ ...payload, metadata });
            chunkCreated++;
          } catch (err: any) {
            // Two runner ticks can overlap when a chunk pass outlives the
            // one-minute cron interval: the second tick re-reads a stale
            // processed_count and replays the chunk, so a vendor this pass
            // believes is new already exists. Fall back to an update instead of
            // burning an error — the row still ends up with its QB terms.
            if (!/already exists/i.test(err?.message ?? "")) throw err;

            const [dup] = (await catalog.listQbVendors(
              { qb_list_id: [String(v.ListID)] },
              { select: ["id", "metadata"], take: 1 }
            )) as { id: string; metadata: Record<string, unknown> | null }[];
            if (!dup) throw err;

            await catalog.updateQbVendors({
              id: dup.id,
              ...payload,
              metadata: { ...(dup.metadata ?? {}), ...metadata },
            });
            chunkUpdated++;
          }
        }
      } catch (err: any) {
        chunkErrored++;
        logger.warn(
          `[qb-vendor-sync-runner] run ${run.id} vendor ${v.ListID} failed: ${err.message}`
        );
      }
    }

    processed = to;
    created += chunkCreated;
    updated += chunkUpdated;
    errored += chunkErrored;

    const isDone = processed >= snapshot.length;
    await catalog.updateQbVendorSyncRuns({
      id: run.id,
      processed_count: processed,
      created_count: created,
      updated_count: updated,
      terms_written_count: termsWritten,
      terms_skipped_count: termsSkipped,
      error_count: errored,
      status: isDone ? "completed" : "processing",
      completed_at: isDone ? new Date() : null,
      vendor_snapshot: isDone ? null : run.vendor_snapshot,
      terms_snapshot: isDone ? null : run.terms_snapshot,
    });

    logger.info(
      `[qb-vendor-sync-runner] run ${run.id} chunk ${from}-${to}/${snapshot.length} ` +
        `(created=${chunkCreated} updated=${chunkUpdated} err=${chunkErrored})`
    );

    if (isDone) {
      logger.info(
        `[qb-vendor-sync-runner] run ${run.id} (${mode}) → completed ` +
          `(created=${created} updated=${updated} terms=${termsWritten} ` +
          `termsSkipped=${termsSkipped} error=${errored})`
      );
      break;
    }
  }
}

export const config = {
  name: "qb-vendor-sync-runner",
  schedule: "*/1 * * * *", // every minute (5-field cron, matches other QB jobs)
};
