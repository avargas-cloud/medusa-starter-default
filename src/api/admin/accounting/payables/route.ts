import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../lib/accounting/month-close-auth";
import { computeBillBalancesBatch } from "../../../../lib/finance/recompute-bill-finance";
import { getBusinessDateString } from "../../../../lib/date/et";

interface OpenBillRow {
  id: string;
  vendor_id: string;
  vendor_name_snapshot: string | null;
  number: string | null;
  reference_id: string | null;
  age_date: string; // YYYY-MM-DD, ET
}

type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

function bucketFor(ageDays: number): AgingBucket {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

function daysBetween(asOf: string, ageDate: string): number {
  const a = new Date(`${asOf}T00:00:00Z`).getTime();
  const b = new Date(`${ageDate}T00:00:00Z`).getTime();
  return Math.floor((a - b) / 86_400_000);
}

/**
 * GET ?as_of=YYYY-MM-DD (default today ET) — plan §3: per vendor, bills open
 * with balance, aged by `COALESCE(due_date, document_date, confirmed_at)` in
 * ET, plus `gl_ap_balance_cents` (Σ credit−debit of active `accounts_payable`
 * journal lines up to as_of) to compare against the AP-derived total.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const asOf =
    typeof req.query.as_of === "string" && req.query.as_of
      ? req.query.as_of
      : getBusinessDateString();

  const pool = getDbPool();

  const { rows: billRows } = await pool.query(
    `SELECT vb.id, vb.vendor_id, vb.vendor_name_snapshot, vb.number, vb.reference_id,
            (COALESCE(vb.due_date, vb.document_date, vb.confirmed_at) AT TIME ZONE 'America/New_York')::date::text AS age_date
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed','synced')`,
    []
  );
  const bills = billRows as OpenBillRow[];
  const balances = await computeBillBalancesBatch(pool, bills.map((b) => b.id));

  const byVendor = new Map<
    string,
    {
      vendor_id: string;
      vendor_name: string | null;
      total_open_cents: number;
      buckets: Record<AgingBucket, number>;
      bills: Array<{
        id: string;
        number: string | null;
        reference_id: string | null;
        age_date: string;
        bucket: AgingBucket;
        balance_cents: number;
      }>;
    }
  >();

  for (const bill of bills) {
    const balance = balances.get(bill.id);
    if (!balance || balance.balance_cents <= 0) continue;
    const bucket = bucketFor(daysBetween(asOf, bill.age_date));
    let entry = byVendor.get(bill.vendor_id);
    if (!entry) {
      entry = {
        vendor_id: bill.vendor_id,
        vendor_name: bill.vendor_name_snapshot,
        total_open_cents: 0,
        buckets: { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 },
        bills: [],
      };
      byVendor.set(bill.vendor_id, entry);
    }
    entry.total_open_cents += balance.balance_cents;
    entry.buckets[bucket] += balance.balance_cents;
    entry.bills.push({
      id: bill.id,
      number: bill.number,
      reference_id: bill.reference_id,
      age_date: bill.age_date,
      bucket,
      balance_cents: balance.balance_cents,
    });
  }

  const vendors = [...byVendor.values()].sort((a, b) => b.total_open_cents - a.total_open_cents);
  const totalOpenCents = vendors.reduce((sum, v) => sum + v.total_open_cents, 0);

  const { rows: mapRows } = await pool.query(
    `SELECT qb_list_id FROM gl_account_map WHERE key = 'accounts_payable'`
  );
  const apListId = (mapRows[0] as { qb_list_id: string } | undefined)?.qb_list_id ?? null;

  let glApBalanceCents = 0;
  if (apListId) {
    const { rows: glRows } = await pool.query(
      `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint AS balance
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.account_list_id = $1 AND e.day <= $2`,
      [apListId, asOf]
    );
    glApBalanceCents = Number((glRows[0] as { balance: number | string }).balance);
  }

  return res.json({
    as_of: asOf,
    vendors,
    total_open_cents: totalOpenCents,
    gl_ap_balance_cents: apListId ? glApBalanceCents : null,
    gl_account_map_missing: apListId ? null : "accounts_payable",
  });
}
