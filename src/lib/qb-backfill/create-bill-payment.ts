/**
 * src/lib/qb-backfill/create-bill-payment.ts
 *
 * Fase 3 del plan `qb-docs-backfill-compras-20260911`: crea un
 * `vendor_bill_payment` + asignaciones para un `QbBillPayment` que el POS no
 * conoce.
 *
 * CORRECCIÓN al mapa del plan: `bank_account_list_id` NO resuelve contra
 * `qb_bank_account` — el escritor nativo (`src/lib/bill-payments/create.ts`)
 * resuelve la cuenta contra `qb_account` (`qb_list_id`/`account_type`
 * "Bank"|"CreditCard") y ESE es el catálogo que lee todo lector de un
 * `vendor_bill_payment` existente. `resolve.ts::loadBankAccountIndex`
 * (`qb_bank_account`) queda para lo que sea que use ese módulo (Refund
 * orchestration, según su propio docstring) — no para esto. Ver reporte de
 * fase 3/4.
 *
 * Política de faltantes (ajustada, fail-closed): si `BankAccountRef`/
 * `CreditCardAccountRef` no resuelve ACTIVO en `qb_account`, el pago se
 * BLOQUEA (`bank_account_not_found`) — este backfill no tiene una consulta
 * QB que traiga el nombre/tipo real de la cuenta para poder CREARLA bien
 * clasificada, y adivinar Bank vs CreditCard rompería el mismo invariante
 * que la ruta nativa valida (`bank_account_type_mismatch`).
 */
import { ulid } from "ulid";
import { businessInstant } from "./create-po";
import type { QueryableDb } from "./resolve";
import type { QbBillPayment, QbBillPaymentApplication } from "./types";

function makeId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export type PaymentDecisionReason = "already" | "create";

export interface PaymentDecision {
  create: boolean;
  reason: PaymentDecisionReason;
}

export function decidePaymentCreation(
  payment: QbBillPayment,
  knownTxnIds: ReadonlySet<string>
): PaymentDecision {
  if (knownTxnIds.has(payment.txn_id)) return { create: false, reason: "already" };
  return { create: true, reason: "create" };
}

/** `check`/`credit_card` (forma QB) → `check`/`card` (enum de `vendor_bill_payment.method`). */
export function mapPaymentMethod(qbMethod: "check" | "credit_card"): "check" | "card" {
  return qbMethod === "credit_card" ? "card" : "check";
}

export interface ResolvedAllocation {
  vendor_bill_id: string;
  amount_cents: number;
}

export type ApplicationsResolution =
  | { ok: true; allocations: ResolvedAllocation[] }
  | { ok: false; reason: "bill_not_found"; missing_txn_id: string }
  | { ok: false; reason: "no_applications" }
  | { ok: false; reason: "amount_mismatch"; sum_cents: number; header_cents: number };

/**
 * Resuelve `applications[].txn_id` (bill de QB) contra `billIdByTxnId`
 * (`vendor_bill.qb_txn_id → id`, cargado por el caller). Si CUALQUIER
 * aplicación no resuelve, el pago entero se bloquea — un pago parcialmente
 * aplicado no es un documento fiel. La suma de asignaciones debe igualar el
 * monto del header (tolerancia 1¢ por redondeo de centavos QB).
 */
export function resolveApplications(
  applications: readonly QbBillPaymentApplication[],
  headerAmountCents: number,
  billIdByTxnId: ReadonlyMap<string, string>
): ApplicationsResolution {
  if (applications.length === 0) return { ok: false, reason: "no_applications" };
  const allocations: ResolvedAllocation[] = [];
  for (const app of applications) {
    if (app.txn_type !== "Bill") continue; // discount/credit-only rows sin Bill no generan allocation
    const billId = billIdByTxnId.get(app.txn_id);
    if (!billId) return { ok: false, reason: "bill_not_found", missing_txn_id: app.txn_id };
    allocations.push({ vendor_bill_id: billId, amount_cents: app.amount_cents });
  }
  if (allocations.length === 0) return { ok: false, reason: "no_applications" };
  const sum = allocations.reduce((s, a) => s + a.amount_cents, 0);
  if (Math.abs(sum - headerAmountCents) > 1) {
    return { ok: false, reason: "amount_mismatch", sum_cents: sum, header_cents: headerAmountCents };
  }
  return { ok: true, allocations };
}

export interface BankAccountLookup {
  qb_list_id: string;
  full_name: string;
  account_type: string;
  currency: string | null;
}

export type BankAccountLookupFn = (listId: string) => Promise<BankAccountLookup | null>;

