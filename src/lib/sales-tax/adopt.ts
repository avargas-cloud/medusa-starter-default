import type { PoolClient } from "pg";

import { GL_DOCUMENT_ADD_STEP } from "../quickbooks/gl-documents/types";
import { clientInTransactionAsKnex } from "../quickbooks/gl-documents/db-adapters";
import { enqueuePurchaseQbOperation, purchaseOperationKey } from "../purchase-orders/qb-purchase-dependency-chain";
import { qbImportTexts } from "../ledger/adopt/apply";
import { allocateGlNumber, newGlId, toAccountSnapshot } from "../ledger/documents/manual-shared";
import type { QbImportSnapshot } from "../ledger/qb-import/types";

import { periodOfPaymentDay } from "./due-dates";
import { ALLOWANCE_MAX_CENTS } from "./remittance";
import type { SalesTaxSettings } from "./settings";

/**
 * Adopción de los documentos de sales tax que el importador del General Ledger
 * trajo como `qb_import` (sales-tax-center-20260917): los "Sales Tax Payment"
 * pasan a `gl_sales_tax_payment` y los "General Journal" de ajuste (línea del
 * payable con el vendor del DOR) a `gl_sales_tax_adjustment`, adoptando el
 * TxnID y RE-PARENTANDO el asiento existente — mismas líneas, mismos matches,
 * mismos extractos cerrados (arista `adopt` del guard, ver `adopt/guard-sql.ts`).
 * Nunca un ADD a QuickBooks: la fila del pipeline nace `confirmed` con
 * `adopted: true`, igual que en `adopt/apply.ts`.
 *
 * Período: un pago hecho el día D paga el mes ANTERIOR (01/16 → 2025-12); el JE
 * de allowance fechado a fin de mes M cubre la declaración de M−1 (el 01/30 es
 * el allowance del período que se pagó el 01/16). Cuando el cheque de QB ya
 * traía la línea −N sin item, el STA queda APLICADO a ese STP (la línea de
 * ajuste del pago apunta al STA); si no (jun–ago 2026), queda sin aplicar y la
 * pantalla lo muestra así.
 */

export interface ImportedSalesTaxLine {
  account_list_id: string;
  account_name: string;
  account_type: string;
  debit_cents: bigint;
  credit_cents: bigint;
}

export interface ImportedSalesTaxEntry {
  entry_id: string;
  txn_id: string;
  txn_type: "Sales Tax Payment" | "General Journal";
  day: string;
  ref_number: string | null;
  name: string | null;
  snapshot: QbImportSnapshot;
  lines: ImportedSalesTaxLine[];
}

export type SalesTaxAdoptionDecision =
  | {
      target: "gl_sales_tax_payment";
      period: string;
      bank_account_list_id: string;
      tax_cents: bigint;
      adjustments_cents: bigint;
      total_cents: bigint;
    }
  | {
      target: "gl_sales_tax_adjustment";
      period: string;
      type: "collection_allowance" | "other";
      direction: "decrease" | "increase";
      amount_cents: bigint;
      offset_account_list_id: string;
    }
  | { target: "unmapped"; reason: string };

export async function loadImportedSalesTaxEntries(
  client: PoolClient,
  settings: SalesTaxSettings,
  range: { from: string; to: string }
): Promise<{ entries: ImportedSalesTaxEntry[]; already: Set<string> }> {
  const payable = settings.accounts.payable_list_id;
  const { rows } = await client.query<{
    entry_id: string;
    txn_id: string;
    txn_type: "Sales Tax Payment" | "General Journal";
    day: string;
    snapshot: QbImportSnapshot;
    lines: Array<{ account_list_id: string; account_name: string | null; account_type: string | null; debit_cents: string; credit_cents: string }>;
  }>(
    `SELECT e.id AS entry_id, e.source_id AS txn_id, e.source_snapshot->>'txn_type' AS txn_type, e.day::text AS day,
            e.source_snapshot AS snapshot,
            (SELECT jsonb_agg(jsonb_build_object('account_list_id', l.account_list_id, 'account_name', a.full_name,
                    'account_type', a.account_type, 'debit_cents', l.debit_cents::text, 'credit_cents', l.credit_cents::text)
                    ORDER BY l.debit_cents DESC, l.credit_cents DESC)
               FROM bank_journal_line l LEFT JOIN qb_account a ON a.qb_list_id = l.account_list_id
              WHERE l.entry_id = e.id AND l.deleted_at IS NULL) AS lines
       FROM bank_journal_entry e
      WHERE e.source_kind = 'qb_import' AND e.kind = 'document' AND e.deleted_at IS NULL
        AND e.source_snapshot->>'txn_type' IN ('Sales Tax Payment','General Journal')
        AND e.day::date BETWEEN $1::date AND $2::date
        AND EXISTS (SELECT 1 FROM bank_journal_line l WHERE l.entry_id = e.id AND l.deleted_at IS NULL AND l.account_list_id = $3)
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
      ORDER BY e.day, e.source_id`,
    [range.from, range.to, payable]
  );
  const already = new Set<string>();
  const seen = await client.query<{ t: string }>(
    `SELECT qb_txn_id AS t FROM gl_sales_tax_payment WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL
     UNION SELECT qb_txn_id FROM gl_sales_tax_adjustment WHERE qb_txn_id IS NOT NULL AND deleted_at IS NULL`
  );
  for (const r of seen.rows) already.add(r.t);
  const entries = rows.map((r) => ({
    entry_id: r.entry_id,
    txn_id: r.txn_id,
    txn_type: r.txn_type,
    day: r.day,
    ref_number: r.snapshot.ref_number ?? null,
    name: r.snapshot.name ?? null,
    snapshot: r.snapshot,
    lines: (r.lines ?? []).map((l) => ({
      account_list_id: l.account_list_id,
      account_name: l.account_name ?? l.account_list_id,
      account_type: l.account_type ?? "?",
      debit_cents: BigInt(l.debit_cents),
      credit_cents: BigInt(l.credit_cents),
    })),
  }));
  return { entries, already };
}

