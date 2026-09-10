import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import {
  CM_REPORTING_TREATMENT_KEY,
  CM_TREATMENT_FRAUD_WRITEOFF,
} from "../../reports/fraud-writeoff";
import { loadAccountMap, resolveProductAccounts } from "../accounts";
import { buildCreditMemoLines } from "../lines/credit-memo";
import { centsFromNumeric } from "../money";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { CreditMemoSnapshot, LedgerError, PostResult, ReverseResult } from "../types";

type CmHeader = {
  id: string;
  credit_memo_number: string;
  status: string;
  total: string;
  subtotal: string;
  discount: string;
  shipping: string;
  tax: string;
  completed_at: string | null;
  voided_at: string | null;
  metadata: Record<string, unknown> | null;
};

type CmLineRow = {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  quantity: number;
  damaged_qty: number;
  line_total: string;
  unit_cost: string | null;
};

async function loadHeader(
  client: PoolClient,
  creditMemoId: string
): Promise<CmHeader | null> {
  const { rows } = await client.query<CmHeader>(
    `SELECT id, credit_memo_number, status, total::text, subtotal::text, discount::text, shipping::text, tax::text,
            completed_at::text, voided_at::text, metadata
     FROM pos_credit_memo WHERE id = $1 AND deleted_at IS NULL`,
    [creditMemoId]
  );
  return rows[0] ?? null;
}

async function loadLines(
  client: PoolClient,
  creditMemoId: string
): Promise<CmLineRow[]> {
  const { rows } = await client.query<CmLineRow>(
    `SELECT cmi.id, cmi.variant_id, pv.product_id, cmi.quantity, cmi.damaged_qty,
            cmi.line_total::text, cmi.average_unit_cost::text AS unit_cost
     FROM pos_credit_memo_item cmi
     LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
     WHERE cmi.credit_memo_id = $1 AND cmi.deleted_at IS NULL
     ORDER BY cmi.sort_order NULLS LAST, cmi.id`,
    [creditMemoId]
  );
  return rows;
}

function isFraudWriteoff(header: CmHeader): boolean {
  const treatment = header.metadata?.[CM_REPORTING_TREATMENT_KEY];
  return treatment === CM_TREATMENT_FRAUD_WRITEOFF;
}

/**
 * Ajustes internos marcados `is_internal_adjustment`/`never_sync_to_qb`: correcciones
 * fuera de libros que nunca deben tocar el GL (ni QB). No es un bloqueo — el
 * replay los excluye de su query de terminalidad (`replay.ts`).
 */
function isInternalAdjustment(header: CmHeader): boolean {
  const meta = header.metadata ?? {};
  return meta["is_internal_adjustment"] === "true" || meta["never_sync_to_qb"] === "true";
}

async function buildSnapshot(
  client: PoolClient,
  header: CmHeader,
  lineRows: CmLineRow[]
) {
  const map = await loadAccountMap(client);
  const productIds = lineRows
    .map((r) => r.product_id)
    .filter((id): id is string => Boolean(id));
  const productAccounts = await resolveProductAccounts(client, productIds, map);

  const snapshot: CreditMemoSnapshot = {
    totalCents: centsFromNumeric(header.total),
    subtotalCents: centsFromNumeric(header.subtotal),
    discountCents: centsFromNumeric(header.discount),
    shippingCents: centsFromNumeric(header.shipping),
    taxCents: centsFromNumeric(header.tax),
    isFraudWriteoff: isFraudWriteoff(header),
    lines: lineRows.map((r) => {
      const accounts = r.product_id ? productAccounts.get(r.product_id) : undefined;
      return {
        quantity: r.quantity,
        damagedQty: r.damaged_qty,
        lineTotalCents: centsFromNumeric(r.line_total),
        unitCostDollars: r.unit_cost,
        incomeAccount: accounts?.income ?? map.income_default,
        cogsAccount: r.variant_id ? accounts?.cogs ?? map.cogs_default : null,
      };
    }),
  };
  return { map, snapshot };
}

export async function postCreditMemo(
  client: PoolClient,
  creditMemoId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, creditMemoId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { creditMemoId });
  if (header.status !== "completed")
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });
  if (isInternalAdjustment(header)) {
    return { status: "skipped", reason: "internal_adjustment" };
  }

  const lineRows = await loadLines(client, creditMemoId);
  const { map, snapshot } = await buildSnapshot(client, header, lineRows);
  const lines = buildCreditMemoLines(snapshot, map);
  const day = getBusinessDateString(header.completed_at);
  const sourceSnapshot = { header, lines: lineRows };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "pos_credit_memo",
    source_id: creditMemoId,
    document_number: header.credit_memo_number,
    day,
    reference: header.credit_memo_number,
    description: `Credit Memo ${header.credit_memo_number}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseCreditMemo(
  client: PoolClient,
  creditMemoId: string,
  actorId: string,
  reason = "credit memo voided"
): Promise<ReverseResult> {
  const header = await loadHeader(client, creditMemoId);
  if (!header) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(header.voided_at ?? header.completed_at);
  return reverseDocumentJournal(client, {
    source_kind: "pos_credit_memo",
    source_id: creditMemoId,
    day,
    reason,
    actor_id: actorId,
  });
}
