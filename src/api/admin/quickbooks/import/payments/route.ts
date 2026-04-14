import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../../../../lib/quickbooks/client/core";
import { FINANCE_MODULE } from "../../../../../modules/finance";

export interface StagedPaymentRecord {
  id: number;
  qb_txn_id: string;
  qb_ref_number: string;
  qb_customer_list_id: string;
  qb_customer_name: string;
  medusa_customer_id: string | null;
  medusa_customer_email: string | null;
  amount_cents: number;
  txn_date: string;
  method: string;
  year: number;
  status: "pending" | "applied" | "no_match";
  applied_payment_id: string | null;
  fetched_at: string;
  applied_at: string | null;
}

async function ensureTable(client: Client): Promise<void> {
  await client.query(`
        CREATE TABLE IF NOT EXISTS qb_legacy_payment (
            id SERIAL PRIMARY KEY,
            qb_txn_id TEXT UNIQUE NOT NULL,
            qb_ref_number TEXT,
            qb_customer_list_id TEXT,
            qb_customer_name TEXT NOT NULL,
            medusa_customer_id TEXT,
            medusa_customer_email TEXT,
            amount_cents INTEGER NOT NULL DEFAULT 0,
            txn_date DATE,
            method TEXT NOT NULL DEFAULT 'other',
            year INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            applied_payment_id TEXT,
            fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            applied_at TIMESTAMPTZ
        )
    `);
}

function parseMethod(methodName: string): string {
  const n = methodName.toLowerCase();
  if (n.includes("check")) return "check";
  if (n.includes("cash")) return "cash";
  if (n.includes("ach") || n.includes("transfer")) return "ach";
  if (n.includes("visa") || n.includes("master") || n.includes("card"))
    return "card";
  if (n.includes("zelle")) return "zelle";
  if (n.includes("amex") || n.includes("american express")) return "card";
  return "other";
}

/**
 * Queries QB for unapplied ReceivePayments in a given year range,
 * builds staging records with Medusa customer matches.
 */
async function syncFromQB(client: Client, year: number): Promise<void> {
  const fromDate = `${year}-01-01`;
  const toDate = `${year}-12-31`;
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<ReceivePaymentQueryRq requestID="1">`,
    `<TxnDateRangeFilter>`,
    `<FromTxnDate>${fromDate}</FromTxnDate>`,
    `<ToTxnDate>${toDate}</ToTxnDate>`,
    `</TxnDateRangeFilter>`,
    `</ReceivePaymentQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  });
  const operationId: string =
    enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  let rawResult: unknown = null;
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    );
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      rawResult = op.result;
      break;
    }
    if (op.status === "failed")
      throw new Error(
        `QB payment query failed: ${op.error || "Unknown error"}`
      );
  }

  if (!rawResult)
    throw new Error(
      "QB payment query timed out — QB Web Connector may not be running"
    );

  const raw = rawResult as Record<string, unknown>;
  const qbMsgs =
    (raw?.QBXML as any)?.QBXMLMsgsRs || (raw?.QBXMLMsgsRs as any) || raw;
  const payRetRaw =
    (qbMsgs as any)?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    (raw as any)?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    (raw as any)?.ReceivePaymentRet;

  const payList: any[] = payRetRaw
    ? Array.isArray(payRetRaw)
      ? payRetRaw
      : [payRetRaw]
    : [];
  const unapplied = payList.filter(
    (p) => parseFloat(p.UnusedPayment || "0") > 0
  );

  // Build Medusa customer lookup
  const qbListIds = [
    ...new Set(
      unapplied.map((p: any) => p.CustomerRef?.ListID).filter(Boolean)
    ),
  ] as string[];
  const customerMap = new Map<string, { id: string; email: string | null }>();
  if (qbListIds.length > 0) {
    const placeholders = qbListIds.map((_, i) => `$${i + 1}`).join(", ");
    const custResult = await client.query(
      `SELECT id, email, metadata->>'qb_list_id' AS qb_list_id
             FROM customer WHERE metadata->>'qb_list_id' IN (${placeholders})`,
      qbListIds
    );
    for (const row of custResult.rows) {
      if (row.qb_list_id)
        customerMap.set(row.qb_list_id, {
          id: row.id,
          email: row.email ?? null,
        });
    }
  }

  // Delete pending records for this year (keep applied ones)
  await client.query(
    `DELETE FROM qb_legacy_payment WHERE year = $1 AND status = 'pending'`,
    [year]
  );

  // Upsert fresh records
  for (const pay of unapplied) {
    const qbListId: string = pay.CustomerRef?.ListID || "";
    const match = customerMap.get(qbListId) ?? null;
    const status = match ? "pending" : "no_match";
    const method = parseMethod(pay.PaymentMethodRef?.FullName || "");
    const amountCents = Math.round(parseFloat(pay.UnusedPayment || "0") * 100);

    await client.query(
      `
            INSERT INTO qb_legacy_payment
                (qb_txn_id, qb_ref_number, qb_customer_list_id, qb_customer_name,
                 medusa_customer_id, medusa_customer_email, amount_cents, txn_date,
                 method, year, status, fetched_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
            ON CONFLICT (qb_txn_id) DO UPDATE
                SET qb_ref_number        = EXCLUDED.qb_ref_number,
                    qb_customer_list_id  = EXCLUDED.qb_customer_list_id,
                    qb_customer_name     = EXCLUDED.qb_customer_name,
                    medusa_customer_id   = EXCLUDED.medusa_customer_id,
                    medusa_customer_email= EXCLUDED.medusa_customer_email,
                    amount_cents         = EXCLUDED.amount_cents,
                    txn_date             = EXCLUDED.txn_date,
                    method               = EXCLUDED.method,
                    year                 = EXCLUDED.year,
                    status               = CASE
                        WHEN qb_legacy_payment.status = 'applied' THEN 'applied'
                        ELSE EXCLUDED.status
                    END,
                    fetched_at           = NOW()
        `,
      [
        pay.TxnID || "",
        pay.RefNumber || "",
        qbListId,
        pay.CustomerRef?.FullName || "Unknown",
        match?.id ?? null,
        match?.email ?? null,
        amountCents,
        pay.TxnDate || null,
        method,
        year,
        status,
      ]
    );
  }
}

