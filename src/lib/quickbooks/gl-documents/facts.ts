/**
 * facts.ts — `loadGlDocumentAddFacts`: el ÚNICO lugar que decide si un
 * documento GL bancario está listo para QuickBooks y construye su QBXML
 * (plan gl-docs-to-qb-20260914). Se llama al ENCOLAR y otra vez al
 * DESPACHAR, sin cambios, así "listo" nunca significa dos cosas distintas
 * (mismo contrato que `loadBillPaymentAddFacts`).
 *
 * Tres desenlaces, y la diferencia importa para el pipeline:
 *
 *   ready            → hay QBXML; se despacha.
 *   not ready, structural (`blockingReferenceIds` vacío)
 *                    → nada lo va a destrabar solo (cuenta que no existe en QB,
 *                      vendor sin ListID, A/R sin entidad, documento no
 *                      posteado). La fila queda `failed` con el motivo a la
 *                      vista; el Retry manual re-evalúa estos facts.
 *   not ready, transitorio (`blockingReferenceIds` con ids)
 *                    → falta el TxnID de QB de un cobro que el pipeline todavía
 *                      no confirmó (un depósito de hoy con la venta de hoy). El
 *                      despachador difiere y vuelve a preguntar.
 *   skip             → el documento NO debe viajar (consume una partida de
 *                      apertura que ya vive en QB). Fila `skipped`, terminal y
 *                      sin error.
 *
 * Cuentas: los `account_list_id` del POS SON ListIDs del espejo `qb_account`,
 * salvo las cuentas creadas en el POS (`pos_<ulid>`), que QuickBooks no conoce
 * → estructural, nunca "se manda igual".
 *
 * Payee del cheque (supuesto declarado en el plan): vendor → `qb_vendor.qb_list_id`
 * (falla cerrado si no hay ListID real: un cheque a un vendor sin enlace pierde
 * el 1099); customer → `customer.metadata.qb_list_id` si existe, si no el nombre
 * va en el memo; other → sin `PayeeEntityRef`, nombre en el memo;
 * other_name (qb-other-names-picker-20260916) → `qb_other_name.qb_list_id`, un
 * Other Name real de QB (falla cerrado si el enlace no existe — el documento
 * dijo que era ESE nombre, no uno parecido). Mismo mapeo para el `EntityRef`
 * de una línea de asiento.
 *
 * Fechas: `day` es columna `date` y se lee `::text` — nunca pasa por `Date`
 * (`getBusinessDateString('2026-04-22')` corre un día atrás; los 59 asientos
 * de `vendor_bill_payment` lo prueban).
 */

import { toQbRefNumber } from "../qb-ref-number";
import {
  buildCheckAddQbxml,
  buildCreditCardChargeAddQbxml,
  buildDepositAddQbxml,
  buildJournalEntryAddQbxml,
  type DepositLineInput,
  type ExpenseLineInput,
  type GlQbTxnType,
  type JournalLineInput,
} from "./qbxml-builders";
import { salesTaxAdjustmentFacts, salesTaxPaymentFacts } from "./facts-sales-tax";
import {
  majorToCents,
  one,
  resolveAccounts,
  skip,
  structural,
  transient,
  type GlDocumentAddFacts,
  type GlDocumentDb,
} from "./facts-shared";
import type { GlDocumentKind } from "./types";
import { SALES_SQL } from "../pipeline-status";

export { majorToCents, type GlDocumentAddFacts, type GlDocumentDb } from "./facts-shared";

// ── entidades ───────────────────────────────────────────────────────────────

async function vendorListId(db: GlDocumentDb, vendorId: string): Promise<string | null> {
  const row = one<{ qb_list_id: string | null }>(
    await db.raw(`SELECT qb_list_id FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [vendorId])
  );
  const id = row?.qb_list_id ?? null;
  return id && !id.startsWith("pending_") ? id : null;
}

async function otherNameListId(db: GlDocumentDb, otherNameId: string): Promise<string | null> {
  const row = one<{ qb_list_id: string | null }>(
    await db.raw(`SELECT qb_list_id FROM qb_other_name WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [otherNameId])
  );
  return row?.qb_list_id || null;
}

