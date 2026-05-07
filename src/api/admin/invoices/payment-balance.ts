import { FINANCE_MODULE } from "../../../modules/finance";
import { INVOICE_MODULE } from "../../../modules/invoices";

export function getNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return Number(val);
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.toNumber === "function")
      return (obj.toNumber as () => number)();
    if (obj.numeric !== undefined) return Number(obj.numeric);
    if (obj.value !== undefined) return Number(obj.value);
  }
  return Number(val) || 0;
}

export async function getAppliedInvoiceTotal(
  scope: { resolve: (key: string) => any },
  invoiceId: string
): Promise<number> {
  const financeService = scope.resolve(FINANCE_MODULE);
  const invoiceService = scope.resolve(INVOICE_MODULE);

  const applications = await financeService
    .listPaymentApplications({ invoice_id: invoiceId })
    .catch(() => [] as any[]);

  const activeApplicationTotal = applications
    .filter((app: any) => !app.voided_at)
    .reduce((sum: number, app: any) => sum + getNum(app.amount_applied), 0);

  if (activeApplicationTotal > 0) {
    return activeApplicationTotal;
  }

  const payments = await invoiceService
    .listInvoicePayments({ invoice_id: invoiceId })
    .catch(() => [] as any[]);

  return payments.reduce(
    (sum: number, payment: any) => sum + getNum(payment.amount),
    0
  );
}

export async function updateInvoicePaymentBalance(
  scope: { resolve: (key: string) => any },
  invoice: { id: string; total: unknown; status?: string | null },
  extraUpdates: Record<string, unknown> = {}
) {
  const invoiceService = scope.resolve(INVOICE_MODULE);
  const totalPaid = await getAppliedInvoiceTotal(scope, invoice.id);
  const balanceDue = Math.max(0, getNum(invoice.total) - totalPaid);
  const status =
    totalPaid <= 0 ? "issued" : balanceDue <= 0 ? "paid" : "partial";

  await invoiceService.updatePosInvoices({
    id: invoice.id,
    amount_paid: totalPaid,
    balance_due: balanceDue,
    status,
    ...extraUpdates,
  });

  return { totalPaid, balanceDue, status };
}