/**
 * GET /admin/quickbooks/import/payments?year=2026
 * Returns staged records from DB — no QB query.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const yearParam = (req.query as Record<string, string>)?.year;
  const year = yearParam ? parseInt(yearParam, 10) : new Date().getFullYear();
  if (isNaN(year) || year < 2000 || year > 2100) {
    res.status(400).json({ error: "Invalid year parameter" });
    return;
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await ensureTable(client);
    const result = await client.query(
      `SELECT * FROM qb_legacy_payment WHERE year = $1 ORDER BY txn_date ASC, id ASC`,
      [year]
    );
    const records: StagedPaymentRecord[] = result.rows;
    res.json({
      success: true,
      records,
      total: records.length,
      pending: records.filter((r) => r.status === "pending").length,
      applied: records.filter((r) => r.status === "applied").length,
      no_match: records.filter((r) => r.status === "no_match").length,
      year,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to load payments";
    console.error("[QB Staged Payments GET] Error:", error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end();
  }
}

/**
 * POST /admin/quickbooks/import/payments
 *
 * action = "sync"  → queries QB, refreshes staging table for the year
 * action = "apply" → creates customer_payment in Medusa for one staged record
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as {
    action?: string;
    year?: number;
    txn_id?: string;
  };
  const { action, txn_id } = body;
  const year = body.year ?? new Date().getFullYear();

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await ensureTable(client);

    // ── SYNC ────────────────────────────────────────────────────────────────
    if (action === "sync") {
      await syncFromQB(client, year);
      const result = await client.query(
        `SELECT * FROM qb_legacy_payment WHERE year = $1 ORDER BY txn_date ASC, id ASC`,
        [year]
      );
      const records: StagedPaymentRecord[] = result.rows;
      res.json({
        success: true,
        records,
        total: records.length,
        pending: records.filter((r) => r.status === "pending").length,
        applied: records.filter((r) => r.status === "applied").length,
        no_match: records.filter((r) => r.status === "no_match").length,
        year,
      });
      return;
    }

    // ── APPLY ────────────────────────────────────────────────────────────────
    if (action === "apply") {
      if (!txn_id) {
        res.status(400).json({ error: "txn_id is required for apply" });
        return;
      }

      const stagingRes = await client.query(
        `SELECT * FROM qb_legacy_payment WHERE qb_txn_id = $1`,
        [txn_id]
      );
      const staged: StagedPaymentRecord | undefined = stagingRes.rows[0];
      if (!staged) {
        res
          .status(404)
          .json({ error: `Payment ${txn_id} not found in staging table` });
        return;
      }
      if (staged.status === "applied") {
        res.status(409).json({
          error: "Payment already applied",
          applied_payment_id: staged.applied_payment_id,
        });
        return;
      }
      if (!staged.medusa_customer_id) {
        res
          .status(422)
          .json({ error: "No Medusa customer match for this payment" });
        return;
      }

      const financeService = req.scope.resolve(FINANCE_MODULE);
      const payment = await financeService.createCustomerPayments({
        customer_id: staged.medusa_customer_id,
        amount: staged.amount_cents,
        method: staged.method as
          | "cash"
          | "check"
          | "card"
          | "ach"
          | "zelle"
          | "other",
        reference: staged.qb_ref_number || null,
        notes: "Legacy QB import",
        received_at: staged.txn_date ? new Date(staged.txn_date) : new Date(),
        created_by: "system",
        source: "pos",
        type: "payment",
        status: "available",
        metadata: { qb_import: true, qb_txn_id: txn_id },
      });

      await client.query(
        `UPDATE customer_payment SET qb = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ status: "yes", txn_id }), payment.id]
      );

      await client.query(
        `UPDATE qb_legacy_payment
                 SET status = 'applied', applied_payment_id = $1, applied_at = NOW()
                 WHERE qb_txn_id = $2`,
        [payment.id, txn_id]
      );

      res.json({ success: true, payment_id: payment.id, txn_id });
      return;
    }

    res.status(400).json({ error: "action must be 'sync' or 'apply'" });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Operation failed";
    console.error("[QB Staged Payments POST] Error:", error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end();
  }
}
