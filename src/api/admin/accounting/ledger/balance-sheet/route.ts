import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  bsSectionFor,
  buildHierarchy,
  isProfitLossType,
  normalizeSign,
  pruneZeroRows,
  sumRoots,
  sumRootsCompare,
  type BsSection,
  type HierarchyInput,
  type HierarchyRow,
} from "../../../../../lib/ledger/reports";
import {
  loadAccountBalances,
  type AccountBalanceRow,
} from "../../../../../lib/ledger/reports/account-balances";
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

const str = (v: bigint | null): string | null =>
  v === null ? null : v.toString();

/** Net income (credit-positive) = Σ(credit − debit) over the P&L accounts. */
function netIncomeOf(
  rows: AccountBalanceRow[],
  pick: (r: AccountBalanceRow) => string
): bigint {
  return rows
    .filter((r) => isProfitLossType(r.account_type))
    .reduce((acc, r) => acc - BigInt(pick(r)), 0n);
}

/**
 * Balance sheet as of `as_of` (optional `compare_as_of`). Assets positive on
 * the debit side, liabilities/equity positive on the credit side.
 * `retained_earnings_cents` = net income of every fiscal year before the
 * year of `as_of`; `net_income_cents` = year-to-date. A `year_close`
 * document moves the closed year out of the P&L accounts into the retained
 * earnings EQUITY row, so it is excluded from year-to-date and the computed
 * retained earnings is what is left in the P&L accounts before the year —
 * closed years count once, on the equity row, never twice.
 */
export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  if (!(await requireAccountingOr403(req, res))) return;

  const asOf = queryString(req, "as_of");
  if (!isDay(asOf)) return invalidRange(res, "as_of");
  const compareAsOf = queryString(req, "compare_as_of");
  if (compareAsOf !== null && !isDay(compareAsOf))
    return invalidRange(res, "compare_as_of");
  const includeZero = queryString(req, "include_zero") === "true";

  const db = dbFrom(req);
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const compareYearStart = compareAsOf
    ? `${compareAsOf.slice(0, 4)}-01-01`
    : null;

  const [cumulative, yearToDate] = await Promise.all([
    loadAccountBalances(
      db,
      { from: null, to: asOf },
      compareAsOf ? { from: null, to: compareAsOf } : null
    ),
    loadAccountBalances(
      db,
      { from: yearStart, to: asOf },
      compareAsOf && compareYearStart
        ? { from: compareYearStart, to: compareAsOf }
        : null,
      "AND COALESCE(e.source_kind, '') <> 'year_close'"
    ),
  ]);

  const inputs = new Map<BsSection, HierarchyInput[]>();
  for (const row of cumulative) {
    const section = bsSectionFor(row.account_type);
    if (!section) continue;
    inputs.set(section, [
      ...(inputs.get(section) ?? []),
      {
        list_id: row.list_id,
        name: row.name,
        full_name: row.full_name,
        account_number: row.account_number,
        parent_list_id: row.parent_list_id,
        parent_full_name: row.parent_full_name,
        cents: normalizeSign(BigInt(row.raw_cents), row.account_type),
        compare_cents: compareAsOf
          ? normalizeSign(BigInt(row.compare_raw_cents), row.account_type)
          : null,
      },
    ]);
  }
  const section = (key: BsSection): SectionOut => {
    const tree = buildHierarchy(inputs.get(key) ?? []);
    return serialize(includeZero ? tree : pruneZeroRows(tree));
  };

  const assetsCurrent = section("assets.current");
  const assetsFixed = section("assets.fixed");
  const assetsOther = section("assets.other");
  const liabCurrent = section("liabilities.current");
  const liabLongTerm = section("liabilities.long_term");
  const equity = section("equity");

  const big = (s: SectionOut) => BigInt(s.total_cents);
  const bigC = (s: SectionOut) =>
    s.compare_total_cents === null ? null : BigInt(s.compare_total_cents);
  const addC = (...vs: Array<bigint | null>): bigint | null =>
    vs.some((v) => v === null)
      ? null
      : vs.reduce<bigint>((a, v) => a + (v ?? 0n), 0n);

  const netIncomeYtd = netIncomeOf(yearToDate, (r) => r.raw_cents);
  const retained = netIncomeOf(cumulative, (r) => r.raw_cents) - netIncomeYtd;
  const netIncomeYtdC = compareAsOf
    ? netIncomeOf(yearToDate, (r) => r.compare_raw_cents)
    : null;
  const retainedC =
    compareAsOf && netIncomeYtdC !== null
      ? netIncomeOf(cumulative, (r) => r.compare_raw_cents) - netIncomeYtdC
      : null;

  const totalAssets = big(assetsCurrent) + big(assetsFixed) + big(assetsOther);
  const totalLiabilities = big(liabCurrent) + big(liabLongTerm);
  const totalEquity = big(equity) + retained + netIncomeYtd;
  const totalLiabEquity = totalLiabilities + totalEquity;

  const totalAssetsC = addC(
    bigC(assetsCurrent),
    bigC(assetsFixed),
    bigC(assetsOther)
  );
  const totalLiabilitiesC = addC(bigC(liabCurrent), bigC(liabLongTerm));
  const totalEquityC = addC(bigC(equity), retainedC, netIncomeYtdC);
  const totalLiabEquityC = addC(totalLiabilitiesC, totalEquityC);

  return res.json({
    as_of: asOf,
    compare_as_of: compareAsOf,
    assets: {
      current: assetsCurrent,
      fixed: assetsFixed,
      other: assetsOther,
      total_cents: totalAssets.toString(),
      compare_total_cents: str(totalAssetsC),
    },
    liabilities: {
      current: liabCurrent,
      long_term: liabLongTerm,
      total_cents: totalLiabilities.toString(),
      compare_total_cents: str(totalLiabilitiesC),
    },
    equity: {
      rows: equity.rows,
      accounts_total_cents: equity.total_cents,
      compare_accounts_total_cents: equity.compare_total_cents,
      retained_earnings_cents: retained.toString(),
      compare_retained_earnings_cents: str(retainedC),
      net_income_cents: netIncomeYtd.toString(),
      compare_net_income_cents: str(netIncomeYtdC),
      total_cents: totalEquity.toString(),
      compare_total_cents: str(totalEquityC),
    },
    total_assets_cents: totalAssets.toString(),
    total_liabilities_equity_cents: totalLiabEquity.toString(),
    compare_total_assets_cents: str(totalAssetsC),
    compare_total_liabilities_equity_cents: str(totalLiabEquityC),
    balanced: totalAssets === totalLiabEquity,
  });
}
