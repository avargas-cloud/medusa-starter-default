/**
 * src/lib/qb-backfill/apply-purchases-money.ts
 *
 * Segunda mitad de `apply-purchases.ts` (split por el límite de 300 líneas
 * del proyecto): créditos, pagos y de-adopt — la parte "dinero" de fase 3,
 * separada de la parte "documento" (receipt/bill) que se quedó en
 * `apply-purchases.ts`.
 */
import type { OpenPoLine } from "./links";
import { decideCreditCreation, createVendorCreditFromQb } from "./create-vendor-credit";
import { decidePaymentCreation, createBillPaymentFromQb, type BankAccountLookupFn } from "./create-bill-payment";
import { deAdoptBill } from "./create-bill";
import type { QbAccountLookupFn } from "./create-bill";
import type { QbBill, QbVendorCredit, QbBillPayment } from "./types";
import {
  resolveLocalPoByLinkedTxns,
  type ApplyContext,
  type DocOutcome,
  type PoIndexEntry,
  type TypeApplyReport,
} from "./apply-purchases";

function newReport(): TypeApplyReport {
  return { already: 0, create: 0, created: [], blocked: [] };
}

export async function applyCredits(
  credits: QbVendorCredit[],
  known: ReadonlySet<string>,
  poIndex: Map<string, PoIndexEntry>,
  resolveQbAccount: QbAccountLookupFn,
  ctx: ApplyContext,
  apply: boolean
): Promise<TypeApplyReport> {
  const report = newReport();
  for (const credit of credits) {
    const decision = decideCreditCreation(credit, known);
    if (decision.reason === "already") { report.already++; continue; }
    report.create++;
    if (!apply) continue;
    const localPo = resolveLocalPoByLinkedTxns(credit.linked_txns, poIndex);
    try {
      await ctx.client.query("BEGIN");
      const result = await createVendorCreditFromQb(ctx.client, credit, {
        runId: ctx.runId,
        itemIndex: ctx.itemIndex,
        ensureLog: ctx.ensureLog,
        resolveQbAccount,
        poLines: localPo?.lines ?? [],
        resolvedPoId: localPo?.id ?? null,
        vendorIndex: ctx.vendorIndex,
      });
      await ctx.client.query("COMMIT");
      report.created.push({ txn_id: credit.txn_id, created: result.vendor_credit_id });
    } catch (err) {
      await ctx.client.query("ROLLBACK");
      report.blocked.push({ txn_id: credit.txn_id, blocked_reason: (err as Error).message });
    }
  }
  return report;
}

export async function applyPayments(
  payments: QbBillPayment[],
  known: ReadonlySet<string>,
  resolveBankAccount: BankAccountLookupFn,
  ctx: ApplyContext,
  apply: boolean
): Promise<TypeApplyReport> {
  const report = newReport();
  for (const payment of payments) {
    const decision = decidePaymentCreation(payment, known);
    if (decision.reason === "already") { report.already++; continue; }
    report.create++;
    if (!apply) continue;
    try {
      const { rows: billRows } = await ctx.client.query(
        `SELECT qb_txn_id, id FROM vendor_bill WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL`
      );
      const billIdByTxnId = new Map((billRows as { qb_txn_id: string; id: string }[]).map((r) => [r.qb_txn_id, r.id]));
      const { rows: vendorRows } = await ctx.client.query(
        `SELECT id, full_name, qb_list_id FROM qb_vendor WHERE qb_list_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [payment.payee_ref?.list_id ?? ""]
      );
      const vendorRow = vendorRows[0] as { id: string; full_name: string; qb_list_id: string } | undefined;
      if (!vendorRow) throw new Error(`BillPayment ${payment.txn_id}: vendor ${payment.payee_ref?.list_id ?? "?"} no conocido`);

      await ctx.client.query("BEGIN");
      const result = await createBillPaymentFromQb(ctx.client, payment, billIdByTxnId, {
        runId: ctx.runId,
        vendorId: vendorRow.id,
        vendorNameSnapshot: vendorRow.full_name,
        vendorQbListId: vendorRow.qb_list_id,
        resolveBankAccount,
        createdByUserId: ctx.createdByUserId,
      });
      await ctx.client.query("COMMIT");
      report.created.push({ txn_id: payment.txn_id, created: result.vendor_bill_payment_id });
    } catch (err) {
      await ctx.client.query("ROLLBACK").catch(() => undefined);
      const reason = (err as { blockReason?: string }).blockReason ?? (err as Error).message;
      report.blocked.push({ txn_id: payment.txn_id, blocked_reason: reason });
    }
  }
  return report;
}

export interface DeAdoptReport {
  total_adopted: number;
  de_adopted: number;
  lines_added_total: number;
  blocked: DocOutcome[];
}

export async function applyDeAdopt(
  bills: QbBill[],
  ctx: ApplyContext,
  resolveQbAccount: QbAccountLookupFn
): Promise<DeAdoptReport> {
  const report: DeAdoptReport = { total_adopted: bills.length, de_adopted: 0, lines_added_total: 0, blocked: [] };
  for (const bill of bills) {
    try {
      const { rows: billRows } = await ctx.client.query(
        `SELECT id, purchase_order_id FROM vendor_bill WHERE qb_txn_id = $1 AND qb_source = 'adopted' AND deleted_at IS NULL LIMIT 1`,
        [bill.txn_id]
      );
      const billRow = billRows[0] as { id: string; purchase_order_id: string | null } | undefined;
      if (!billRow) throw new Error(`bill local no encontrado (o ya no adoptado) para TxnID ${bill.txn_id}`);

      const { rows: lineCountRows } = await ctx.client.query(
        `SELECT count(*)::int AS n FROM vendor_bill_line WHERE vendor_bill_id = $1 AND deleted_at IS NULL`,
        [billRow.id]
      );
      const hasExistingLines = ((lineCountRows[0] as { n: number }).n) > 0;

      let poLines: OpenPoLine[] = [];
      if (billRow.purchase_order_id) {
        const { rows: lineRows } = await ctx.client.query(
          `SELECT id, product_variant_id, qty_ordered FROM purchase_order_line WHERE purchase_order_id = $1 AND deleted_at IS NULL ORDER BY line_order ASC, id ASC`,
          [billRow.purchase_order_id]
        );
        poLines = (lineRows as { id: string; product_variant_id: string | null; qty_ordered: string | number }[]).map((r) => ({
          id: r.id,
          product_variant_id: r.product_variant_id,
          qty_ordered: Number(r.qty_ordered),
          already_matched: 0,
        }));
      }

      await ctx.client.query("BEGIN");
      const result = await deAdoptBill(ctx.client, bill, {
        vendorBillId: billRow.id,
        hasExistingLines,
        runId: ctx.runId,
        itemIndex: ctx.itemIndex,
        ensureLog: ctx.ensureLog,
        resolveQbAccount,
        poLines,
      });
      await ctx.client.query("COMMIT");
      report.de_adopted++;
      report.lines_added_total += result.lines_added;
    } catch (err) {
      await ctx.client.query("ROLLBACK").catch(() => undefined);
      report.blocked.push({ txn_id: bill.txn_id, blocked_reason: (err as Error).message });
    }
  }
  return report;
}
