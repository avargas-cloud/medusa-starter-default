import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  buildHierarchy,
  normalizeSign,
  plSectionFor,
  pruneZeroRows,
  sumRoots,
  sumRootsCompare,
  type HierarchyInput,
  type HierarchyRow,
  type PlSection,
} from "../../../../../lib/ledger/reports";
import { loadAccountBalances } from "../../../../../lib/ledger/reports/account-balances";
import {
  dbFrom,
  invalidRange,
  isDay,
  queryString,
  requireAccountingOr403,
} from "../../../../../lib/ledger/reports/route-common";

interface SectionOut {
  rows: Array<{
    list_id: string;
    account_number: string | null;
    name: string;
    full_name: string;
    depth: number;
    cents: string;
    compare_cents: string | null;
    /** Postings on the account itself — `cents` minus its children ("– Other"). */
    own_cents: string;
    own_compare_cents: string | null;
    has_children: boolean;
  }>;
  total_cents: string;
  compare_total_cents: string | null;
}

interface ComputedOut {
  total_cents: string;
  compare_total_cents: string | null;
}

function serialize(rows: HierarchyRow[]): SectionOut {
  return {
    rows: rows.map((r) => ({
      list_id: r.list_id,
      account_number: r.account_number,
      name: r.name,
      full_name: r.full_name,
      depth: r.depth,
      cents: r.cents.toString(),
      compare_cents:
        r.compare_cents === null ? null : r.compare_cents.toString(),
      own_cents: r.own_cents.toString(),
      own_compare_cents:
        r.own_compare_cents === null ? null : r.own_compare_cents.toString(),
      has_children: r.has_children,
    })),
    total_cents: sumRoots(rows).toString(),
    compare_total_cents: sumRootsCompare(rows)?.toString() ?? null,
  };
}

function computed(main: bigint, compare: bigint | null): ComputedOut {
  return {
    total_cents: main.toString(),
    compare_total_cents: compare?.toString() ?? null,
  };
}

/**
 * Profit & loss over `[from, to]`, optional `[compare_from, compare_to]`.
 * Sign convention: Income/OtherIncome positive when credit balance,
 * Expense/COGS/OtherExpense positive when debit balance (`normalizeSign`).
 * Hierarchy by `parent_list_id` with `parent_full_name` fallback; a parent
 * row shows its subtotal and section totals sum ROOT rows only. Accounts
 * with zero movement in both windows are omitted; `?include_zero=true`
 * keeps them. `basis` accepts only `journal` (the GL is the book).
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await requireAccountingOr403(req, res))) return;

  const from = queryString(req, "from");
  const to = queryString(req, "to");
  if (!isDay(from) || !isDay(to) || from > to) return invalidRange(res);

  const compareFrom = queryString(req, "compare_from");
  const compareTo = queryString(req, "compare_to");
  const hasCompare = compareFrom !== null || compareTo !== null;
  if (
    hasCompare &&
    (!isDay(compareFrom) || !isDay(compareTo) || compareFrom > compareTo)
  ) {
    return invalidRange(res, "compare_from and compare_to");
  }
  const basis = queryString(req, "basis") ?? "journal";
  if (basis !== "journal") {
    return res
      .status(400)
      .json({ error: "basis must be 'journal'", code: "invalid_basis" });
  }
  const includeZero = queryString(req, "include_zero") === "true";

  const balances = await loadAccountBalances(
    dbFrom(req),
    { from, to },
    hasCompare && isDay(compareFrom) && isDay(compareTo)
      ? { from: compareFrom, to: compareTo }
      : null
  );

  const inputs = new Map<PlSection, HierarchyInput[]>();
  for (const row of balances) {
    const section = plSectionFor(row.account_type);
    if (!section) continue;
    const cents = normalizeSign(BigInt(row.raw_cents), row.account_type);
    const compareCents = hasCompare
      ? normalizeSign(BigInt(row.compare_raw_cents), row.account_type)
      : null;
    inputs.set(section, [
      ...(inputs.get(section) ?? []),
      {
        list_id: row.list_id,
        name: row.name,
        full_name: row.full_name,
        account_number: row.account_number,
        parent_list_id: row.parent_list_id,
        parent_full_name: row.parent_full_name,
        cents,
        compare_cents: compareCents,
      },
    ]);
  }

  const section = (key: PlSection): SectionOut => {
    const tree = buildHierarchy(inputs.get(key) ?? []);
    return serialize(includeZero ? tree : pruneZeroRows(tree));
  };

  const income = section("income");
  const cogs = section("cogs");
  const expenses = section("expenses");
  const otherIncome = section("other_income");
  const otherExpense = section("other_expense");

  const big = (s: SectionOut) => BigInt(s.total_cents);
  const bigCompare = (s: SectionOut) =>
    s.compare_total_cents === null ? null : BigInt(s.compare_total_cents);
  const sub = (a: bigint | null, b: bigint | null) =>
    a === null || b === null ? null : a - b;
  const add = (a: bigint | null, b: bigint | null) =>
    a === null || b === null ? null : a + b;

  const grossProfit = big(income) - big(cogs);
  const grossProfitCompare = sub(bigCompare(income), bigCompare(cogs));
  const netOperating = grossProfit - big(expenses);
  const netOperatingCompare = sub(grossProfitCompare, bigCompare(expenses));
  const netIncome = netOperating + big(otherIncome) - big(otherExpense);
  const netIncomeCompare = sub(
    add(netOperatingCompare, bigCompare(otherIncome)),
    bigCompare(otherExpense)
  );

  return res.json({
    from,
    to,
    compare_from: hasCompare ? compareFrom : null,
    compare_to: hasCompare ? compareTo : null,
    basis,
    income,
    cogs,
    gross_profit: computed(grossProfit, grossProfitCompare),
    expenses,
    net_operating_income: computed(netOperating, netOperatingCompare),
    other_income: otherIncome,
    other_expense: otherExpense,
    net_income: computed(netIncome, netIncomeCompare),
  });
}
