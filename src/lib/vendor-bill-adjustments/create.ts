/**
 * src/lib/vendor-bill-adjustments/create.ts
 *
 * Creates / voids a `vendor_bill_adjustment` row. Pure DB effect on the
 * caller's client: the GL post (`postVendorBillAdjustment`) is the caller's
 * job, after commit, through `runLedgerHook` — same split as bill payments.
 *
 * Idempotent by `(vendor_bill_id, kind, source_fingerprint)`: creating the
 * same adjustment twice returns the existing row instead of a duplicate.
 */
import { generateEntityId } from "@medusajs/utils";
import type { PoolClient } from "pg";
import { assertBankAccountingPeriodOpen } from "../accounting/banking-period-lock";
import { computeBillBalance } from "../finance/recompute-bill-finance";
import { loadApAdjustmentConfig, type ApAdjustmentConfig } from "./config";

export type VendorBillAdjustmentKind = "rounding" | "price_variance";
export type VendorBillAdjustmentDirection = "decrease_ap" | "increase_ap";

export interface VendorBillAdjustmentRow {
  id: string;
  vendor_bill_id: string;
  kind: VendorBillAdjustmentKind;
  direction: VendorBillAdjustmentDirection;
  amount_cents: number;
  account_list_id: string;
  adjustment_date: string;
  source_fingerprint: string;
  evidence: Record<string, unknown>;
  memo: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  voided_reason: string | null;
}

export class VendorBillAdjustmentError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface CreateVendorBillAdjustmentInput {
  vendor_bill_id: string;
  kind: VendorBillAdjustmentKind;
  /** Signed residual to absorb: > 0 = POS owed more than real (decrease AP),
   * < 0 = POS overpaid by that much (increase AP). Never 0. */
  residual_cents: number;
  /** `YYYY-MM-DD`; the historical cleanup passes the ledger cutover day. */
  adjustment_date: string;
  source_fingerprint: string;
  evidence?: Record<string, unknown>;
  memo?: string | null;
  actor_id: string;
  /** Skip the tolerance check — `price_variance` and the explicit route with
   * PIN do; the automatic lane never does. */
  ignore_tolerance?: boolean;
}

export interface CreateVendorBillAdjustmentResult {
  adjustment: VendorBillAdjustmentRow;
  created: boolean;
}

const ROW_COLUMNS = `id, vendor_bill_id, kind, direction, amount_cents::int AS amount_cents, account_list_id,
  adjustment_date::text AS adjustment_date, source_fingerprint, evidence, memo, created_by,
  created_at::text AS created_at, voided_at::text AS voided_at, voided_by, voided_reason`;

export function accountForKind(
  config: ApAdjustmentConfig,
  kind: VendorBillAdjustmentKind
): string | null {
  return kind === "rounding"
    ? config.roundingAccountListId
    : config.priceVarianceAccountListId;
}