export interface CreatePaymentOptions {
  runId: string;
  vendorId: string;
  vendorNameSnapshot: string;
  vendorQbListId: string;
  resolveBankAccount: BankAccountLookupFn;
  createdByUserId: string;
}

export type CreatePaymentBlockReason =
  | "no_bank_account_ref"
  | "bank_account_not_found"
  | "bank_account_type_mismatch"
  | "bill_not_found"
  | "no_applications"
  | "amount_mismatch";

export interface CreatePaymentResult {
  vendor_bill_payment_id: string;
  number: string;
  allocations: number;
}

/**
 * Crea el `vendor_bill_payment` + asignaciones dentro de la transacción del
 * caller. `billIdByTxnId` es el índice de bills YA conocidos al momento del
 * run (incluye los creados por este mismo run — el caller lo actualiza a
 * medida que crea bills, porque el orden de tipos es po → receipt → bill →
 * credit → payment).
 */
export async function createBillPaymentFromQb(
  client: QueryableDb,
  payment: QbBillPayment,
  billIdByTxnId: ReadonlyMap<string, string>,
  opts: CreatePaymentOptions
): Promise<CreatePaymentResult> {
  const accountRef = payment.bank_account_ref ?? payment.credit_card_account_ref;
  if (!accountRef) {
    throw Object.assign(new Error(`BillPayment ${payment.txn_id}: sin BankAccountRef/CreditCardAccountRef`), {
      blockReason: "no_bank_account_ref" as CreatePaymentBlockReason,
    });
  }
  const account = await opts.resolveBankAccount(accountRef.list_id);
  if (!account) {
    throw Object.assign(
      new Error(`BillPayment ${payment.txn_id}: cuenta ${accountRef.list_id} (${accountRef.full_name}) no resuelve activa en qb_account`),
      { blockReason: "bank_account_not_found" as CreatePaymentBlockReason }
    );
  }
  const method = mapPaymentMethod(payment.payment_method);
  const expectedType = method === "card" ? "CreditCard" : "Bank";
  if (account.account_type !== expectedType) {
    throw Object.assign(
      new Error(`BillPayment ${payment.txn_id}: cuenta ${accountRef.list_id} es ${account.account_type}, se esperaba ${expectedType}`),
      { blockReason: "bank_account_type_mismatch" as CreatePaymentBlockReason }
    );
  }

  const resolution = resolveApplications(payment.applications, payment.amount_cents, billIdByTxnId);
  if (!resolution.ok) {
    throw Object.assign(new Error(`BillPayment ${payment.txn_id}: ${JSON.stringify(resolution)}`), {
      blockReason: resolution.reason as CreatePaymentBlockReason,
    });
  }

  const numRes = await client.query(`SELECT 'BP-' || nextval('custom_bill_payment_seq')::text AS number`);
  const number = (numRes.rows[0] as { number: string }).number;
  const id = makeId("vbp");
  const businessAt = businessInstant(payment.txn_date);
  const memo = `[qb_backfill run=${opts.runId} txn=${payment.txn_id}]`;

  await client.query(
    // `payment_date` es `date`; `qb_synced_at`/`posted_at`/`created_at`/
    // `updated_at` son `timestamptz` — mismo gotcha que vendor_credit: un
    // solo `$N` entre `date` y `timestamptz` falla "inconsistent types
    // deduced for parameter $N" (sondeado).
    `INSERT INTO vendor_bill_payment (
       id, number, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
       bank_account_list_id, bank_account_snapshot, payment_date, method, amount_cents,
       memo, status, qb_txn_id, qb_edit_sequence, qb_synced_at, posted_at, posted_by,
       created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'posted',$12,$13,$14,$14,$15,$14,$14)`,
    [
      id,
      number,
      opts.vendorId,
      opts.vendorNameSnapshot,
      opts.vendorQbListId,
      account.qb_list_id,
      JSON.stringify({
        id: account.qb_list_id,
        name: account.full_name,
        account_type: account.account_type,
        currency: account.currency ?? "USD",
      }),
      businessAt,
      method,
      payment.amount_cents,
      memo,
      payment.txn_id,
      payment.edit_sequence,
      businessAt,
      opts.createdByUserId,
    ]
  );

  for (const a of resolution.allocations) {
    await client.query(
      `INSERT INTO vendor_bill_payment_allocation (id, payment_id, vendor_bill_id, amount_cents)
       VALUES ($1,$2,$3,$4)`,
      [makeId("vbpa"), id, a.vendor_bill_id, a.amount_cents]
    );
  }

  return { vendor_bill_payment_id: id, number, allocations: resolution.allocations.length };
}
