/**
 * Vuelta atrás de una liquidación por VENDOR BILL que nadie pagó.
 *
 * Caso real (2026-09-10, COM-1003 / AAF): el beneficiario eligió cheque, se
 * liquidó (bill COMM-S11432 confirmado en QB), y después pidió store credit.
 * No existía ninguna vuelta desde `closed`. Ahora:
 *
 *   · sólo `method = 'vendor_bill'` — la liquidación por store credit ya emitió
 *     Check + ReceivePayment y su vuelta es el void del beneficiario;
 *   · el bill NO puede estar pagado (`qb_is_paid`) — un bill con Bill Payment
 *     Check encima se resuelve en QuickBooks a mano, no desde acá;
 *   · el bill no puede haber movido COSTO (`vendor_bill_cost_log` vivo): un
 *     bill de comisión es `service` contra cuenta y no tiene, pero si alguien
 *     linkeó otro, ese se cancela desde Vendor Bills (replay de costo);
 *   · el bill se cierra igual que el cancel route: draft → soft-delete,
 *     confirmed → `cancelled`, synced → `voided` + fila `vendor_bill_void`
 *     (TxnVoid Bill, despachada por el consolidator);
 *   · el settlement queda `reversed` con la razón; el beneficiario vuelve a
 *     `approved` — conserva `approved_at`/`approved_by` y el monto congelado.
 *     Settle vuelve a estar disponible y ahí se elige Store Credit.
 *
 * Todo en UNA transacción (`withOrderCommissionLock`), filas bajo FOR UPDATE.
 */

import { randomUUID } from "crypto";
import type { PoolClient } from "pg";
import { canUnsettle } from "./transitions";
import { CommissionError, type RecipientRow } from "./writer";

interface SettlementRow {
  id: string;
  method: string;
  status: string;
  vendor_bill_id: string | null;
}

interface BillRow {
  id: string;
  status: string;
  number: string | null;
  qb_txn_id: string | null;
  qb_edit_sequence: string | null;
  qb_is_paid: boolean;
}

export interface UnsettleResult {
  settlementId: string;
  billId: string | null;
  billOutcome: "deleted" | "cancelled" | "voided" | "none";
}

export async function unsettleRecipient(
  client: PoolClient,
  recipientId: string,
  actorId: string | null,
  reason: string
): Promise<UnsettleResult> {
  const { rows: recipients } = await client.query<RecipientRow>(
    `SELECT * FROM order_commission_recipient
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [recipientId]
  );
  const recipient = recipients[0];
  if (!recipient) throw new CommissionError("not_found", "Recipient not found.");
  if (!canUnsettle(recipient.state)) {
    throw new CommissionError(
      "invalid_state",
      `Cannot revert a settlement from state '${recipient.state}'.`,
      { state: recipient.state }
    );
  }

  const { rows: settlements } = await client.query<SettlementRow>(
    `SELECT id, method, status, vendor_bill_id
       FROM commission_settlement
      WHERE recipient_id = $1 AND status IN ('pending', 'qb_waiting', 'confirmed')
      ORDER BY created_at DESC
      FOR UPDATE`,
    [recipientId]
  );
  const settlement = settlements[0];
  if (!settlement) {
    throw new CommissionError("invalid_state", "No live settlement to revert.", {
      reason: "no_live_settlement",
    });
  }
  if (settlement.method !== "vendor_bill") {
    throw new CommissionError(
      "invalid_state",
      "Only a vendor-bill settlement can be reverted; a store-credit settlement already issued its QuickBooks documents.",
      { reason: "method_not_reversible", method: settlement.method }
    );
  }

  let billOutcome: UnsettleResult["billOutcome"] = "none";
  if (settlement.vendor_bill_id) {
    const { rows: bills } = await client.query<BillRow>(
      `SELECT id, status, number, qb_txn_id, qb_edit_sequence, qb_is_paid
         FROM vendor_bill
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [settlement.vendor_bill_id]
    );
    const bill = bills[0];
    if (bill) {
      if (bill.qb_is_paid) {
        throw new CommissionError(
          "invalid_state",
          `Bill ${bill.number ?? bill.id} is already paid in QuickBooks — reverse the payment there first.`,
          { reason: "bill_already_paid", vendor_bill_id: bill.id }
        );
      }
      const { rows: costRows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM vendor_bill_cost_log
          WHERE vendor_bill_id = $1 AND reversed_at IS NULL`,
        [bill.id]
      );
      if (Number(costRows[0]?.n ?? 0) > 0) {
        throw new CommissionError(
          "invalid_state",
          `Bill ${bill.number ?? bill.id} moved inventory cost — cancel it from Vendor Bills (cost replay) before reverting.`,
          { reason: "bill_has_cost_events", vendor_bill_id: bill.id }
        );
      }
      if (bill.status === "draft") {
        await client.query(
          `UPDATE vendor_bill SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [bill.id]
        );
        billOutcome = "deleted";
      } else if (bill.status === "confirmed" || bill.status === "synced") {
        if (bill.status === "synced" && !bill.qb_txn_id) {
          throw new CommissionError(
            "invalid_state",
            `Bill ${bill.number ?? bill.id} is synced without a QuickBooks TxnID — cannot void it.`,
            { reason: "missing_qb_txn_id", vendor_bill_id: bill.id }
          );
        }
        await client.query(
          `UPDATE vendor_bill_revision
              SET status = 'superseded', superseded_at = NOW(), updated_at = NOW()
            WHERE vendor_bill_id = $1 AND status = 'confirmed'`,
          [bill.id]
        );
        if (bill.status === "synced") {
          await client.query(
            `INSERT INTO qb_order_pipeline
               (id, reference_id, reference_type, step, status,
                medusa_ref_number, qb_txn_id, payload, created_at, updated_at)
             VALUES ($1, $2, 'vendor_bill', 'vendor_bill_void', 'pending',
                     $3, $4, $5::jsonb, NOW(), NOW())`,
            [
              randomUUID(),
              bill.id,
              bill.number ?? bill.id,
              bill.qb_txn_id,
              JSON.stringify({
                qb_txn_id: bill.qb_txn_id,
                qb_edit_sequence: bill.qb_edit_sequence,
                reason: `commission unsettle: ${reason}`,
              }),
            ]
          );
        }
        const newStatus = bill.status === "synced" ? "voided" : "cancelled";
        await client.query(
          `UPDATE vendor_bill
              SET status = $2, active_revision_id = NULL, updated_at = NOW()
            WHERE id = $1`,
          [bill.id, newStatus]
        );
        billOutcome = newStatus;
      } else {
        throw new CommissionError(
          "invalid_state",
          `Bill ${bill.number ?? bill.id} is '${bill.status}' — nothing to revert.`,
          { reason: "bill_bad_status", vendor_bill_id: bill.id }
        );
      }
    }
  }

  await client.query(
    `UPDATE commission_settlement
        SET status = 'reversed', failure_reason = $2, updated_at = NOW()
      WHERE id = $1`,
    [settlement.id, `reverted by ${actorId ?? "unknown"}: ${reason}`]
  );
  await client.query(
    `UPDATE order_commission_recipient
        SET state = 'approved', settled_at = NULL, settled_by = NULL,
            payout_method = NULL, updated_at = NOW()
      WHERE id = $1`,
    [recipientId]
  );

  return { settlementId: settlement.id, billId: settlement.vendor_bill_id, billOutcome };
}
