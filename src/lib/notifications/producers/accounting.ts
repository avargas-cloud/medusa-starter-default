/**
 * Pendientes de Accounting → Accounting (user 09/17: "commission request etc,
 * SI a accounting"). Tres hechos que ya existen como filas; el job las observa
 * (últimas 24 h) y avisa UNA vez por entidad:
 *   · commission_request.status = 'pending'          → /accounting/commissions
 *   · price_change_batch.status = 'submitted'        → /accounting/price-approvals/:id
 *   · customer_payment refunded / partial_refunded   → /accounting/refunds
 *     (la pantalla de Refunds lista exactamente esos: "necesitan Write Check en QB")
 */

import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { centsToUsd, truncate } from "./format";

export const ACCOUNTING_WINDOW_HOURS_DEFAULT = 24;

interface CommissionRow {
  id: string;
  order_id: string;
  display_name: string;
  document_number: string | null;
  display_id: number | null;
  requested_at: string | Date | null;
}

interface PriceBatchRow {
  id: string;
  display_number: string | null;
  line_count: number | null;
  created_by_email: string | null;
  note: string | null;
  submitted_at: string | Date | null;
}

interface RefundRow {
  id: string;
  display_id: number | null;
  amount: string | number;
  status: string;
  updated_at: string | Date | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

const COMMISSION_SQL = `
  SELECT cr.id, cr.order_id, cr.display_name, cr.requested_at,
         o.display_id, o.metadata->>'document_number' AS document_number
    FROM commission_request cr
    LEFT JOIN "order" o ON o.id = cr.order_id
   WHERE cr.status = 'pending' AND cr.deleted_at IS NULL
     AND cr.requested_at > NOW() - ($1::int * INTERVAL '1 hour')
     AND NOT EXISTS (SELECT 1 FROM pos_notification n WHERE n.dedupe_key = 'commission_request:' || cr.id)
   ORDER BY cr.requested_at ASC
   LIMIT 100`;

const PRICE_BATCH_SQL = `
  SELECT b.id, b.display_number, b.line_count, b.created_by_email, b.note, b.submitted_at
    FROM price_change_batch b
   WHERE b.status = 'submitted' AND b.deleted_at IS NULL
     AND COALESCE(b.submitted_at, b.updated_at) > NOW() - ($1::int * INTERVAL '1 hour')
     AND NOT EXISTS (SELECT 1 FROM pos_notification n WHERE n.dedupe_key = 'price_batch:' || b.id)
   ORDER BY b.submitted_at ASC
   LIMIT 100`;

const REFUND_SQL = `
  SELECT cp.id, cp.display_id, cp.amount, cp.status, cp.updated_at,
         c.company_name, c.first_name, c.last_name
    FROM customer_payment cp
    LEFT JOIN customer c ON c.id = cp.customer_id
   WHERE cp.deleted_at IS NULL
     AND cp.type <> 'refund'
     AND cp.status IN ('refunded', 'partial_refunded')
     AND cp.updated_at > NOW() - ($1::int * INTERVAL '1 hour')
     AND NOT EXISTS (SELECT 1 FROM pos_notification n WHERE n.dedupe_key = 'refund_pending:' || cp.id)
   ORDER BY cp.updated_at ASC
   LIMIT 100`;

export function buildCommissionNotification(r: CommissionRow) {
  const doc = r.document_number ?? (r.display_id ? `#${r.display_id}` : r.order_id);
  return {
    kind: "commission_request_pending" as const,
    severity: "info" as const,
    title: `Commission request — ${truncate(r.display_name, 60)} on ${doc}`,
    body: "Pending your review in Accounting → Commissions",
    action_url: "/accounting/commissions",
    entity_type: "commission_request",
    entity_id: r.id,
    payload: { order_id: r.order_id },
    dedupe_key: `commission_request:${r.id}`,
    occurred_at: r.requested_at,
    audiences: [{ kind: "accounting" as const }],
  };
}

export function buildPriceBatchNotification(b: PriceBatchRow) {
  const label = b.display_number ?? b.id;
  const lines = b.line_count === 1 ? "1 line" : `${b.line_count ?? 0} lines`;
  return {
    kind: "price_batch_submitted" as const,
    severity: "info" as const,
    title: `Price approval requested — ${label} (${lines})`,
    body: [b.created_by_email, truncate(b.note, 120)].filter(Boolean).join(" · ") || "Pending approval",
    action_url: `/accounting/price-approvals/${b.id}`,
    entity_type: "price_change_batch",
    entity_id: b.id,
    payload: { line_count: b.line_count },
    dedupe_key: `price_batch:${b.id}`,
    occurred_at: b.submitted_at,
    audiences: [{ kind: "accounting" as const }],
  };
}

export function buildRefundNotification(r: RefundRow) {
  const who = (r.company_name ?? "").trim() || `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Customer";
  return {
    kind: "refund_pending" as const,
    severity: "warning" as const,
    title: `Refund pending QB check — ${centsToUsd(r.amount)} · PAY-${r.display_id ?? "?"}`,
    body: `${who} · ${r.status === "partial_refunded" ? "partial refund" : "full refund"} — needs a Write Check in Accounting → Refunds`,
    action_url: "/accounting/refunds",
    entity_type: "customer_payment",
    entity_id: r.id,
    payload: { status: r.status },
    dedupe_key: `refund_pending:${r.id}`,
    occurred_at: r.updated_at,
    audiences: [{ kind: "accounting" as const }],
  };
}

export async function produceAccountingNotifications(
  db: Db,
  opts: { windowHours?: number } = {}
): Promise<{ scanned: number; created: number; results: PublishResult[] }> {
  const hours = opts.windowHours ?? ACCOUNTING_WINDOW_HOURS_DEFAULT;
  const [commissions, batches, refunds] = await Promise.all([
    db.query<CommissionRow>(COMMISSION_SQL, [hours]),
    db.query<PriceBatchRow>(PRICE_BATCH_SQL, [hours]),
    db.query<RefundRow>(REFUND_SQL, [hours]),
  ]);
  const results: PublishResult[] = [];
  for (const r of commissions.rows) results.push(await publishNotification(db, buildCommissionNotification(r)));
  for (const b of batches.rows) results.push(await publishNotification(db, buildPriceBatchNotification(b)));
  for (const r of refunds.rows) results.push(await publishNotification(db, buildRefundNotification(r)));
  const scanned = commissions.rows.length + batches.rows.length + refunds.rows.length;
  return { scanned, created: results.filter((r) => r.created).length, results };
}
