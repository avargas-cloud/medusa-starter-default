import type { PoolClient } from "pg";

import type { SqlClient } from "../accounting/month-close-data";
import { BankingError } from "../banking/security";
import { BillPaymentError } from "../bill-payments/types";
import { VendorCreditError } from "../vendor-credits/types";

import { runCreditStep } from "./steps-credit";
import { runPrepaymentStep } from "./steps-prepayment";
import { runCashStep } from "./steps-cash";
import {
  BillSettlementError,
  type SettleBillsInput,
  type SettleBillsResult,
  type SettlementStep,
} from "./types";

export interface SettleDeps {
  pool: { connect(): Promise<PoolClient> };
  knex: SqlClient;
  runLedgerHook: (
    action: (client: PoolClient) => Promise<unknown>,
    context: { source_kind: string; source_id: string }
  ) => Promise<void>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure input checks — no DB. Any failure here means `settleBills` never
 * touches `deps`, which is exactly what the unit spec (c) asserts.
 */
function assertPureInput(input: SettleBillsInput): void {
  if (!input.vendor_id) throw new BillSettlementError("invalid_vendor_id", "vendor_id is required.");
  if (!DATE_RE.test(input.settlement_date)) {
    throw new BillSettlementError("invalid_settlement_date", "settlement_date must be YYYY-MM-DD.");
  }
  for (const a of input.credit_allocations) {
    if (!(a.amount_cents > 0)) throw new BillSettlementError("invalid_amount", "Every credit allocation must have amount_cents > 0.");
  }
  for (const a of input.prepayment_allocations) {
    if (!(a.amount_cents > 0)) throw new BillSettlementError("invalid_amount", "Every prepayment allocation must have amount_cents > 0.");
  }
  if (input.cash) {
    if (input.cash.allocations.length === 0) {
      throw new BillSettlementError("invalid_cash_payment", "A cash payment needs at least one allocation.");
    }
    if (!input.cash.bank_account_list_id) {
      throw new BillSettlementError("invalid_cash_payment", "A cash payment needs bank_account_list_id.");
    }
    for (const a of input.cash.allocations) {
      if (!(a.amount_cents > 0)) throw new BillSettlementError("invalid_amount", "Every cash allocation must have amount_cents > 0.");
    }
  }
  const totalAllocations =
    input.credit_allocations.length + input.prepayment_allocations.length + (input.cash?.allocations.length ?? 0);
  if (totalAllocations === 0) {
    throw new BillSettlementError("no_allocations", "A settlement needs at least one allocation.");
  }
}

function toFailure(
  kind: "credit" | "prepayment" | "cash",
  err: unknown
): SettleBillsResult["failed"] {
  if (err instanceof VendorCreditError || err instanceof BillPaymentError || err instanceof BillSettlementError) {
    return { kind, code: err.code, message: err.message, status: err.status };
  }
  // Period lock / banking guards (423 closed period, …): a known refusal, so
  // the steps already posted still ride in the result instead of vanishing
  // behind a bare HTTP error.
  if (err instanceof BankingError) {
    return { kind, code: err.code, message: err.code, status: err.status };
  }
  throw err;
}

/**
 * Orchestrates Pay Bills' three lanes, SEQUENTIALLY, in a fixed order —
 * credits first (free money already on file), then prepayments (money the
 * vendor already holds), then cash (new money) last. Cuts at the FIRST
 * failure: every step already run is a REAL, posted document (a vendor
 * credit application, a posted account-only vendor credit, a bill payment)
 * — none of it is rolled back on a later failure, and every one of those
 * documents rides in `steps` so the caller (and the POS) can see exactly
 * how far the settlement got.
 */
export async function settleBills(deps: SettleDeps, input: SettleBillsInput): Promise<SettleBillsResult> {
  assertPureInput(input);

  const steps: SettlementStep[] = [];

  for (const alloc of input.credit_allocations) {
    try {
      steps.push(await runCreditStep(deps, alloc, input.actor_id));
    } catch (err) {
      return { ok: false, steps, failed: toFailure("credit", err) };
    }
  }

  for (const alloc of input.prepayment_allocations) {
    try {
      steps.push(await runPrepaymentStep(deps, alloc, input.vendor_id, input.settlement_date, input.actor_id));
    } catch (err) {
      return { ok: false, steps, failed: toFailure("prepayment", err) };
    }
  }

  if (input.cash) {
    try {
      steps.push(await runCashStep(deps, input.cash, input.vendor_id, input.settlement_date, input.actor_id));
    } catch (err) {
      return { ok: false, steps, failed: toFailure("cash", err) };
    }
  }

  return { ok: true, steps };
}
