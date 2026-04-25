import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../modules/quickbooks-catalog";

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

type RunRow = {
  id: string;
  status: string;
  bridge_operation_id: string | null;
  vendor_snapshot: unknown;
  total_count: number;
  processed_count: number;
  created_count: number;
  updated_count: number;
  error_count: number;
  started_at: Date | string | null;
};

/**
 * QB VendorRet shape we care about. The actual payload has many more fields
 * which we simply forward to the qb_vendor row via the sync script's mapping.
 */
type VendorRet = Record<string, unknown> & { ListID?: string };

const buildVendorPayload = (v: VendorRet, now: Date): Record<string, unknown> => {
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
    if (raw === false || raw === "false" || raw === 0 || raw === "0") return false;
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
          fields: [
            "id",
            "status",
            "bridge_operation_id",
            "vendor_snapshot",
            "total_count",
            "processed_count",
            "created_count",
            "updated_count",
            "error_count",
            "started_at",
          ],
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

async function handleQueued(run: RunRow, catalog: any, logger: any): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/api/vendors`, { headers: HEADERS });
  const data = await res.json();
  if (!data.operationId) {
    throw new Error("Bridge did not return operationId");
  }
  await catalog.updateQbVendorSyncRuns({
    id: run.id,
    status: "fetching",
    bridge_operation_id: data.operationId,
    started_at: new Date(),
  });
  logger.info(
    `[qb-vendor-sync-runner] run ${run.id} → fetching op=${data.operationId}`
  );
}

async function handleFetching(run: RunRow, catalog: any, logger: any): Promise<void> {
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

  const res = await fetch(
    `${BRIDGE_URL}/api/sync/status/${run.bridge_operation_id}`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Bridge status HTTP ${res.status}`);
  const data = await res.json();
  const status = data.operation?.status;

  if (status === "failed") {
    throw new Error(data.operation?.error ?? "Bridge op failed");
  }
  if (status !== "completed") {
    // still queued/processing on bridge side — wait for next tick
    return;
  }

  const raw =
    data.operation?.result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet ?? [];
  const vendors: VendorRet[] = Array.isArray(raw) ? raw : [raw];

  await catalog.updateQbVendorSyncRuns({
    id: run.id,
    status: vendors.length === 0 ? "completed" : "processing",
    vendor_snapshot: vendors,
    total_count: vendors.length,
    completed_at: vendors.length === 0 ? new Date() : null,
  });
  logger.info(
    `[qb-vendor-sync-runner] run ${run.id} → processing (${vendors.length} vendors)`
  );
}

async function handleProcessing(run: RunRow, catalog: any, logger: any): Promise<void> {
  const snapshot = (run.vendor_snapshot as VendorRet[] | null) ?? [];
  if (snapshot.length === 0) {
    await catalog.updateQbVendorSyncRuns({
      id: run.id,
      status: "completed",
      completed_at: new Date(),
    });
    return;
  }

  // Accumulate progress locally and flush to DB between chunks so the UI
  // sees fine-grained updates instead of a big jump at the end of the tick.
  let processed = run.processed_count;
  let created = run.created_count;
  let updated = run.updated_count;
  let errored = run.error_count;

  for (let i = 0; i < MAX_CHUNKS_PER_TICK; i++) {
    if (processed >= snapshot.length) break;
    const from = processed;
    const to = Math.min(from + CHUNK_SIZE, snapshot.length);
    const chunk = snapshot.slice(from, to);

    const chunkListIds = chunk
      .map((v) => v.ListID)
      .filter((id): id is string => !!id);
    const existing = chunkListIds.length
      ? (await catalog.listQbVendors(
          { qb_list_id: chunkListIds },
          { select: ["id", "qb_list_id"], take: chunkListIds.length }
        )) as { id: string; qb_list_id: string }[]
      : [];
    const byListId = new Map(existing.map((v) => [v.qb_list_id, v.id]));

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
        const prevId = byListId.get(String(v.ListID));
        if (prevId) {
          await catalog.updateQbVendors({ id: prevId, ...payload });
          chunkUpdated++;
        } else {
          await catalog.createQbVendors({
            ...payload,
            metadata: { payment_terms: payload.terms_ref_name ?? null },
          });
          chunkCreated++;
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
      error_count: errored,
      status: isDone ? "completed" : "processing",
      completed_at: isDone ? new Date() : null,
      vendor_snapshot: isDone ? null : run.vendor_snapshot,
    });

    logger.info(
      `[qb-vendor-sync-runner] run ${run.id} chunk ${from}-${to}/${snapshot.length} ` +
      `(created=${chunkCreated} updated=${chunkUpdated} err=${chunkErrored})`
    );

    if (isDone) {
      logger.info(
        `[qb-vendor-sync-runner] run ${run.id} → completed ` +
        `(created=${created} updated=${updated} error=${errored})`
      );
      break;
    }
  }
}

export const config = {
  name: "qb-vendor-sync-runner",
  schedule: "*/1 * * * *", // every minute (5-field cron, matches other QB jobs)
};