export async function createVendorBillAdjustment(
  client: PoolClient,
  input: CreateVendorBillAdjustmentInput
): Promise<CreateVendorBillAdjustmentResult> {
  if (!Number.isInteger(input.residual_cents) || input.residual_cents === 0) {
    throw new VendorBillAdjustmentError(
      "invalid_amount",
      "residual_cents must be a non-zero integer."
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.adjustment_date)) {
    throw new VendorBillAdjustmentError(
      "invalid_date",
      "adjustment_date must be YYYY-MM-DD."
    );
  }
  if (input.adjustment_date < "2026-01-01") {
    // 2025 is closed: nothing is ever dated there (bank_recon_2025_closed rule).
    throw new VendorBillAdjustmentError(
      "period_closed",
      "Adjustments cannot be dated before 2026-01-01."
    );
  }
  const config = await loadApAdjustmentConfig(client);
  const accountListId = accountForKind(config, input.kind);
  if (!accountListId) {
    throw new VendorBillAdjustmentError(
      "account_not_configured",
      `No account configured for ${input.kind} adjustments (store.metadata).`,
      409
    );
  }
  const amount = Math.abs(input.residual_cents);
  if (
    input.kind === "rounding" &&
    !input.ignore_tolerance &&
    amount > config.toleranceCents
  ) {
    throw new VendorBillAdjustmentError(
      "above_tolerance",
      `${amount}¢ exceeds the rounding tolerance of ${config.toleranceCents}¢.`,
      422
    );
  }

  const { rows: existing } = await client.query<VendorBillAdjustmentRow>(
    `SELECT ${ROW_COLUMNS} FROM vendor_bill_adjustment
      WHERE vendor_bill_id = $1 AND kind = $2 AND source_fingerprint = $3 AND deleted_at IS NULL`,
    [input.vendor_bill_id, input.kind, input.source_fingerprint]
  );
  if (existing[0]) return { adjustment: existing[0], created: false };

  const { rows: bills } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM vendor_bill WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [input.vendor_bill_id]
  );
  if (!bills[0])
    throw new VendorBillAdjustmentError(
      "bill_not_found",
      "Vendor bill not found.",
      404
    );
  if (bills[0].status !== "confirmed" && bills[0].status !== "synced") {
    throw new VendorBillAdjustmentError(
      "bill_not_confirmed",
      `Bill is ${bills[0].status}; only confirmed/synced bills carry adjustments.`
    );
  }
  await assertBankAccountingPeriodOpen(client, input.adjustment_date);

  const direction: VendorBillAdjustmentDirection =
    input.residual_cents > 0 ? "decrease_ap" : "increase_ap";
  const id = generateEntityId("", "vba");
  const { rows } = await client.query<VendorBillAdjustmentRow>(
    `INSERT INTO vendor_bill_adjustment
       (id, vendor_bill_id, kind, direction, amount_cents, account_list_id, adjustment_date,
        source_fingerprint, evidence, memo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb,$10,$11)
     RETURNING ${ROW_COLUMNS}`,
    [
      id,
      input.vendor_bill_id,
      input.kind,
      direction,
      amount,
      accountListId,
      input.adjustment_date,
      input.source_fingerprint,
      JSON.stringify(input.evidence ?? {}),
      input.memo ?? null,
      input.actor_id,
    ]
  );
  const adjustment = rows[0];
  if (!adjustment)
    throw new VendorBillAdjustmentError(
      "insert_failed",
      "Adjustment insert returned no row.",
      500
    );
  return { adjustment, created: true };
}

export async function voidVendorBillAdjustment(
  client: PoolClient,
  id: string,
  reason: string,
  actorId: string
): Promise<VendorBillAdjustmentRow> {
  const { rows } = await client.query<VendorBillAdjustmentRow>(
    `SELECT ${ROW_COLUMNS} FROM vendor_bill_adjustment WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [id]
  );
  const row = rows[0];
  if (!row)
    throw new VendorBillAdjustmentError(
      "not_found",
      "Adjustment not found.",
      404
    );
  if (row.voided_at) return row;
  const { rows: updated } = await client.query<VendorBillAdjustmentRow>(
    `UPDATE vendor_bill_adjustment SET voided_at = now(), voided_by = $2, voided_reason = $3
      WHERE id = $1 RETURNING ${ROW_COLUMNS}`,
    [id, actorId, reason]
  );
  const voided = updated[0];
  if (!voided)
    throw new VendorBillAdjustmentError(
      "not_found",
      "Adjustment not found.",
      404
    );
  return voided;
}

export async function listVendorBillAdjustments(
  client: PoolClient,
  vendorBillId: string
): Promise<VendorBillAdjustmentRow[]> {
  const { rows } = await client.query<VendorBillAdjustmentRow>(
    `SELECT ${ROW_COLUMNS} FROM vendor_bill_adjustment
      WHERE vendor_bill_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [vendorBillId]
  );
  return rows;
}

/** Signed residual of a bill after everything applied (payments, credits,
 * adjustments): > 0 still owed, < 0 overpaid. `null` when the bill is unknown. */
export async function currentResidualCents(
  client: PoolClient,
  vendorBillId: string
): Promise<number | null> {
  const balance = await computeBillBalance(client, vendorBillId);
  return balance ? balance.balance_cents : null;
}
