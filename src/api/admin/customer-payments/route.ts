/**
 * GET  /admin/customer-payments  — list all customer payments (enriched with customer info)
 * POST /admin/customer-payments  — create a standalone payment (status: available)
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { FINANCE_MODULE } from "../../../modules/finance";

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapMethod(method: string): any {
  if (
    [
      "visa",
      "mastercard",
      "discover",
      "amex",
      "capital_one",
      "debit_card",
    ].includes(method)
  )
    return "card";
  if (
    ["e_check", "checking_account", "transfer", "wire_transfer"].includes(
      method
    )
  )
    return "ach";
  if (["paypal", "money_order"].includes(method)) return "other";
  if (method === "credit") return "credit_memo";
  if (["cash", "check", "zelle"].includes(method)) return method;
  return "other";
}

async function enrichWithCustomer(payments: any[], customerModule: any) {
  if (!payments.length) return payments;
  const customerIds = [
    ...new Set(payments.map((p) => p.customer_id).filter(Boolean)),
  ];
  const customerMap: Record<string, any> = {};
  try {
    const customers = await customerModule.listCustomers(
      { id: customerIds },
      {
        select: [
          "id",
          "first_name",
          "last_name",
          "email",
          "phone",
          "company_name",
        ],
      }
    );
    customers.forEach((c: any) => {
      customerMap[c.id] = c;
    });
  } catch {
    /* non-fatal */
  }

  return payments.map((p) => ({
    ...p,
    customer: customerMap[p.customer_id] ?? null,
  }));
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const customerModule = req.scope.resolve(Modules.CUSTOMER);

  const query = (req.query ?? {}) as Record<
    string,
    string | string[] | undefined
  >;
  const customerIdParam = Array.isArray(query.customer_id)
    ? query.customer_id[0]
    : query.customer_id;
  const limitParam = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  const parsedLimit = limitParam
    ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 0))
    : undefined;
  const searchParam = Array.isArray(query.q) ? query.q[0] : query.q;
  const trimmedSearch = (searchParam ?? "").trim();

  const filters: Record<string, unknown> = {};
  if (customerIdParam) filters.customer_id = customerIdParam;

  // ── Optional search (q): match by customer name/email/company/phone or payment reference ──
  if (trimmedSearch) {
    const like = `%${trimmedSearch}%`;
    const digits = trimmedSearch.replace(/[^\d]/g, "");
    const orClauses: Record<string, unknown>[] = [
      { first_name: { $ilike: like } },
      { last_name: { $ilike: like } },
      { email: { $ilike: like } },
      { company_name: { $ilike: like } },
    ];
    if (digits.length >= 3) {
      orClauses.push({ phone: { $ilike: `%${digits}%` } });
    }
    let matchedCustomerIds: string[] = [];
    try {
      const matchedCustomers = await customerModule.listCustomers(
        { $or: orClauses } as any,
        { select: ["id"], take: 500 }
      );
      matchedCustomerIds = matchedCustomers.map((c: any) => c.id);
    } catch {
      /* non-fatal */
    }
    const paymentOr: Record<string, unknown>[] = [
      { reference: { $ilike: like } },
    ];
    if (matchedCustomerIds.length) {
      paymentOr.push({ customer_id: matchedCustomerIds });
    }
    // Exact match on the human-facing "Payment #" (display_id is numeric —
    // ILIKE isn't valid on an integer column in Postgres).
    if (/^\d+$/.test(trimmedSearch)) {
      paymentOr.push({ display_id: parseInt(trimmedSearch, 10) });
    }
    filters.$or = paymentOr;
  }

  try {
    const payments = await financeService.listCustomerPayments(filters, {
      order: { received_at: "DESC" },
      relations: ["applications"],
      ...(parsedLimit ? { take: parsedLimit } : {}),
    });

    const enriched = await enrichWithCustomer(payments, customerModule);

    // Compute available_balance and amount_applied for each payment
    const result = enriched.map((p: any) => {
      const applications: any[] = p.applications ?? [];
      const activeApplications = applications.filter((a: any) => !a.voided_at);
      const amountApplied = activeApplications.reduce(
        (sum: number, a: any) => sum + Number(a.amount_applied ?? 0),
        0
      );
      const availableBalance = Math.max(0, Number(p.amount) - amountApplied);
      return {
        ...p,
        amount_applied: amountApplied,
        available_balance: availableBalance,
      };
    });

    return res.json({ payments: result, count: result.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const financeService = req.scope.resolve(FINANCE_MODULE);
  const {
    customer_id,
    amount,
    method,
    reference,
    notes,
    received_at,
    created_by,
  } = req.body as any;

  if (!customer_id)
    return res.status(400).json({ error: "customer_id is required" });
  if (!amount || amount <= 0)
    return res
      .status(400)
      .json({ error: "amount must be positive (in cents)" });
  if (!method) return res.status(400).json({ error: "method is required" });

  try {
    const payment = await financeService.createCustomerPayments({
      customer_id,
      amount,
      method: mapMethod(method),
      reference: reference ?? null,
      notes: notes ?? null,
      received_at: received_at ? new Date(received_at) : new Date(),
      created_by: created_by ?? null,
      source: "pos",
      type: "payment",
      status: "available", // standalone — not yet applied to any invoice
      medusa_payment_synced: false,
    });

    return res.status(201).json({ payment });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
