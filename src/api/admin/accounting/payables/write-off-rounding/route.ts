import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { PoolClient } from "pg";
import { getDbPool } from "../../../../utils/db-pool";
import {
  accessFailure,
  assertAccounting,
} from "../../../../../lib/pos/access-level";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
} from "../../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";
import { runLedgerHook } from "../../../../../lib/ledger-hooks/run-ledger-hook";
import { postVendorBillAdjustment } from "../../../../../lib/ledger/documents/vendor-bill-adjustment";
import { computeBillBalancesBatch } from "../../../../../lib/finance/recompute-bill-finance";
import { loadApAdjustmentConfig } from "../../../../../lib/vendor-bill-adjustments/config";
import {
  createVendorBillAdjustment,
  VendorBillAdjustmentError,
} from "../../../../../lib/vendor-bill-adjustments/create";
import { getBusinessDateString } from "../../../../../lib/date/et";

/**
 * ap-rounding-cleanup-20260916
 *
 * GET  /admin/accounting/payables/write-off-rounding
 *      → { tolerance_cents, candidates: [{vendor_bill_id, number, vendor_name, residual_cents}] }
 *      Open bills QuickBooks already has as PAID whose residual is within the
 *      rounding tolerance — what the "Write off rounding (N)" button offers.
 * POST /admin/accounting/payables/write-off-rounding { bill_ids?: string[] }
 *      Supervisor PIN. One `rounding` adjustment per candidate (all of them
 *      when `bill_ids` is omitted), dated today, posted to the GL. Nothing
 *      goes to QuickBooks: the bill is already settled there.
 */

interface Candidate {
  vendor_bill_id: string;
  number: string | null;
  vendor_name: string | null;
  residual_cents: number;
}

async function loadCandidates(
  client: PoolClient,
  toleranceCents: number,
  only?: string[]
): Promise<Candidate[]> {
  const { rows } = await client.query<{
    id: string;
    number: string | null;
    vendor_name_snapshot: string | null;
  }>(
    `SELECT id, number, vendor_name_snapshot FROM vendor_bill
      WHERE deleted_at IS NULL AND status IN ('confirmed','synced') AND qb_is_paid = true
        AND ($1::text[] IS NULL OR id = ANY($1::text[]))`,
    [only ?? null]
  );
  if (rows.length === 0) return [];
  const balances = await computeBillBalancesBatch(
    client,
    rows.map((r) => r.id)
  );
  const out: Candidate[] = [];
  for (const r of rows) {
    const b = balances.get(r.id);
    if (
      !b ||
      b.balance_cents === 0 ||
      Math.abs(b.balance_cents) > toleranceCents
    )
      continue;
    out.push({
      vendor_bill_id: r.id,
      number: r.number,
      vendor_name: r.vendor_name_snapshot,
      residual_cents: b.balance_cents,
    });
  }
  return out;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await assertAccounting(req);
  } catch (error) {
    return accessFailure(res, error);
  }
  const client = await getDbPool().connect();
  try {
    const config = await loadApAdjustmentConfig(client);
    const candidates = await loadCandidates(client, config.toleranceCents);
    return res.json({
      tolerance_cents: config.toleranceCents,
      configured: !!config.roundingAccountListId,
      candidates,
    });
  } finally {
    client.release();
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = (await assertAccounting(req)).userId;
  } catch (error) {
    return accessFailure(res, error);
  }
  const knex = req.scope.resolve("__pg_connection__");
  const guard = await guardSupervisorPin({
    scope: req.scope as unknown as { resolve: (k: string) => unknown },
    db: knex as unknown as PinConn,
    pin: extractSupervisorPin(req),
    actorId,
  });
  if (!guard.ok) {
    const { status, body } = pinGuardResponse(guard);
    return res.status(status).json(body);
  }
  const body = (req.body ?? {}) as { bill_ids?: unknown };
  const only = Array.isArray(body.bill_ids)
    ? body.bill_ids.filter((x): x is string => typeof x === "string")
    : undefined;

  const day = getBusinessDateString();
  const results: Array<{
    vendor_bill_id: string;
    number: string | null;
    residual_cents: number;
    adjustment_id: string | null;
    error: string | null;
  }> = [];
  const client = await getDbPool().connect();
  try {
    const config = await loadApAdjustmentConfig(client);
    if (!config.roundingAccountListId) {
      return res
        .status(409)
        .json({
          error: "No A/P rounding account configured.",
          code: "account_not_configured",
        });
    }
    const candidates = await loadCandidates(
      client,
      config.toleranceCents,
      only
    );
    for (const c of candidates) {
      try {
        await client.query("BEGIN");
        const created = await createVendorBillAdjustment(client, {
          vendor_bill_id: c.vendor_bill_id,
          kind: "rounding",
          residual_cents: c.residual_cents,
          adjustment_date: day,
          source_fingerprint: `batch:${c.residual_cents}`,
          evidence: {
            via: guard.via,
            route: "payables/write-off-rounding",
            qb_is_paid: true,
          },
          memo: "Rounding write-off (QuickBooks has the bill paid)",
          actor_id: actorId,
        });
        await client.query("COMMIT");
        results.push({
          ...c,
          adjustment_id: created.adjustment.id,
          error: null,
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        const message =
          error instanceof VendorBillAdjustmentError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        results.push({ ...c, adjustment_id: null, error: message });
      }
    }
  } finally {
    client.release();
  }
  for (const r of results) {
    if (!r.adjustment_id) continue;
    const adjustmentId = r.adjustment_id;
    await runLedgerHook(
      (c) => postVendorBillAdjustment(c, adjustmentId, actorId),
      {
        source_kind: "vendor_bill_adjustment",
        source_id: adjustmentId,
      }
    );
  }
  return res.status(201).json({
    written_off: results.filter((r) => r.adjustment_id).length,
    failed: results.filter((r) => !r.adjustment_id).length,
    results,
  });
}
