/**
 * One-off legacy warranty classification for S11299 / invoice 21273 and
 * S11324 / invoice 21300. Dry-run by default; the exact allowlist is immutable.
 *
 * Production apply additionally requires:
 *   APPLY=true WARRANTY_BACKFILL_PLAN=backfill-legacy-zero-warranty-v1
 */
import type { ExecArgs } from "@medusajs/framework/types";
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import {
  buildZeroTotalEvidence,
  isValidZeroTotalEvidence,
  type ZeroTotalEvidence,
} from "../../lib/order-completion/zero-total-evidence";
import { maybeCompleteOrder } from "../../lib/maybe-complete-order";

const PLAN_ID = "backfill-legacy-zero-warranty-v1";
const CONFIRMED_BY = "operator:alejo";

const TARGETS = [
  {
    documentNumber: "S11299",
    displayId: 2876,
    orderId: "order_01KYTAZF6BF8G23SMZZH127T11",
    invoiceId: "01KYTD19NTMBFPWE89CG37R0PN",
    invoiceNumber: "21273",
  },
  {
    documentNumber: "S11324",
    displayId: 2886,
    orderId: "order_01KYWE956EBPK5AFFCHVX81KBA",
    invoiceId: "01KZ3XK6TCV3XK2EZ25QJ4S2ZK",
    invoiceNumber: "21300",
  },
] as const;

type Target = (typeof TARGETS)[number];

interface TargetRow {
  document_number: string;
  display_id: number;
  order_id: string;
  order_status: string;
  is_draft_order: boolean;
  pos_closed: string | null;
  invoice_id: string;
  invoice_number: string;
  total: string;
  amount_paid: string;
  invoice_status: string;
  created_by: string | null;
  created_at: Date;
  metadata: Record<string, unknown> | null;
  evidence: unknown;
  active_invoices: string;
  item_rows: string;
  unfulfilled_items: string;
  open_credit_memos: string;
}

interface LegacyEvidence extends ZeroTotalEvidence {
  legacy: {
    plan_id: typeof PLAN_ID;
    document_number: string;
    invoice_number: string;
    historical_created_by: string;
    historical_invoice_created_at: string;
  };
}

interface PlannedTarget {
  target: Target;
  row: TargetRow;
  needsWrite: boolean;
}

const TARGET_SQL = `
  SELECT
    o.metadata->>'document_number' AS document_number,
    o.display_id,
    o.id AS order_id,
    o.status AS order_status,
    o.is_draft_order,
    o.metadata->>'pos_closed' AS pos_closed,
    pi.id AS invoice_id,
    pi.invoice_number,
    pi.total::text,
    pi.amount_paid::text,
    pi.status AS invoice_status,
    pi.created_by,
    pi.created_at,
    pi.metadata,
    pi.metadata->'zero_total_evidence' AS evidence,
    (SELECT COUNT(*)::text FROM pos_invoice pi2
      WHERE pi2.order_id = o.id AND pi2.deleted_at IS NULL
        AND pi2.status != 'voided') AS active_invoices,
    (SELECT COUNT(*)::text FROM order_item oi
      WHERE oi.order_id = o.id AND oi.version = o.version
        AND oi.deleted_at IS NULL) AS item_rows,
    (SELECT COUNT(*)::text FROM order_item oi
      WHERE oi.order_id = o.id AND oi.version = o.version
        AND oi.deleted_at IS NULL AND oi.fulfilled_quantity < oi.quantity)
      AS unfulfilled_items,
    (SELECT COUNT(*)::text FROM pos_credit_memo pcm
      WHERE pcm.order_id = o.id AND pcm.deleted_at IS NULL
        AND pcm.status NOT IN ('completed', 'voided')) AS open_credit_memos
  FROM pos_invoice pi
  JOIN "order" o ON o.id = pi.order_id
  WHERE pi.id = ANY($1::text[])
    AND pi.deleted_at IS NULL
  ORDER BY pi.invoice_number
`;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isOwnEvidence(value: unknown): boolean {
  if (!isValidZeroTotalEvidence(value)) return false;
  const legacy = (value as { legacy?: { plan_id?: unknown } }).legacy;
  return value.source === "legacy_backfill" && legacy?.plan_id === PLAN_ID;
}

function validateRow(target: Target, row: TargetRow): PlannedTarget {
  const label = `${target.documentNumber} / invoice ${target.invoiceNumber}`;
  invariant(row.document_number === target.documentNumber, `${label}: document mismatch`);
  invariant(Number(row.display_id) === target.displayId, `${label}: display_id mismatch`);
  invariant(row.order_id === target.orderId, `${label}: order_id mismatch`);
  invariant(row.invoice_id === target.invoiceId, `${label}: invoice_id mismatch`);
  invariant(row.invoice_number === target.invoiceNumber, `${label}: invoice number mismatch`);
  invariant(row.is_draft_order === false, `${label}: order is draft`);
  invariant(row.pos_closed !== "true", `${label}: order used manual close`);
  invariant(row.total === "0" && row.amount_paid === "0", `${label}: invoice is not exactly $0`);
  invariant(row.invoice_status === "paid", `${label}: invoice is not paid`);
  invariant(row.created_by?.trim(), `${label}: historical staff identity is missing`);
  invariant(Number(row.active_invoices) === 1, `${label}: expected exactly one active invoice`);
  invariant(Number(row.item_rows) > 0, `${label}: order has no current items`);
  invariant(Number(row.unfulfilled_items) === 0, `${label}: order is not fully fulfilled`);
  invariant(Number(row.open_credit_memos) === 0, `${label}: order has an open credit memo`);

  const hasEvidence = row.evidence !== null && row.evidence !== undefined;
  if (hasEvidence) {
    invariant(isOwnEvidence(row.evidence), `${label}: unexpected warranty evidence already exists`);
    invariant(
      row.order_status === "pending" || row.order_status === "completed",
      `${label}: stamped order has unexpected status ${row.order_status}`
    );
  } else {
    invariant(row.order_status === "pending", `${label}: unstamped order is not pending`);
  }

  return { target, row, needsWrite: !hasEvidence };
}

