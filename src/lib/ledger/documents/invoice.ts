import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { loadAccountMap, resolveProductAccounts } from "../accounts";
import { buildInvoiceLines } from "../lines/invoice";
import { centsFromNumeric } from "../money";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { InvoiceSnapshot, LedgerError, PostResult, ReverseResult } from "../types";

/** §6: terminalidad de invoice para posting. */
const POSTABLE_STATUSES = new Set([
  "issued",
  "partial",
  "paid",
  "partially_refunded",
  "refunded",
]);

type InvoiceHeader = {
  id: string;
  invoice_number: string;
  status: string;
  total: string;
  subtotal: string;
  discount: string;
  shipping: string;
  tax: string;
  issued_at: string | null;
  voided_at: string | null;
};

type InvoiceLineRow = {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  quantity: number;
  unit_cost: string | null;
  line_net_cents: string;
};

async function loadHeader(
  client: PoolClient,
  invoiceId: string
): Promise<InvoiceHeader | null> {
  const { rows } = await client.query<InvoiceHeader>(
    `SELECT id, invoice_number, status, total::text, subtotal::text, discount::text, shipping::text, tax::text,
            issued_at::text, voided_at::text
     FROM pos_invoice WHERE id = $1 AND deleted_at IS NULL`,
    [invoiceId]
  );
  return rows[0] ?? null;
}

/**
 * `line_net_cents` es el peso CRUDO (`COALESCE(net_total_cents, total)`) —
 * NUNCA se lee como el income final: `pii.net_total_cents` es inconsistente
 * entre facturas (a veces ya trae el descuento de orden, a veces no), así que
 * el reparto real ocurre en `buildInvoiceLines` por mayor-resto sobre
 * `subtotal + discount` (bruto).
 */
async function loadLines(
  client: PoolClient,
  invoiceId: string
): Promise<InvoiceLineRow[]> {
  const { rows } = await client.query<InvoiceLineRow>(
    `SELECT pii.id, pii.variant_id, pv.product_id, pii.quantity,
            pii.average_unit_cost::text AS unit_cost,
            COALESCE(pii.net_total_cents, pii.total)::bigint::text AS line_net_cents
     FROM pos_invoice_item pii
     LEFT JOIN product_variant pv ON pv.id = pii.variant_id
     WHERE pii.invoice_id = $1 AND pii.deleted_at IS NULL
     ORDER BY pii.sort_order NULLS LAST, pii.id`,
    [invoiceId]
  );
  return rows;
}

async function buildSnapshot(
  client: PoolClient,
  header: InvoiceHeader,
  lineRows: InvoiceLineRow[]
) {
  const map = await loadAccountMap(client);
  const productIds = lineRows
    .map((r) => r.product_id)
    .filter((id): id is string => Boolean(id));
  const productAccounts = await resolveProductAccounts(client, productIds, map);

  const snapshot: InvoiceSnapshot = {
    totalCents: centsFromNumeric(header.total),
    subtotalCents: centsFromNumeric(header.subtotal),
    discountCents: centsFromNumeric(header.discount),
    shippingCents: centsFromNumeric(header.shipping),
    taxCents: centsFromNumeric(header.tax),
    lines: lineRows.map((r) => {
      const accounts = r.product_id ? productAccounts.get(r.product_id) : undefined;
      return {
        quantity: r.quantity,
        lineNetCents: BigInt(r.line_net_cents ?? "0"),
        unitCostDollars: r.unit_cost,
        incomeAccount: accounts?.income ?? map.income_default,
        cogsAccount: r.variant_id ? accounts?.cogs ?? map.cogs_default : null,
      };
    }),
  };
  return { map, snapshot };
}

export async function postInvoice(
  client: PoolClient,
  invoiceId: string,
  actorId: string
): Promise<PostResult> {
  const header = await loadHeader(client, invoiceId);
  if (!header) throw new LedgerError("GL_SOURCE_INVALID", { invoiceId });
  if (!POSTABLE_STATUSES.has(header.status))
    throw new LedgerError("GL_SOURCE_INVALID", { status: header.status });

  const lineRows = await loadLines(client, invoiceId);
  const { map, snapshot } = await buildSnapshot(client, header, lineRows);
  const lines = buildInvoiceLines(snapshot, map);
  const day = getBusinessDateString(header.issued_at);
  const sourceSnapshot = { header, lines: lineRows };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "pos_invoice",
    source_id: invoiceId,
    document_number: header.invoice_number,
    day,
    reference: header.invoice_number,
    description: `POS Invoice ${header.invoice_number}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseInvoice(
  client: PoolClient,
  invoiceId: string,
  actorId: string,
  reason = "invoice voided"
): Promise<ReverseResult> {
  const header = await loadHeader(client, invoiceId);
  if (!header) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(header.voided_at ?? header.issued_at);
  return reverseDocumentJournal(client, {
    source_kind: "pos_invoice",
    source_id: invoiceId,
    day,
    reason,
    actor_id: actorId,
  });
}
