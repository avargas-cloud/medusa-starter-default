import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { getBusinessDateString } from "../../date/et";
import { buildCustomerPaymentLines } from "../lines/customer-payment";
import { centsFromNumeric } from "../money";
import { postDocumentJournal, reverseDocumentJournal } from "../post";
import { loadAccountMap } from "../accounts";
import { LedgerClaim, LedgerError, PaymentSnapshot, PostResult, ReverseResult } from "../types";

/** §6: sólo pagos/refunds con monto > 0 y no voideados postean. */
const CLAIMABLE_PAYMENT_STATUSES = new Set([
  "available",
  "partially_applied",
  "applied",
]);

type PaymentRow = {
  id: string;
  type: string;
  amount: string;
  status: string;
  received_at: string;
};

async function loadPayment(
  client: PoolClient,
  paymentId: string
): Promise<PaymentRow | null> {
  const { rows } = await client.query<PaymentRow>(
    `SELECT id, type, amount::text, status, received_at::text
     FROM customer_payment WHERE id = $1 AND deleted_at IS NULL`,
    [paymentId]
  );
  return rows[0] ?? null;
}

function claimHash(sourceId: string, capacityCents: bigint): string {
  return createHash("sha256")
    .update(`payment_recognition:${sourceId}:${capacityCents.toString()}`)
    .digest("hex");
}

export async function postCustomerPayment(
  client: PoolClient,
  paymentId: string,
  actorId: string
): Promise<PostResult> {
  const payment = await loadPayment(client, paymentId);
  if (!payment) throw new LedgerError("GL_SOURCE_INVALID", { paymentId });
  if (payment.type !== "payment" && payment.type !== "refund")
    throw new LedgerError("GL_SOURCE_INVALID", { type: payment.type });
  if (payment.status === "voided")
    throw new LedgerError("GL_SOURCE_INVALID", { status: payment.status });

  const amountCents = centsFromNumeric(payment.amount);
  if (amountCents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { amountCents: amountCents.toString() });

  const map = await loadAccountMap(client);
  const snapshot: PaymentSnapshot = {
    type: payment.type === "refund" ? "refund" : "payment",
    amountCents,
  };
  const lines = buildCustomerPaymentLines(snapshot, map);
  const day = getBusinessDateString(payment.received_at);
  const sourceSnapshot = { payment };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  const claims: LedgerClaim[] = [];
  if (payment.type === "payment" && CLAIMABLE_PAYMENT_STATUSES.has(payment.status)) {
    claims.push({
      source_kind: "payment_recognition",
      source_id: paymentId,
      amount_cents: amountCents,
      capacity_cents: amountCents,
      source_hash: claimHash(paymentId, amountCents),
    });
  }

  return postDocumentJournal(client, {
    source_kind: "customer_payment",
    source_id: paymentId,
    document_number: paymentId,
    day,
    reference: paymentId,
    description: `Customer ${payment.type} ${paymentId}`,
    lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
    claims,
  });
}

export async function reverseCustomerPayment(
  client: PoolClient,
  paymentId: string,
  actorId: string,
  reason = "payment voided"
): Promise<ReverseResult> {
  const payment = await loadPayment(client, paymentId);
  if (!payment) return { status: "nothing_to_reverse" };
  const day = getBusinessDateString(payment.received_at);
  return reverseDocumentJournal(client, {
    source_kind: "customer_payment",
    source_id: paymentId,
    day,
    reason,
    actor_id: actorId,
  });
}
