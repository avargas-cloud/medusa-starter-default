/**
 * check-po-qb-state.ts
 *
 * Read-only diagnostic for failed_permanent purchase order modify ops.
 *
 * For each PO number passed in PO_NUMBERS env (default: PO-1015,PO-1016):
 *   1. Reads our DB state (qb_purchase_order_list_id, qb_edit_sequence, pipeline row).
 *   2. Asks QB Bridge (PurchaseOrderQueryRq by RefNumber) for the current TxnID and EditSequence.
 *   3. Reports drift so we know whether to update DB + reset pipeline or escalate.
 *
 * Usage (from backend/):
 *   yarn medusa exec src/scripts/diagnostics/check-po-qb-state.ts
 *   PO_NUMBERS=PO-1015,PO-1016 yarn medusa exec src/scripts/diagnostics/check-po-qb-state.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../lib/quickbooks/client/core";

interface PoDbRow {
  id: string;
  number: string;
  status: string;
  po_status: string | null;
  qb_purchase_order_list_id: string | null;
  qb_purchase_order_txn_number: string | null;
  qb_edit_sequence: string | null;
}

interface PipelineRow {
  id: string;
  status: string;
  retries: number;
  last_error: string | null;
  qb_operation_id: string | null;
  updated_at: string;
}

interface QbLookupResult {
  txnId: string;
  editSequence: string;
  refNumber: string;
}

async function runDirectQuery(
  qbxml: string
): Promise<Record<string, unknown>> {
  const enqueueRes = (await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  })) as { operationId?: string; operation_id?: string };
  const operationId = enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = (await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    )) as { operation?: { status?: string; result?: unknown; error?: string } };
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      return op.result as Record<string, unknown>;
    }
    if (op.status === "failed") {
      throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
    }
  }
  throw new Error(
    "QB query timed out — QuickBooks Desktop may be offline or QBWC not connected"
  );
}

async function lookupPoInQb(refNumber: string): Promise<QbLookupResult | null> {
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<PurchaseOrderQueryRq requestID="1">`,
    `<RefNumber>${refNumber}</RefNumber>`,
    `</PurchaseOrderQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  const rawResult = await runDirectQuery(qbxml);
  const qbMsgs: Record<string, unknown> =
    (rawResult as Record<string, Record<string, unknown>>)?.QBXML?.[
      "QBXMLMsgsRs"
    ] ??
    (rawResult as Record<string, unknown>)?.QBXMLMsgsRs ??
    rawResult;

  const rsAny = (qbMsgs as Record<string, Record<string, unknown>>)?.[
    "PurchaseOrderQueryRs"
  ];
  const retRaw =
    (rsAny as Record<string, unknown>)?.PurchaseOrderRet ??
    (rawResult as Record<string, unknown>)?.PurchaseOrderRet ??
    null;

  if (!retRaw) return null;
  const doc = (
    Array.isArray(retRaw) ? retRaw[0] : retRaw
  ) as Record<string, string>;

  return {
    txnId: doc.TxnID || "",
    editSequence: doc.EditSequence || "",
    refNumber,
  };
}

export default async function checkPoQbState({
  container,
}: {
  container: MedusaContainer;
}) {
  const knex = (
    container as unknown as {
      resolve: (k: string) => {
        raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
    }
  ).resolve("__pg_connection__");

  const numbersEnv = process.env.PO_NUMBERS || "PO-1015,PO-1016";
  const numbers = numbersEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("=== check-po-qb-state ===");
  console.log(`POs: ${numbers.join(", ")}\n`);

  for (const number of numbers) {
    console.log(`──────── ${number} ────────`);

    const dbRows = (
      await knex.raw(
        `SELECT id, number, status, po_status,
                qb_purchase_order_list_id,
                qb_purchase_order_txn_number,
                qb_edit_sequence
         FROM purchase_order
         WHERE number = ?
         LIMIT 1`,
        [number]
      )
    ).rows as PoDbRow[];

    if (dbRows.length === 0) {
      console.log(`  ⚠️  Not found in DB`);
      continue;
    }
    const po = dbRows[0];

    const pipelineRows = (
      await knex.raw(
        `SELECT id, status, retries, last_error, qb_operation_id, updated_at
         FROM qb_purchase_order_pipeline
         WHERE purchase_order_id = ?
         ORDER BY updated_at DESC
         LIMIT 3`,
        [po.id]
      )
    ).rows as PipelineRow[];

    console.log(`  DB:`);
    console.log(`    po_id           : ${po.id}`);
    console.log(`    status          : ${po.status} / ${po.po_status}`);
    console.log(`    qb_list_id      : ${po.qb_purchase_order_list_id}`);
    console.log(
      `    qb_txn_number   : ${po.qb_purchase_order_txn_number}`
    );
    console.log(`    qb_edit_seq     : ${po.qb_edit_sequence}`);
    console.log(`  Pipeline (latest 3):`);
    for (const p of pipelineRows) {
      console.log(
        `    [${p.status}] retries=${p.retries} op=${p.qb_operation_id ?? "-"} at ${p.updated_at}`
      );
      if (p.last_error) {
        console.log(`      err: ${p.last_error.slice(0, 200)}`);
      }
    }

    let qb: QbLookupResult | null = null;
    let qbError: string | null = null;
    const refToQuery = po.qb_purchase_order_txn_number || number.replace(/^PO-/, "");
    try {
      console.log(`  Querying QB Bridge by RefNumber=${refToQuery} ...`);
      qb = await lookupPoInQb(refToQuery);
    } catch (err) {
      qbError = err instanceof Error ? err.message : String(err);
    }

    if (qbError) {
      console.log(`  QB lookup ERROR: ${qbError}`);
    } else if (!qb) {
      console.log(`  QB lookup: PO NOT FOUND in QuickBooks`);
    } else {
      console.log(`  QB:`);
      console.log(`    TxnID         : ${qb.txnId}`);
      console.log(`    EditSequence  : ${qb.editSequence}`);

      const txnDrift = qb.txnId !== po.qb_purchase_order_list_id;
      const editDrift = qb.editSequence !== po.qb_edit_sequence;
      if (txnDrift || editDrift) {
        console.log(`  ⚠️  DRIFT DETECTED:`);
        if (txnDrift) {
          console.log(
            `    TxnID    DB=${po.qb_purchase_order_list_id}  QB=${qb.txnId}`
          );
        }
        if (editDrift) {
          console.log(
            `    EditSeq  DB=${po.qb_edit_sequence}  QB=${qb.editSequence}`
          );
        }
        console.log(
          `  → Suggested fix: UPDATE purchase_order with QB values + reset pipeline row.`
        );
      } else {
        console.log(`  ✅ DB and QB match — no drift.`);
      }
    }

    console.log("");
  }

  console.log("=== done ===");
}
