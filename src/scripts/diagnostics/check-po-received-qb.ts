/**
 * check-po-received-qb.ts
 *
 * Read-only diagnostic: ask QuickBooks for the RECEIVED quantity per line on a
 * set of POs (PurchaseOrderQueryRq + IncludeLineItems), and compare against our
 * DB qty_received. Confirms whether QB holds MORE received units than Medusa
 * recorded — the signature of a duplicate ItemReceipt created in QB.
 *
 * Usage (from backend/):
 *   PO_NUMBERS=PO-1036,PO-1033,PO-1022 yarn medusa exec src/scripts/diagnostics/check-po-received-qb.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../lib/quickbooks/client/core";

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
    if (op.status === "completed") return op.result as Record<string, unknown>;
    if (op.status === "failed")
      throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
  }
  throw new Error("QB query timed out — QBWC not connected?");
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export default async function checkPoReceivedQb({
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

  const numbers = (process.env.PO_NUMBERS || "PO-1036,PO-1033,PO-1022")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("=== check-po-received-qb ===\n");

  for (const number of numbers) {
    console.log(`──────── ${number} ────────`);
    const ref = number.replace(/^PO-/, "");

    // DB side
    const dbLines = (
      await knex.raw(
        `SELECT pol.sku_snapshot, pol.qty_ordered, pol.qty_received, pol.qb_txn_line_id
           FROM purchase_order_line pol
           JOIN purchase_order po ON po.id = pol.purchase_order_id
          WHERE po.number = ? AND pol.deleted_at IS NULL
          ORDER BY pol.line_order`,
        [number]
      )
    ).rows as Array<{
      sku_snapshot: string;
      qty_ordered: number;
      qty_received: number;
      qb_txn_line_id: string | null;
    }>;
    const dbBySku = new Map(dbLines.map((l) => [l.sku_snapshot, l]));

    const qbxml = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<?qbxml version="10.0"?>`,
      `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
      `<PurchaseOrderQueryRq requestID="1">`,
      `<RefNumber>${ref}</RefNumber>`,
      `<IncludeLineItems>true</IncludeLineItems>`,
      `</PurchaseOrderQueryRq>`,
      `</QBXMLMsgsRq></QBXML>`,
    ].join("");

    let ret: Record<string, unknown> | null = null;
    try {
      const raw = await runDirectQuery(qbxml);
      const msgs =
        (raw as Record<string, Record<string, unknown>>)?.QBXML?.QBXMLMsgsRs ??
        (raw as Record<string, unknown>)?.QBXMLMsgsRs ??
        raw;
      const rs = (msgs as Record<string, Record<string, unknown>>)
        ?.PurchaseOrderQueryRs;
      const poRet = (rs as Record<string, unknown>)?.PurchaseOrderRet;
      ret = (Array.isArray(poRet) ? poRet[0] : poRet) as Record<
        string,
        unknown
      > | null;
    } catch (err) {
      console.log(`  QB ERROR: ${err instanceof Error ? err.message : err}\n`);
      continue;
    }

    if (!ret) {
      console.log(`  QB: PO not found\n`);
      continue;
    }

    console.log(
      `  QB TxnID=${ret.TxnID} EditSequence=${ret.EditSequence} IsFullyReceived=${ret.IsFullyReceived}`
    );
    const qbLines = asArray(
      ret.PurchaseOrderLineRet as
        | Record<string, unknown>
        | Record<string, unknown>[]
    );
    console.log(
      `  ${"SKU".padEnd(22)} ${"DB ord".padStart(6)} ${"DB rcv".padStart(6)} ${"QB ord".padStart(6)} ${"QB rcv".padStart(6)}  drift`
    );
    for (const ql of qbLines) {
      const itemRef = ql.ItemRef as Record<string, string> | undefined;
      const sku = itemRef?.FullName || "(?)";
      const qbOrd = Number(ql.Quantity ?? 0);
      const qbRcv = Number(ql.ReceivedQuantity ?? 0);
      const db = dbBySku.get(sku);
      const dbRcv = Number(db?.qty_received ?? 0);
      const drift = qbRcv !== dbRcv ? `⚠️ QB!=DB (${qbRcv} vs ${dbRcv})` : "";
      console.log(
        `  ${sku.padEnd(22)} ${String(db?.qty_ordered ?? "-").padStart(6)} ${String(dbRcv).padStart(6)} ${String(qbOrd).padStart(6)} ${String(qbRcv).padStart(6)}  ${drift}`
      );
    }
    console.log("");
  }

  console.log("=== done ===");
}