export function classifyImportedSalesTax(entry: ImportedSalesTaxEntry, settings: SalesTaxSettings): SalesTaxAdoptionDecision {
  const payable = settings.accounts.payable_list_id;
  const payableLines = entry.lines.filter((l) => l.account_list_id === payable);
  const others = entry.lines.filter((l) => l.account_list_id !== payable);
  if (entry.txn_type === "Sales Tax Payment") {
    const bank = others.find((l) => l.account_type === "Bank" && l.credit_cents > 0n);
    if (!bank || others.length !== 1) return { target: "unmapped", reason: "payment without a single bank credit line" };
    const gross = payableLines.reduce((acc, l) => acc + l.debit_cents, 0n);
    const applied = payableLines.reduce((acc, l) => acc + l.credit_cents, 0n);
    if (gross <= 0n || gross - applied !== bank.credit_cents)
      return { target: "unmapped", reason: `payable ${gross}−${applied} ≠ bank ${bank.credit_cents}` };
    return {
      target: "gl_sales_tax_payment",
      period: periodOfPaymentDay(entry.day),
      bank_account_list_id: bank.account_list_id,
      tax_cents: gross,
      adjustments_cents: -applied,
      total_cents: bank.credit_cents,
    };
  }
  // General Journal: exactamente una línea del payable y una contrapartida, nombre = el vendor del DOR
  if (payableLines.length !== 1 || others.length !== 1) return { target: "unmapped", reason: "journal is not payable + one offset" };
  const vendorOk = !!settings.vendor_name && !!entry.name && entry.name.trim().toLowerCase() === settings.vendor_name.trim().toLowerCase();
  if (!vendorOk) return { target: "unmapped", reason: `journal name '${entry.name ?? ""}' is not the tax vendor` };
  const p = payableLines[0]!;
  const offset = others[0]!;
  const direction = p.debit_cents > 0n ? "decrease" : "increase";
  const amount = direction === "decrease" ? p.debit_cents : p.credit_cents;
  const isAllowance =
    direction === "decrease" &&
    amount <= ALLOWANCE_MAX_CENTS &&
    (offset.account_list_id === settings.accounts.adjustment_income_list_id || /adjust/i.test(offset.account_name));
  return {
    target: "gl_sales_tax_adjustment",
    period: periodOfPaymentDay(entry.day),
    type: isAllowance ? "collection_allowance" : "other",
    direction,
    amount_cents: amount,
    offset_account_list_id: offset.account_list_id,
  };
}

async function adoptedPipelineRow(client: PoolClient, table: string, id: string, txnId: string, qbTxnType: string): Promise<void> {
  const knex = clientInTransactionAsKnex(client);
  const payload = { kind: table, document_id: id, qb_txn_type: qbTxnType, qbxml: null, ready: false, reason: `adopted from QuickBooks (${txnId}); no ADD`, adopted: true };
  const op = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: id,
    referenceId: id,
    referenceType: table as "gl_sales_tax_payment" | "gl_sales_tax_adjustment",
    step: GL_DOCUMENT_ADD_STEP,
    payload,
    qbTxnId: txnId,
    operationKey: purchaseOperationKey(GL_DOCUMENT_ADD_STEP, id, payload),
  });
  if (!op) throw new Error("QB_SYNC_ENABLED=false: no se puede registrar la fila adoptada del pipeline");
  await client.query(
    `UPDATE qb_order_pipeline SET status='confirmed', qb_txn_id=$2, confirmed_at=now(), error=NULL, qb_result=$3::jsonb, updated_at=now()
      WHERE id=$1::uuid AND status IN ('pending','waiting')`,
    [op.id, txnId, JSON.stringify({ adopted: true, qb_txn_id: txnId, note: "documento creado en QuickBooks; el POS adopta el TxnID, no manda ADD" })]
  );
}

