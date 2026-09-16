/**
 * src/lib/vendor-bill-adjustments/auto.ts
 *
 * Prevention half of ap-rounding-cleanup-20260916: right after a payment or a
 * credit is applied to a bill, whatever is left within the rounding tolerance
 * is absorbed by a `rounding` adjustment — so a bill paid for its real invoice
 * amount never sits open by 14¢ again. Runs INSIDE the caller's transaction
 * (same client, same COMMIT); the GL post of the row is the caller's job after
 * commit, like the payment itself.
 *
 * Never throws: not absorbing a residual is a legitimate outcome (no config,
 * above tolerance, nothing left), and failing a payment because of 3¢ would be
 * worse than leaving the 3¢ visible.
 */
import type { PoolClient } from "pg";
import { getBusinessDateString } from "../date/et";
import {
  createVendorBillAdjustment,
  currentResidualCents,
  VendorBillAdjustmentError,
  type VendorBillAdjustmentRow,
} from "./create";

export interface AutoWriteOffInput {
  vendor_bill_id: string;
  trigger: "payment" | "credit";
  trigger_id: string;
  actor_id: string;
  /** Business day of the payment/credit (`YYYY-MM-DD`). */
  day?: string;
}

export type AutoWriteOffOutcome =
  | {
      created: true;
      adjustment: VendorBillAdjustmentRow;
      residual_cents: number;
    }
  | { created: false; reason: string; residual_cents: number | null };

export async function maybeAutoWriteOffRounding(
  client: PoolClient,
  input: AutoWriteOffInput
): Promise<AutoWriteOffOutcome> {
  let residual: number | null = null;
  // Savepoint: a failed statement here must not abort the caller's transaction.
  await client.query("SAVEPOINT ap_auto_write_off");
  try {
    residual = await currentResidualCents(client, input.vendor_bill_id);
    if (residual === null)
      return { created: false, reason: "bill_not_found", residual_cents: null };
    if (residual === 0)
      return { created: false, reason: "no_residual", residual_cents: 0 };
    const result = await createVendorBillAdjustment(client, {
      vendor_bill_id: input.vendor_bill_id,
      kind: "rounding",
      residual_cents: residual,
      adjustment_date: input.day ?? getBusinessDateString(),
      source_fingerprint: `auto:${input.trigger}:${input.trigger_id}`,
      evidence: {
        trigger: input.trigger,
        trigger_id: input.trigger_id,
        residual_cents: residual,
      },
      memo: `Auto rounding write-off after ${input.trigger} ${input.trigger_id}`,
      actor_id: input.actor_id,
    });
    await client.query("RELEASE SAVEPOINT ap_auto_write_off");
    if (!result.created)
      return {
        created: false,
        reason: "already_adjusted",
        residual_cents: residual,
      };
    return {
      created: true,
      adjustment: result.adjustment,
      residual_cents: residual,
    };
  } catch (err) {
    await client
      .query("ROLLBACK TO SAVEPOINT ap_auto_write_off")
      .catch(() => {});
    // `above_tolerance` / `account_not_configured` / `period_closed` are the
    // expected "no" answers; anything else is reported the same way — the
    // payment must not fail because of its residual.
    const reason =
      err instanceof VendorBillAdjustmentError ? err.code : "unexpected";
    return { created: false, reason, residual_cents: residual };
  }
}
