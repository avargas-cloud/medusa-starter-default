import { getDbPool } from "../../../api/utils/db-pool";
import type { PipelineStep } from "./types";
import { writePipelineRow } from "./row-mutations";

/**
 * Idempotent upsert of a step='customer' pipeline row keyed by customer_id.
 *
 * Returns the UUID of the row — either the existing open row (pending/submitted/
 * waiting/confirmed) or a newly inserted pending one.
 *
 * If an existing row is in 'failed' state, it is resurrected to 'pending' and
 * retry_count incremented (same semantics as writePipelineRow for reactivation).
 *
 * medusaRefNumber stores the customer email for UI readability.
 */
export async function ensureCustomerPipelineRow(
  customerId: string,
  customerEmail: string | null
): Promise<string> {
  const pool = getDbPool();

  // 1) In-flight row (pending/submitted/waiting) or already confirmed → reuse.
  const { rows: existing } = await pool.query(
    `SELECT id, status FROM qb_order_pipeline
      WHERE step = 'customer' AND reference_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [customerId]
  );

  if (existing.length > 0) {
    const row = existing[0];
    if (row.status === "failed") {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET status       = 'pending',
                error        = NULL,
                failed_at    = NULL,
                submitted_at = NULL,
                bridge_op_id = NULL,
                qb_result    = NULL,
                retry_count  = retry_count + 1,
                updated_at   = NOW(),
                medusa_ref_number = COALESCE($2, medusa_ref_number)
          WHERE id = $1`,
        [row.id, customerEmail]
      );
    }
    return row.id as string;
  }

  // 2) INSERT fresh pending row.
  const { rows } = await pool.query(
    `INSERT INTO qb_order_pipeline
        (reference_id, reference_type, step, status, medusa_ref_number)
     VALUES ($1, 'customer', 'customer', 'pending', $2)
     RETURNING id`,
    [customerId, customerEmail]
  );
  return rows[0].id as string;
}

/**
 * Preflight guard for QB handlers that require a customer to exist in QuickBooks.
 *
 * Reads customer.metadata.qb_list_id directly from the DB. If present, returns
 * `{ qbListId }` and the caller proceeds with the QB call.
 *
 * If absent:
 *   1. Enqueues / reuses a step='customer' pipeline row for the customer.
 *   2. Writes the caller's pipeline row as status='waiting' with depends_on set.
 *   3. Returns `{ waiting: true, customerRowId }` — the caller MUST return early.
 *
 * The consolidator processes step='customer' rows via ensureCustomerInQb,
 * and the "wake dependents" micro-pass reactivates the caller's waiting row
 * once the customer is confirmed.
 */
export type RequireQbCustomerResult =
  | { qbListId: string }
  | { waiting: true; customerRowId: string };

export async function requireQbCustomer(input: {
  customerId: string;
  orderId?: string | null;
  step: PipelineStep;
  selfReferenceId?: string | null;
  selfReferenceType?: string | null;
  selfMedusaRefNumber?: string | null;
}): Promise<RequireQbCustomerResult> {
  const pool = getDbPool();

  const { rows } = await pool.query(
    `SELECT email, metadata FROM customer WHERE id = $1 LIMIT 1`,
    [input.customerId]
  );
  const row = rows[0];
  const qbListId: string | null =
    (row?.metadata?.qb_list_id as string | undefined) ?? null;

  if (qbListId) {
    return { qbListId };
  }

  // Customer not in QB yet — enqueue creation, mark caller waiting.
  const email: string | null = (row?.email as string | undefined) ?? null;
  const customerRowId = await ensureCustomerPipelineRow(
    input.customerId,
    email
  );

  await writePipelineRow({
    orderId: input.orderId ?? null,
    referenceId: input.selfReferenceId ?? null,
    referenceType: input.selfReferenceType ?? null,
    step: input.step,
    status: "waiting",
    dependsOn: customerRowId,
    medusaRefNumber: input.selfMedusaRefNumber ?? null,
  });

  return { waiting: true, customerRowId };
}

/**
 * Wake-up pass: any 'waiting' row whose depends_on row has been 'confirmed'
 * is moved back to 'pending' so the consolidator picks it up on the next tick.
 *
 * Also clears submitted_at/failed_at/error if previously set. depends_on is kept
 * so the lineage is traceable in the UI.
 *
 * Returns the number of rows awakened.
 */
export async function wakeDependentsOfConfirmed(): Promise<number> {
  const pool = getDbPool();
  const { rowCount } = await pool.query(
    `UPDATE qb_order_pipeline w
        SET status       = 'pending',
            updated_at   = NOW(),
            error        = NULL,
            failed_at    = NULL,
            submitted_at = NULL,
            bridge_op_id = NULL
      FROM qb_order_pipeline d
     WHERE w.depends_on = d.id
       AND w.status     = 'waiting'
       AND d.status     = 'confirmed'`
  );
  return rowCount ?? 0;
}