async function customerListId(db: GlDocumentDb, customerId: string): Promise<string | null> {
  const row = one<{ qb_list_id: string | null }>(
    await db.raw(
      `SELECT metadata->>'qb_list_id' AS qb_list_id FROM customer WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [customerId]
    )
  );
  return row?.qb_list_id || null;
}

// ── gl_check ────────────────────────────────────────────────────────────────

export interface CheckRow {
  id: string;
  doc_number: string;
  number: string | null;
  kind: "check" | "expense" | "card_charge";
  day: string;
  bank_account_list_id: string;
  payee_type: "vendor" | "customer" | "other" | "other_name";
  payee_id: string | null;
  payee_name: string;
  memo: string | null;
  to_be_printed: boolean;
  status: string;
  qb_txn_id: string | null;
}

interface CheckLineRow {
  account_list_id: string;
  amount_cents: string;
  memo: string | null;
  customer_id: string | null;
  billable: boolean;
}

/**
 * Forma QB de un `gl_check` resuelta desde la base (cuentas, payee, memo con
 * el "Payee: X" cuando no hay ref, líneas con cliente). La comparten el Add
 * (`checkFacts`) y el Mod (`facts-mod.ts`): UNA sola lectura de "cómo se ve este
 * cheque en QuickBooks", así un revise manda exactamente lo que mandaría el Add.
 */
export type CheckQbShape =
  | { ok: false; reason: string }
  | {
      ok: true;
      doc: CheckRow;
      isCard: boolean;
      payeeListId: string | null;
      memo: string | null;
      expenseLines: ExpenseLineInput[];
    };

export async function resolveCheckQbShape(db: GlDocumentDb, id: string): Promise<CheckQbShape> {
  const doc = one<CheckRow>(
    await db.raw(
      `SELECT id, doc_number, number, kind, day::text AS day, bank_account_list_id, payee_type, payee_id,
              payee_name, memo, to_be_printed, status, qb_txn_id
         FROM gl_check WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return { ok: false, reason: "gl_check not found" };
  if (doc.status !== "posted") return { ok: false, reason: `gl_check status is '${doc.status}', expected 'posted'` };

  const lines = (
    await db.raw(
      `SELECT account_list_id, amount_cents::text AS amount_cents, memo, customer_id, billable
         FROM gl_check_line WHERE check_id = ? ORDER BY sort_order ASC`,
      [id]
    )
  ).rows as CheckLineRow[];
  if (lines.length === 0) return { ok: false, reason: "gl_check has no lines" };

  const accounts = await resolveAccounts(db, [doc.bank_account_list_id, ...lines.map((l) => l.account_list_id)]);
  if (!accounts.ok) return { ok: false, reason: accounts.reason };
  const bankType = accounts.accounts.get(doc.bank_account_list_id)!.account_type;
  const isCard = bankType === "CreditCard";
  if (!isCard && bankType !== "Bank")
    return { ok: false, reason: `bank account type '${bankType}' is neither Bank nor CreditCard` };

  let payeeListId: string | null = null;
  let memo = doc.memo?.trim() || null;
  if (doc.payee_type === "vendor") {
    if (!doc.payee_id) return { ok: false, reason: "vendor payee without vendor id" };
    payeeListId = await vendorListId(db, doc.payee_id);
    if (!payeeListId) return { ok: false, reason: `vendor_not_in_quickbooks: ${doc.payee_name} (${doc.payee_id})` };
  } else if (doc.payee_type === "customer" && doc.payee_id) {
    payeeListId = await customerListId(db, doc.payee_id);
  } else if (doc.payee_type === "other_name") {
    if (!doc.payee_id) return { ok: false, reason: "other_name payee without qb_other_name id" };
    payeeListId = await otherNameListId(db, doc.payee_id);
    if (!payeeListId)
      return { ok: false, reason: `other_name_not_in_quickbooks: ${doc.payee_name} (${doc.payee_id})` };
  }
  if (!payeeListId) {
    // Nombre libre (o cliente sin enlace): el payee viaja en el memo para que
    // el documento siga siendo legible en QuickBooks.
    memo = memo ? `Payee: ${doc.payee_name} - ${memo}` : `Payee: ${doc.payee_name}`;
  }

  const expenseLines: ExpenseLineInput[] = [];
  for (const line of lines) {
    const customer = line.customer_id ? await customerListId(db, line.customer_id) : null;
    expenseLines.push({
      accountListId: line.account_list_id,
      amountCents: BigInt(line.amount_cents),
      memo: line.memo,
      customerListId: customer,
      billable: customer ? line.billable : undefined,
    });
  }
  return { ok: true, doc, isCard, payeeListId, memo, expenseLines };
}

async function checkFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const shape = await resolveCheckQbShape(db, id);
  if (!shape.ok) return structural(shape.reason);
  const { doc, isCard, payeeListId, memo, expenseLines } = shape;
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);

  try {
    const qbxml = isCard
      ? buildCreditCardChargeAddQbxml({
          cardAccountListId: doc.bank_account_list_id,
          payeeListId,
          refNumber: toQbRefNumber(doc.number),
          txnDate: doc.day,
          memo,
          lines: expenseLines,
        })
      : buildCheckAddQbxml({
          bankAccountListId: doc.bank_account_list_id,
          payeeListId,
          refNumber: toQbRefNumber(doc.number),
          txnDate: doc.day,
          memo,
          isToBePrinted: doc.to_be_printed === true,
          lines: expenseLines,
        });
    return { ready: true, qbxml, qbTxnType: isCard ? "CreditCardCharge" : "Check", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the check QBXML");
  }
}

// ── gl_transfer ─────────────────────────────────────────────────────────────

interface TransferRow {
  id: string;
  doc_number: string;
  day: string;
  from_account_list_id: string;
  to_account_list_id: string;
  amount_cents: string;
  fee_cents: string | null;
  fee_account_list_id: string | null;
  memo: string | null;
  status: string;
  qb_txn_id: string | null;
}

async function transferFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const doc = one<TransferRow>(
    await db.raw(
      `SELECT id, doc_number, day::text AS day, from_account_list_id, to_account_list_id,
              amount_cents::text AS amount_cents, fee_cents::text AS fee_cents, fee_account_list_id,
              memo, status, qb_txn_id
         FROM gl_transfer WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return structural("gl_transfer not found");
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);
  if (doc.status !== "posted") return structural(`gl_transfer status is '${doc.status}', expected 'posted'`);

  const fee = doc.fee_cents ? BigInt(doc.fee_cents) : 0n;
  const amount = BigInt(doc.amount_cents);
  if (fee > 0n && !doc.fee_account_list_id) return structural("transfer has a fee without a fee account");

  const accounts = await resolveAccounts(db, [
    doc.from_account_list_id,
    doc.to_account_list_id,
    ...(fee > 0n ? [doc.fee_account_list_id!] : []),
  ]);
  if (!accounts.ok) return structural(accounts.reason);

  const memo = doc.memo?.trim() || `Transfer ${doc.doc_number}`;
  const lines: JournalLineInput[] = [
    { side: "debit", accountListId: doc.to_account_list_id, amountCents: amount - fee, memo },
    ...(fee > 0n
      ? [{ side: "debit" as const, accountListId: doc.fee_account_list_id!, amountCents: fee, memo: `${memo} - bank fee` }]
      : []),
    { side: "credit", accountListId: doc.from_account_list_id, amountCents: amount, memo },
  ];
  try {
    const qbxml = buildJournalEntryAddQbxml({ txnDate: doc.day, refNumber: toQbRefNumber(doc.doc_number), lines });
    return { ready: true, qbxml, qbTxnType: "JournalEntry", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the transfer QBXML");
  }
}

// ── gl_journal_entry ────────────────────────────────────────────────────────

interface JournalRow {
  id: string;
  number: string;
  day: string;
  memo: string | null;
  status: string;
  qb_txn_id: string | null;
}

interface JournalLineRow {
  account_list_id: string;
  debit_cents: string;
  credit_cents: string;
  memo: string | null;
  entity_type: "customer" | "vendor" | "other_name" | null;
  entity_id: string | null;
  entity_name: string | null;
}

const ENTITY_ACCOUNT_TYPES = new Set(["AccountsReceivable", "AccountsPayable"]);

async function journalFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const doc = one<JournalRow>(
    await db.raw(
      `SELECT id, number, day::text AS day, memo, status, qb_txn_id
         FROM gl_journal_entry WHERE id = ? AND deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return structural("gl_journal_entry not found");
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);
  if (doc.status !== "posted") return structural(`gl_journal_entry status is '${doc.status}', expected 'posted'`);

  const rows = (
    await db.raw(
      `SELECT account_list_id, debit_cents::text AS debit_cents, credit_cents::text AS credit_cents,
              memo, entity_type, entity_id, entity_name
         FROM gl_journal_entry_line WHERE journal_entry_id = ? ORDER BY sort_order ASC`,
      [id]
    )
  ).rows as JournalLineRow[];
  if (rows.length === 0) return structural("gl_journal_entry has no lines");

  const accounts = await resolveAccounts(db, rows.map((r) => r.account_list_id));
  if (!accounts.ok) return structural(accounts.reason);

  const lines: JournalLineInput[] = [];
  for (const [i, row] of rows.entries()) {
    const debit = BigInt(row.debit_cents || "0");
    const credit = BigInt(row.credit_cents || "0");
    const side = debit > 0n ? "debit" : "credit";
    const accountType = accounts.accounts.get(row.account_list_id)!.account_type;
    let entityListId: string | null = null;
    if (row.entity_type === "vendor" && row.entity_id) entityListId = await vendorListId(db, row.entity_id);
    if (row.entity_type === "customer" && row.entity_id) entityListId = await customerListId(db, row.entity_id);
    if (row.entity_type === "other_name") {
      // Un Other Name NO puede ir en una línea de A/R ni A/P (QB lo rechaza: 3140);
      // en cualquier otra cuenta es exactamente el Name del asiento de QB.
      entityListId = row.entity_id ? await otherNameListId(db, row.entity_id) : null;
      if (!entityListId)
        return structural(`other_name_not_in_quickbooks: line ${i + 1} (${row.entity_name ?? row.entity_id ?? "?"})`);
      if (ENTITY_ACCOUNT_TYPES.has(accountType))
        return structural(`other_name_on_ar_ap_line: line ${i + 1} (${accountType}) needs a customer/vendor, not an Other Name`);
    }
    if (ENTITY_ACCOUNT_TYPES.has(accountType) && !entityListId) {
      return structural(
        `entity_required_for_ar_ap_line: line ${i + 1} (${accountType}) needs a QuickBooks customer/vendor`
      );
    }
    lines.push({
      side,
      accountListId: row.account_list_id,
      amountCents: side === "debit" ? debit : credit,
      memo: row.memo ?? doc.memo,
      entityListId,
    });
  }
  try {
    const qbxml = buildJournalEntryAddQbxml({ txnDate: doc.day, refNumber: toQbRefNumber(doc.number), lines });
    return { ready: true, qbxml, qbTxnType: "JournalEntry", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the journal entry QBXML");
  }
}

// ── bank_deposit ────────────────────────────────────────────────────────────

interface DepositRow {
  id: string;
  status: string;
  deposit_date: string;
  reference: string;
  memo: string;
  fee_amount: string;
  fee_account_list_id: string | null;
  fee_reference: string | null;
  bank_qb_list_id: string | null;
  bank_name: string | null;
  qb_txn_id: string | null;
  accounting_entry_id: string | null;
}

interface DepositLineRow {
  id: string;
  payment_id: string | null;
  opening_item_id: string | null;
  manual_reference: string | null;
  manual_description: string | null;
  manual_account_list_id: string | null;
  amount: string;
  payment_qb_txn_id: string | null;
  payment_status: string | null;
  /** Surcharge frozen in the line's snapshot when the deposit was recorded ("0.00" when none). */
  surcharge_amount: string | null;
  /** Live principal of the receipt in cents (what QuickBooks will pull from the ReceivePayment). */
  payment_amount_cents: string | null;
  /** Processor-batch refund: cents refunded and the TxnID of its JE in QuickBooks (the deposit line references it). */
  refund_amount_cents: string | null;
  refund_je_txn_id: string | null;
  refund_je_result: unknown;
}

async function depositFacts(db: GlDocumentDb, id: string): Promise<GlDocumentAddFacts> {
  const doc = one<DepositRow>(
    await db.raw(
      `SELECT d.id, d.status, d.deposit_date, d.reference, d.memo, d.fee_amount, d.fee_account_list_id,
              d.fee_reference, d.qb_txn_id,
              COALESCE(d.account_list_id, a.qb_list_id) AS bank_qb_list_id, COALESCE(qa.full_name, a.name) AS bank_name,
              (SELECT e.id FROM bank_journal_entry e
                WHERE e.source_kind = 'bank_deposit' AND e.source_id = d.id AND e.kind = 'document' AND e.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
                ORDER BY e.created_at DESC LIMIT 1) AS accounting_entry_id
         FROM bank_deposit d
         LEFT JOIN bank_account a ON a.id = d.account_id
         LEFT JOIN qb_account qa ON qa.qb_list_id = COALESCE(d.account_list_id, a.qb_list_id) AND qa.deleted_at IS NULL
        WHERE d.id = ? AND d.deleted_at IS NULL`,
      [id]
    )
  );
  if (!doc) return structural("bank_deposit not found");
  if (doc.qb_txn_id) return structural(`already in QuickBooks as ${doc.qb_txn_id}`);
  if (doc.status === "void") return structural("bank_deposit is void");

  const lines = (
    await db.raw(
      `SELECT l.id, l.payment_id, l.opening_item_id, l.manual_reference, l.manual_description, l.manual_account_list_id, l.amount,
              COALESCE(cp.qb->>'txn_id', cp.metadata->>'qb_txn_id',
                -- A payment embedded in a Sales Receipt has no ReceivePayment of its own:
                -- its pipeline row is skipped ("Superseded by Sales Receipt") and the SR —
                -- deposited to Undeposited Funds — is what the DepositLineAdd points at
                -- (09/16/2026: DEP-0685 waited forever on receipt 5023 / SR 29094).
                (SELECT sr.qb_txn_id FROM qb_order_pipeline pp
                   JOIN qb_order_pipeline sr ON sr.order_id = pp.order_id AND sr.step = 'sales_receipt' AND sr.status IN (${SALES_SQL.synced})
                  WHERE pp.reference_id = cp.id AND pp.step = 'payment' AND pp.status IN (${SALES_SQL.skipped})
                    AND pp.error ILIKE 'Superseded by Sales Receipt%'
                  ORDER BY sr.confirmed_at DESC LIMIT 1)) AS payment_qb_txn_id,
              cp.status AS payment_status,
              l.payment_snapshot->>'surcharge_amount' AS surcharge_amount,
              cp.amount::text AS payment_amount_cents,
              cp.metadata->>'refund_amount' AS refund_amount_cents,
              (SELECT je.qb_txn_id FROM gl_journal_entry je WHERE je.id = cp.qb->>'refund_journal_entry_id') AS refund_je_txn_id,
              -- The JE's confirmed AddRs (kept on its pipeline row): the UF credit line's TxnLineID
              -- is what DepositLineAdd must name for a journal entry (PaymentTxnLineID).
              (SELECT pj.qb_result FROM gl_journal_entry je JOIN qb_order_pipeline pj ON pj.reference_id = je.id
                  AND pj.step = 'gl_document_add' AND pj.status IN (${SALES_SQL.synced})
                WHERE je.id = cp.qb->>'refund_journal_entry_id' ORDER BY pj.confirmed_at DESC LIMIT 1) AS refund_je_result
         FROM bank_deposit_line l
         LEFT JOIN customer_payment cp ON cp.id = l.payment_id
        WHERE l.deposit_id = ? AND l.deleted_at IS NULL
        ORDER BY l.created_at ASC, l.id ASC`,
      [id]
    )
  ).rows as DepositLineRow[];
  if (lines.length === 0) return structural("bank_deposit has no lines");
  // El skip domina: un depósito que consume una partida de apertura ya vive
  // en QuickBooks (al 31/12), esté o no posteado acá.
  if (lines.some((l) => l.opening_item_id)) {
    return skip("deposit consumes an opening-balance item that already lives in QuickBooks");
  }
  if (!doc.accounting_entry_id) return structural("bank_deposit is not posted to the ledger (no active deposit journal entry)");
  if (!doc.bank_qb_list_id) return structural(`bank_account_not_in_quickbooks: ${doc.bank_name ?? "?"}`);

  const fee = majorToCents(doc.fee_amount || "0.00");
  if (fee > 0n && !doc.fee_account_list_id) return structural("deposit has a fee without a fee account");
  const uf = one<{ qb_list_id: string }>(
    await db.raw(`SELECT qb_list_id FROM gl_account_map WHERE key = 'undeposited_funds' LIMIT 1`)
  );
  // A manual line names the account the money comes FROM (AP for a vendor
  // refund, Cash Register for cash moved to the bank…); without one it is
  // the pre-cutover Undeposited Funds line.
  const needsUf = lines.some((l) => !l.payment_id && !l.manual_account_list_id);
  if (needsUf && !uf?.qb_list_id) return structural("gl_account_map has no 'undeposited_funds' entry");
  // deposit-surcharge-qb-20260915: the POS deposits a card receipt GROSS (amount +
  // customer surcharge) while the ReceivePayment in QuickBooks carries only the
  // amount. The surcharge comes from the SNAPSHOT frozen on the line (never
  // recomputed from the live payment) and goes to QuickBooks as one income line
  // — `Credit Card Surcharge` — so DepositTotal in QB = the POS document = the
  // bank credit. Fail closed: a card line without its snapshot, or a gross that
  // does not equal principal + surcharge, never produces a short deposit.
  let surchargeCents = 0n;
  for (const line of lines) {
    if (!line.payment_id) continue;
    if (majorToCents(line.amount) < 0n) {
      // Refund netted by the processor: the line must be exactly −refund_amount; QuickBooks pulls it from the JE.
      if (line.refund_amount_cents === null || majorToCents(line.amount) !== -BigInt(line.refund_amount_cents.split(".")[0]!))
        return structural(`deposit line ${line.id} (${line.amount}) is not the refund of payment ${line.payment_id}`);
      continue;
    }
    if (line.surcharge_amount === null) return structural(`deposit line ${line.id} has no surcharge snapshot`);
    const lineSurcharge = majorToCents(line.surcharge_amount);
    // The line must be exactly what QuickBooks will reconstruct: principal (ReceivePayment) + surcharge (income line).
    if (line.payment_amount_cents !== null && majorToCents(line.amount) !== BigInt(line.payment_amount_cents.split(".")[0]!) + lineSurcharge) {
      return structural(`deposit line ${line.id} (${line.amount}) is not principal ${line.payment_amount_cents} + surcharge ${line.surcharge_amount}`);
    }
    surchargeCents += lineSurcharge;
  }
  const surchargeAccount =
    surchargeCents > 0n
      ? one<{ qb_list_id: string }>(await db.raw(`SELECT qb_list_id FROM gl_account_map WHERE key = 'credit_card_surcharge' LIMIT 1`))
      : null;
  if (surchargeCents > 0n && !surchargeAccount?.qb_list_id) return structural("gl_account_map has no 'credit_card_surcharge' entry");

  const accounts = await resolveAccounts(db, [
    doc.bank_qb_list_id,
    ...(fee > 0n ? [doc.fee_account_list_id!] : []),
    ...(needsUf ? [uf!.qb_list_id] : []),
    ...(surchargeAccount ? [surchargeAccount.qb_list_id] : []),
    ...lines.flatMap((l) => (l.manual_account_list_id ? [l.manual_account_list_id] : [])),
  ]);
  if (!accounts.ok) return structural(accounts.reason);

  const blocking: string[] = [];
  const depositLines: DepositLineInput[] = [];
  for (const line of lines) {
    if (line.payment_id && majorToCents(line.amount) < 0n) {
      // Processor-batch refund → the JE (Dr AR / Cr UF) is the negative item in QuickBooks.
      if (!line.refund_je_txn_id) blocking.push(line.payment_id);
      else {
        const ufLine = journalUfCreditLineId(line.refund_je_result, uf?.qb_list_id ?? null);
        if (!ufLine) return structural(`deposit line ${line.id}: journal entry ${line.refund_je_txn_id} has no Undeposited Funds credit line on record`);
        depositLines.push({ paymentTxnId: line.refund_je_txn_id, paymentTxnLineId: ufLine });
      }
    } else if (line.payment_id) {
      if (!line.payment_qb_txn_id) blocking.push(line.payment_id);
      else depositLines.push({ paymentTxnId: line.payment_qb_txn_id });
    } else {
      depositLines.push({
        accountListId: line.manual_account_list_id ?? uf!.qb_list_id,
        amountCents: majorToCents(line.amount),
        memo: line.manual_description || line.manual_reference,
      });
    }
  }
  if (blocking.length > 0) {
    return transient(`waiting on QuickBooks TxnID for payments: ${blocking.join(", ")}`, blocking);
  }
  if (surchargeAccount && surchargeCents > 0n) {
    depositLines.push({
      accountListId: surchargeAccount.qb_list_id,
      amountCents: surchargeCents,
      memo: `Card surcharge ${doc.deposit_date}`,
    });
  }
  if (fee > 0n) {
    depositLines.push({
      accountListId: doc.fee_account_list_id!,
      amountCents: -fee,
      memo: doc.fee_reference ? `Fee ${doc.fee_reference}` : "Fee",
    });
  }
  const memo = [doc.reference?.trim(), doc.memo?.trim()].filter(Boolean).join(" - ") || null;
  try {
    const qbxml = buildDepositAddQbxml({
      txnDate: doc.deposit_date,
      depositToAccountListId: doc.bank_qb_list_id,
      memo,
      lines: depositLines,
    });
    return { ready: true, qbxml, qbTxnType: "Deposit", blockingReferenceIds: [] };
  } catch (error) {
    return structural(error instanceof Error ? error.message : "could not build the deposit QBXML");
  }
}

// ── entrada ─────────────────────────────────────────────────────────────────

/** TxnLineID of the JournalCreditLine that credits Undeposited Funds, from the JE's stored AddRs. */
function journalUfCreditLineId(result: unknown, ufListId: string | null): string | null {
  if (!ufListId || !result || typeof result !== "object") return null;
  const ret = (result as { JournalEntryRet?: { JournalCreditLine?: unknown } }).JournalEntryRet;
  const credits = ret?.JournalCreditLine;
  const list = Array.isArray(credits) ? credits : credits ? [credits] : [];
  for (const credit of list as Array<{ TxnLineID?: string; AccountRef?: { ListID?: string } }>) {
    if (credit?.AccountRef?.ListID === ufListId && credit.TxnLineID) return credit.TxnLineID;
  }
  return null;
}

export async function loadGlDocumentAddFacts(
  db: GlDocumentDb,
  kind: GlDocumentKind,
  documentId: string
): Promise<GlDocumentAddFacts> {
  switch (kind) {
    case "gl_check":
      return checkFacts(db, documentId);
    case "gl_transfer":
      return transferFacts(db, documentId);
    case "gl_journal_entry":
      return journalFacts(db, documentId);
    case "bank_deposit":
      return depositFacts(db, documentId);
    case "gl_sales_tax_payment":
      return salesTaxPaymentFacts(db, documentId);
    case "gl_sales_tax_adjustment":
      return salesTaxAdjustmentFacts(db, documentId);
  }
}

/** El TxnID/tipo vivos del documento (para el void y para el guard anti-doble-ADD). */
export async function loadGlDocumentQbLink(
  db: GlDocumentDb,
  kind: GlDocumentKind,
  documentId: string
): Promise<{ exists: boolean; status: string | null; qb_txn_id: string | null; qb_txn_type: GlQbTxnType | null }> {
  const row = one<{ status: string; qb_txn_id: string | null; qb_txn_type: GlQbTxnType | null }>(
    await db.raw(`SELECT status, qb_txn_id, qb_txn_type FROM ${kind} WHERE id = ? AND deleted_at IS NULL`, [documentId])
  );
  if (!row) return { exists: false, status: null, qb_txn_id: null, qb_txn_type: null };
  return { exists: true, ...row };
}
