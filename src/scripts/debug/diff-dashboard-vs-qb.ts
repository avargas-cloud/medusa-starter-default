import { ExecArgs } from "@medusajs/framework/types";
import { INVOICE_MODULE } from "../../modules/invoices";
import { CREDIT_MEMO_MODULE } from "../../modules/credit_memos";

export default async function diffDashboardVsQb({ container }: ExecArgs) {
  const invoiceService: any = container.resolve(INVOICE_MODULE);
  const cmService: any = container.resolve(CREDIT_MEMO_MODULE);

  // Compute the same range the dashboard uses (browser-local startOfDay → toISOString).
  // The script runs on the server so we use America/New_York as Alejo's local TZ.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  const todayStartNY = new Date(`${y}-${m}-${d}T04:00:00.000Z`); // EDT
  const todayEndNY = new Date(todayStartNY.getTime() + 24 * 3600 * 1000 - 1);

  console.log("range_from:", todayStartNY.toISOString());
  console.log("range_to  :", todayEndNY.toISOString());

  const filters: any = {
    status: ["issued", "partial", "paid"],
    created_at: { $gte: todayStartNY.toISOString(), $lte: todayEndNY.toISOString() },
  };
  const invoices = await invoiceService.listPosInvoices(filters, {
    take: 500,
    order: { created_at: "DESC" },
  });

  const byStatus: Record<string, { n: number; untaxed: number; total: number }> = {};
  let gross = 0;
  for (const o of invoices) {
    const u = Number(o.untaxed_total ?? o.total ?? 0);
    const t = Number(o.total ?? 0);
    gross += u;
    byStatus[o.status] ??= { n: 0, untaxed: 0, total: 0 };
    byStatus[o.status].n++;
    byStatus[o.status].untaxed += u;
    byStatus[o.status].total += t;
  }

  console.log("\n── Invoices returned by dashboard fetch ──");
  console.log("count:", invoices.length);
  for (const [s, v] of Object.entries(byStatus)) {
    console.log(`  ${s}: n=${v.n} untaxed=$${(v.untaxed / 100).toFixed(2)} total=$${(v.total / 100).toFixed(2)}`);
  }
  console.log("gross_revenue (untaxed/100):", (gross / 100).toFixed(2));

  console.log("\n── Per-invoice list ──");
  for (const o of invoices) {
    console.log(
      `  #${o.invoice_number} status=${o.status} untaxed=$${(Number(o.untaxed_total) / 100).toFixed(2)} total=$${(Number(o.total) / 100).toFixed(2)} created=${o.created_at}`
    );
  }

  // Credit memos
  const [cms] = await cmService.listAndCountPosCreditMemos({}, { take: 500 });
  const todayCMs = cms.filter((m: any) => {
    if (m.status !== "completed") return false;
    const t = new Date(m.created_at).getTime();
    return t >= todayStartNY.getTime() && t <= todayEndNY.getTime();
  });
  let returns = 0;
  for (const m of todayCMs) {
    const total = (Number(m.total) || 0) / 100;
    const tax = (Number(m.tax) || 0) / 100;
    const shipping = (Number(m.shipping) || 0) / 100;
    const sub = m.subtotal != null ? (Number(m.subtotal) || 0) / 100 : Math.max(0, total - tax - shipping);
    returns += sub;
    console.log(`  CM ${m.credit_memo_number} status=${m.status} subtotal_used=$${sub.toFixed(2)} created=${m.created_at}`);
  }
  console.log("\nreturns_total:", returns.toFixed(2));
  console.log("REVENUE_TODAY (gross - returns):", ((gross / 100) - returns).toFixed(2));
}