async function buildPlan(client: PoolClient): Promise<PlannedTarget[]> {
  const result = await client.query<TargetRow>(TARGET_SQL, [
    TARGETS.map((target) => target.invoiceId),
  ]);
  invariant(result.rows.length === TARGETS.length, `Expected ${TARGETS.length} target rows, found ${result.rows.length}`);

  const byInvoiceId = new Map(result.rows.map((row) => [row.invoice_id, row]));
  return TARGETS.map((target) => {
    const row = byInvoiceId.get(target.invoiceId);
    invariant(row, `Missing allowlisted invoice ${target.invoiceId}`);
    return validateRow(target, row);
  });
}

function printPlan(plan: PlannedTarget[], mode: "DRY-RUN" | "APPLY"): void {
  console.log(`\n[${PLAN_ID}] ${mode}`);
  for (const entry of plan) {
    console.log(JSON.stringify({
      document_number: entry.target.documentNumber,
      order_id: entry.target.orderId,
      order_status: entry.row.order_status,
      invoice_id: entry.target.invoiceId,
      invoice_number: entry.target.invoiceNumber,
      total: entry.row.total,
      amount_paid: entry.row.amount_paid,
      invoice_status: entry.row.invoice_status,
      historical_created_by: entry.row.created_by,
      active_invoices: Number(entry.row.active_invoices),
      current_items: Number(entry.row.item_rows),
      unfulfilled_items: Number(entry.row.unfulfilled_items),
      open_credit_memos: Number(entry.row.open_credit_memos),
      action: entry.needsWrite ? "stamp legacy warranty evidence" : "already stamped by this plan",
    }));
  }
  console.log(`Targets: ${plan.length}; writes: ${plan.filter((entry) => entry.needsWrite).length}\n`);
}

function evidenceFor(entry: PlannedTarget, confirmedAt: Date): LegacyEvidence {
  invariant(entry.row.created_by, `Missing created_by for ${entry.target.invoiceNumber}`);
  return {
    ...buildZeroTotalEvidence({
      confirmedBy: CONFIRMED_BY,
      source: "legacy_backfill",
      confirmedAt,
    }),
    legacy: {
      plan_id: PLAN_ID,
      document_number: entry.target.documentNumber,
      invoice_number: entry.target.invoiceNumber,
      historical_created_by: entry.row.created_by,
      historical_invoice_created_at: new Date(entry.row.created_at).toISOString(),
    },
  };
}

async function stampEvidence(client: PoolClient, plan: PlannedTarget[]): Promise<number> {
  const writes = plan.filter((entry) => entry.needsWrite);
  if (writes.length === 0) return 0;

  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PLAN_ID]);
    const lockedPlan = await buildPlan(client);
    invariant(
      lockedPlan.filter((entry) => entry.needsWrite).length === writes.length,
      "Target state changed after preview; aborting"
    );

    const confirmedAt = new Date();
    let updated = 0;
    for (const entry of lockedPlan.filter((candidate) => candidate.needsWrite)) {
      const expectedMetadata = entry.row.metadata ?? {};
      const result = await client.query(
        `UPDATE pos_invoice
            SET metadata = jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{zero_total_evidence}',
                  $2::jsonb,
                  true
                ),
                updated_at = now()
          WHERE id = $1
            AND metadata IS NOT DISTINCT FROM $3::jsonb
            AND total = 0
            AND amount_paid = 0
            AND status = 'paid'
            AND deleted_at IS NULL`,
        [
          entry.target.invoiceId,
          JSON.stringify(evidenceFor(entry, confirmedAt)),
          JSON.stringify(expectedMetadata),
        ]
      );
      invariant(result.rowCount === 1, `${entry.target.invoiceNumber}: compare-and-swap failed`);
      updated += 1;
    }
    invariant(updated === writes.length, `Expected ${writes.length} writes, applied ${updated}`);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export default async function run({ container }: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  if (apply) {
    invariant(
      process.env.WARRANTY_BACKFILL_PLAN === PLAN_ID,
      `APPLY requires WARRANTY_BACKFILL_PLAN=${PLAN_ID}`
    );
  }

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    const plan = await buildPlan(client);
    printPlan(plan, apply ? "APPLY" : "DRY-RUN");
    if (!apply) {
      console.log("DRY-RUN complete; no rows written.");
      return;
    }

    const updated = await stampEvidence(client, plan);
    console.log(`Stamped ${updated} invoice(s) in one transaction.`);

    for (const target of TARGETS) {
      const completion = await maybeCompleteOrder(container, target.orderId);
      invariant(
        completion.completed || completion.reason === "status_not_pending",
        `${target.documentNumber}: native completion failed (${completion.reason})`
      );
      console.log(`${target.documentNumber}: ${completion.completed ? "completed natively" : "already completed"}`);
    }

    const verified = await buildPlan(client);
    invariant(verified.every((entry) => !entry.needsWrite), "Postcondition failed: evidence missing");
    invariant(verified.every((entry) => entry.row.order_status === "completed"), "Postcondition failed: order not completed");
    printPlan(verified, "APPLY");
    console.log(`✅ ${PLAN_ID}: exactly two invoices stamped and two orders completed.`);
  } finally {
    client.release();
  }
}
