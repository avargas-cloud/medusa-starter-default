/**
 * src/lib/qb-backfill/sales-report.ts
 *
 * Formato de reporte de `backfill-qb-sales.ts` (fase 2: clasificación) —
 * separado del driver para mantenerlo bajo el límite de 300 líneas del
 * proyecto. Sólo IMPRIME y agrega; no clasifica (eso es `sales-classify.ts`)
 * ni resuelve nada contra la DB (`sales-resolve.ts`).
 */
import { classifySalesLine } from "./sales-resolve";
import { resolveCustomerRef } from "./sales-resolve";
import type { CustomerIndex } from "./sales-resolve";
import type { ItemIndex } from "./resolve";
import type { ClassifyBucketResult, SalesClassification } from "./sales-classify";
import type { QbCreditMemo, QbInvoice, QbReceivePayment, QbSalesLine, QbSalesReceipt } from "./sales-types";
import type { QbRef } from "./types";

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function reasonCounts(blocked: { txn_id: string; reason: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of blocked) out[b.reason] = (out[b.reason] ?? 0) + 1;
  return out;
}

function reportType<T extends { txn_id: string }>(
  log: (s: string) => void,
  label: string,
  result: ClassifyBucketResult<T>,
  totalCentsOf: (doc: T) => number
): void {
  const totalCents = result.create.reduce((acc, d) => acc + totalCentsOf(d), 0);
  log(`${label}: ya conocidos ${result.already} · a crear ${result.create.length} (US$ ${dollars(totalCents)}) · bloqueados ${result.blocked.length}`);
  const reasons = reasonCounts(result.blocked);
  for (const [reason, n] of Object.entries(reasons)) log(`  bloqueados por ${reason}: ${n}`);
}

/** Cuenta customer_ref sin resolver (`create` bucket, por tipo) y arma la lista de nombres para el reporte. */
function collectUnresolvedCustomers(
  customerIndex: CustomerIndex,
  refs: (QbRef | null)[]
): { count: number; names: string[] } {
  const unresolved: string[] = [];
  for (const ref of refs) {
    if (ref && !resolveCustomerRef(customerIndex, ref)) unresolved.push(ref.full_name);
  }
  return { count: unresolved.length, names: unresolved };
}

/** Cuenta líneas `unknown_item` (`create` bucket, por tipo) y arma la lista de nombres. */
function collectUnknownItems(itemIndex: ItemIndex, lineGroups: QbSalesLine[][]): { count: number; names: string[] } {
  const names: string[] = [];
  for (const lines of lineGroups) {
    let running = 0;
    for (const line of lines) {
      const classified = classifySalesLine(line, itemIndex, running);
      running += line.amount_cents;
      if (classified.kind === "unknown_item") names.push(line.item_ref?.full_name ?? "(sin ItemRef)");
    }
  }
  return { count: names.length, names };
}

export function printSalesClassificationReport(
  log: (s: string) => void,
  classification: SalesClassification,
  customerIndex: CustomerIndex,
  itemIndex: ItemIndex
): void {
  log("\n── Clasificación (fase 2) ──");
  reportType<QbInvoice>(log, "Invoices", classification.invoices, (d) => d.subtotal_cents + d.sales_tax_total_cents);
  reportType<QbSalesReceipt>(log, "Sales Receipts", classification.sales_receipts, (d) => d.total_amount_cents);
  reportType<QbReceivePayment>(log, "Payments", classification.payments, (d) => d.total_amount_cents);
  reportType<QbCreditMemo>(log, "Credit Memos", classification.credit_memos, (d) => d.total_amount_cents);

  const customerRefs = [
    ...classification.invoices.create.map((d) => d.customer_ref),
    ...classification.sales_receipts.create.map((d) => d.customer_ref),
    ...classification.payments.create.map((d) => d.customer_ref),
    ...classification.credit_memos.create.map((d) => d.customer_ref),
  ];
  const customers = collectUnresolvedCustomers(customerIndex, customerRefs);
  log(`\nClientes sin resolver: ${customers.count} (todos los crearía ensureCustomer)`);
  for (const n of customers.names.slice(0, 10)) log(`  ${n}`);

  const items = collectUnknownItems(itemIndex, [
    ...classification.invoices.create.map((d) => d.lines),
    ...classification.sales_receipts.create.map((d) => d.lines),
    ...classification.credit_memos.create.map((d) => d.lines),
  ]);
  log(`\nÍtems sin resolver (unknown_item): ${items.count}`);
  for (const n of items.names.slice(0, 10)) log(`  ${n}`);
}