async function reparent(client: PoolClient, entry: ImportedSalesTaxEntry, sourceKind: string, id: string, docNumber: string): Promise<void> {
  const { rowCount } = await client.query(
    `UPDATE bank_journal_entry SET source_kind = $3, source_id = $4, document_number = $5, updated_at = now()
      WHERE id = $1 AND source_kind = 'qb_import' AND source_id = $2 AND kind = 'document'`,
    [entry.entry_id, entry.txn_id, sourceKind, id, docNumber]
  );
  if (rowCount !== 1) throw new Error(`re-parent falló para ${entry.txn_id}: ${rowCount} filas`);
}

export interface SalesTaxAdoptionItem {
  entry: ImportedSalesTaxEntry;
  decision: SalesTaxAdoptionDecision;
}

export interface SalesTaxApplyResult {
  payments: number;
  adjustments: number;
  applied_links: number;
  totalCents: bigint;
}

/** UNA transacción para todo el lote. Los ajustes van primero (así el pago que los aplicó puede enlazarlos). */
export async function applySalesTaxAdoption(
  client: PoolClient,
  input: { plan: SalesTaxAdoptionItem[]; settings: SalesTaxSettings; actorId: string }
): Promise<SalesTaxApplyResult> {
  const { settings } = input;
  const result: SalesTaxApplyResult = { payments: 0, adjustments: 0, applied_links: 0, totalCents: 0n };
  const accountRows = await client.query<{ qb_list_id: string; full_name: string; account_type: string }>(
    `SELECT qb_list_id, full_name, account_type FROM qb_account WHERE deleted_at IS NULL`
  );
  const accounts = new Map(accountRows.rows.map((a) => [a.qb_list_id, a]));
  const snap = (listId: string) => {
    const a = accounts.get(listId);
    return JSON.stringify(toAccountSnapshot({ id: listId, name: a?.full_name ?? listId, account_type: a?.account_type ?? "?", currency: "USD", normal_balance: null }));
  };
  const ordered = [...input.plan].sort((a, b) => (a.decision.target === b.decision.target ? a.entry.day.localeCompare(b.entry.day) : a.decision.target === "gl_sales_tax_adjustment" ? -1 : 1));
  const adjustmentsByPeriod = new Map<string, string[]>();
  await client.query("BEGIN");
  try {
    for (const item of ordered) {
      const d = item.decision;
      const e = item.entry;
      if (d.target === "unmapped") continue;
      if (d.target === "gl_sales_tax_adjustment") {
        const id = newGlId("gsta");
        const docNumber = await allocateGlNumber(client, "gl_sales_tax_adjustment", "STA");
        await client.query(
          `INSERT INTO gl_sales_tax_adjustment (id, doc_number, period, day, type, direction, amount_cents, payable_list_id, payable_snapshot,
             offset_account_list_id, offset_snapshot, vendor_list_id, vendor_name, reason, memo, status, entry_id, posted_at, created_by,
             qb_txn_id, qb_txn_type, qb_synced_at, qb_source)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,'posted',$16,now(),$17,$18,'JournalEntry',now(),'adopted')`,
          [
            id, docNumber, d.period, e.day, d.type, d.direction, d.amount_cents.toString(), settings.accounts.payable_list_id,
            snap(settings.accounts.payable_list_id), d.offset_account_list_id, snap(d.offset_account_list_id), settings.vendor_list_id,
            settings.vendor_name, "adopted from QuickBooks", qbImportTexts(e.snapshot).description || null, e.entry_id, input.actorId, e.txn_id,
          ]
        );
        await reparent(client, e, "sales_tax_adjustment", id, docNumber);
        await adoptedPipelineRow(client, "gl_sales_tax_adjustment", id, e.txn_id, "JournalEntry");
        if (!adjustmentsByPeriod.has(d.period)) adjustmentsByPeriod.set(d.period, []);
        adjustmentsByPeriod.get(d.period)!.push(id);
        result.adjustments += 1;
        continue;
      }
      const id = newGlId("gstp");
      const docNumber = await allocateGlNumber(client, "gl_sales_tax_payment", "STP");
      await client.query(
        `INSERT INTO gl_sales_tax_payment (id, doc_number, period, day, bank_account_list_id, bank_account_snapshot, payable_list_id, payable_snapshot,
           vendor_list_id, vendor_name, tax_item_list_id, tax_item_name, tax_cents, adjustments_cents, total_cents, reference, memo, status, entry_id,
           posted_at, created_by, qb_txn_id, qb_txn_type, qb_synced_at, qb_source)
         VALUES ($1,$2,$3,$4::date,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,'posted',$18,now(),$19,$20,'SalesTaxPaymentCheck',now(),'adopted')`,
        [
          id, docNumber, d.period, e.day, d.bank_account_list_id, snap(d.bank_account_list_id), settings.accounts.payable_list_id,
          snap(settings.accounts.payable_list_id), settings.vendor_list_id, e.name ?? settings.vendor_name ?? "Sales tax agency",
          settings.tax_item_list_id, settings.tax_item_name, d.tax_cents.toString(), d.adjustments_cents.toString(), d.total_cents.toString(),
          e.ref_number, qbImportTexts(e.snapshot).description || null, e.entry_id, input.actorId, e.txn_id,
        ]
      );
      await client.query(
        `INSERT INTO gl_sales_tax_payment_line (id, payment_id, sort_order, kind, item_sales_tax_list_id, amount_cents, memo) VALUES ($1,$2,1,'tax',$3,$4,$5)`,
        [newGlId("gstpl"), id, settings.tax_item_list_id, d.tax_cents.toString(), settings.tax_item_name]
      );
      if (d.adjustments_cents !== 0n) {
        // el cheque de QB ya aplicó el ajuste: si hay un STA del período sin aplicar, se enlaza
        const candidates = adjustmentsByPeriod.get(d.period) ?? [];
        const linked = candidates.shift() ?? null;
        await client.query(
          `INSERT INTO gl_sales_tax_payment_line (id, payment_id, sort_order, kind, adjustment_id, amount_cents, memo) VALUES ($1,$2,2,'adjustment',$3,$4,$5)`,
          [newGlId("gstpl"), id, linked, d.adjustments_cents.toString(), "adjustment applied in QuickBooks"]
        );
        if (linked) {
          await client.query(`UPDATE gl_sales_tax_adjustment SET applied_payment_id = $2, updated_at = now() WHERE id = $1`, [linked, id]);
          result.applied_links += 1;
        }
      }
      await reparent(client, e, "sales_tax_payment", id, docNumber);
      await adoptedPipelineRow(client, "gl_sales_tax_payment", id, e.txn_id, "SalesTaxPaymentCheck");
      result.payments += 1;
      result.totalCents += d.total_cents;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return result;
}

/** La vuelta exacta: adoptados → soft-delete, asientos → qb_import, pipeline → skipped. */
export async function revertSalesTaxAdoption(client: PoolClient, range: { from: string; to: string }): Promise<{ reverted: number }> {
  let reverted = 0;
  await client.query("BEGIN");
  try {
    for (const [table, kind] of [["gl_sales_tax_payment", "sales_tax_payment"], ["gl_sales_tax_adjustment", "sales_tax_adjustment"]] as const) {
      const { rows } = await client.query<{ id: string; entry_id: string; qb_txn_id: string; snapshot: QbImportSnapshot }>(
        `SELECT d.id, d.entry_id, d.qb_txn_id, e.source_snapshot AS snapshot FROM ${table} d JOIN bank_journal_entry e ON e.id = d.entry_id
          WHERE d.qb_source = 'adopted' AND d.deleted_at IS NULL AND d.status = 'posted' AND d.day >= $1::date AND d.day <= $2::date`,
        [range.from, range.to]
      );
      for (const doc of rows) {
        if (table === "gl_sales_tax_payment")
          await client.query(`UPDATE gl_sales_tax_adjustment SET applied_payment_id = NULL, updated_at = now() WHERE applied_payment_id = $1`, [doc.id]);
        await client.query(`UPDATE ${table} SET deleted_at = now(), doc_number = 'rev:' || id, updated_at = now() WHERE id = $1`, [doc.id]);
        const texts = qbImportTexts(doc.snapshot);
        const { rowCount } = await client.query(
          `UPDATE bank_journal_entry SET source_kind = 'qb_import', source_id = $2, document_number = $3, updated_at = now()
            WHERE id = $1 AND source_kind = $5 AND source_id = $4 AND kind = 'document'`,
          [doc.entry_id, doc.qb_txn_id, texts.document_number, doc.id, kind]
        );
        if (rowCount !== 1) throw new Error(`revert falló para ${doc.id}`);
        await client.query(
          `UPDATE qb_order_pipeline SET status = 'skipped', error = 'adopción revertida', updated_at = now()
            WHERE step = $1 AND reference_type = $2 AND reference_id = $3 AND status = 'confirmed'`,
          [GL_DOCUMENT_ADD_STEP, table, doc.id]
        );
        reverted += 1;
      }
      await client.query(
        `UPDATE document_number_counter SET value = (SELECT COALESCE(max(substring(doc_number from '\\d+$')::int), 0) FROM ${table} WHERE deleted_at IS NULL), updated_at = now() WHERE name = $1`,
        [table]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return { reverted };
}
