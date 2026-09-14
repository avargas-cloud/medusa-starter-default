import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import { getBusinessDateString } from "../../../../../lib/date/et";
import { getDbPool } from "../../../../utils/db-pool";
import { activeEntryPredicate } from "../../../../../lib/ledger/reports";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res
      .status(error.status)
      .json({ error: error.message, code: error.code });
  }
  throw error;
}

interface MapRow {
  key: string;
  qb_list_id: string | null;
  name: string | null;
}

interface MonthRow {
  month: string;
  net_cents: string;
}

interface PaymentCountRow {
  month: string;
  count: string;
}

/**
 * GET: monthly totals of the `credit_card_surcharge` income line and the
 * `merchant_fees` expense line (2026-09-14 plan), plus how many customer
 * payments carried a surcharge that month. Either key can be unmapped in an
 * environment that hasn't seeded `gl_account_map` yet — that series comes
 * back all zeros with `mapped:false`, never an error (same posture as
 * `buildCustomerPaymentLines` on a plain, surcharge-free payment).
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const yearStart = `${getBusinessDateString().slice(0, 4)}-01-01`;
  const from = String(req.query.from ?? yearStart);
  const to = String(req.query.to ?? getBusinessDateString());
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    return res.status(400).json({
      error: "from and to are required in YYYY-MM-DD format, with from <= to",
      code: "invalid_range",
    });
  }

  const pool = getDbPool();

  const mapResult = await pool.query<MapRow>(
    `SELECT m.key, m.qb_list_id, a.name
       FROM gl_account_map m
       LEFT JOIN qb_account a ON a.qb_list_id = m.qb_list_id AND a.deleted_at IS NULL AND a.is_active
      WHERE m.key = ANY($1::text[])`,
    [["credit_card_surcharge", "merchant_fees"]]
  );
  const byKey = new Map(mapResult.rows.map((row) => [row.key, row]));
  const surchargeListId = byKey.get("credit_card_surcharge")?.qb_list_id ?? null;
  const feesListId = byKey.get("merchant_fees")?.qb_list_id ?? null;

  const monthlyFor = async (
    listId: string | null,
    sign: "credit_minus_debit" | "debit_minus_credit"
  ): Promise<Map<string, bigint>> => {
    const result = new Map<string, bigint>();
    if (!listId) return result;
    const expr =
      sign === "credit_minus_debit"
        ? "SUM(l.credit_cents) - SUM(l.debit_cents)"
        : "SUM(l.debit_cents) - SUM(l.credit_cents)";
    const { rows } = await pool.query<MonthRow>(
      `SELECT to_char(e.day::date,'YYYY-MM') AS month, (${expr})::text AS net_cents
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")}
          AND l.account_list_id = $1 AND e.day >= $2 AND e.day <= $3
        GROUP BY month`,
      [listId, from, to]
    );
    for (const row of rows) result.set(row.month, BigInt(row.net_cents));
    return result;
  };

  const [surchargeByMonth, feesByMonth, paymentsResult] = await Promise.all([
    monthlyFor(surchargeListId, "credit_minus_debit"),
    monthlyFor(feesListId, "debit_minus_credit"),
    pool.query<PaymentCountRow>(
      `SELECT to_char((received_at AT TIME ZONE 'America/New_York')::date,'YYYY-MM') AS month,
              COUNT(*)::text AS count
         FROM customer_payment
        WHERE deleted_at IS NULL AND COALESCE(surcharge_cents,0) > 0
          AND (received_at AT TIME ZONE 'America/New_York')::date >= $1
          AND (received_at AT TIME ZONE 'America/New_York')::date <= $2
        GROUP BY month`,
      [from, to]
    ),
  ]);

  const paymentsByMonth = new Map(
    paymentsResult.rows.map((row) => [row.month, Number(row.count)])
  );

  const months = new Set<string>([
    ...surchargeByMonth.keys(),
    ...feesByMonth.keys(),
    ...paymentsByMonth.keys(),
  ]);

  const monthList = [...months].sort().map((month) => {
    const surchargeCents = surchargeByMonth.get(month) ?? 0n;
    const merchantFeesCents = feesByMonth.get(month) ?? 0n;
    return {
      month,
      surcharge_cents: surchargeCents.toString(),
      merchant_fees_cents: merchantFeesCents.toString(),
      net_cents: (surchargeCents - merchantFeesCents).toString(),
      surcharge_payments: paymentsByMonth.get(month) ?? 0,
    };
  });

  const accountInfo = (key: "credit_card_surcharge" | "merchant_fees") => {
    const row = byKey.get(key);
    return {
      mapped: Boolean(row?.qb_list_id),
      qb_list_id: row?.qb_list_id ?? null,
      name: row?.name ?? null,
    };
  };

  return res.json({
    months: monthList,
    accounts: {
      credit_card_surcharge: accountInfo("credit_card_surcharge"),
      merchant_fees: accountInfo("merchant_fees"),
    },
  });
}
