/**
 * Order Commissions — escritor único de dominio (docs/ORDER_COMMISSIONS_PLAN.md §6).
 *
 * Toda mutación de comisiones pasa por acá, dentro de una transacción con
 * advisory lock por orden: la ruta verifica PIN/rol ANTES, este módulo asume
 * que la autorización ya ocurrió y se ocupa de la consistencia.
 *
 * El dinero de la orden llega como SNAPSHOT (OrderMoneySnapshot) leído en la
 * MISMA transacción por order-money.ts — el escritor no adivina totales.
 *
 * Semántica de re-guardado (§2.5): mientras TODOS los beneficiarios estén en
 * draft el modal puede re-guardar; los beneficiarios anteriores se soft-deletean
 * (queda la traza) y los nuevos nacen en draft. Pasado el primer estado
 * no-draft, la asignación queda clavada.
 */

import type { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";

import {
  checkCombinedCap,
  commissionBaseCents,
  discountBpsOf,
  eligibleAt as computeEligibleAt,
  recipientAmountCents,
  validateRecipients,
  type RecipientInput,
} from "./calculator";
import { canApprove, canReSaveAssignment, canVoid, refreshedState, type RecipientState } from "./transitions";

export interface OrderMoneySnapshot {
  itemSubtotalCents: number;
  discountCents: number;
  fullyPaidAt: Date | null;
  lastInvoiceAt: Date | null;
}

export class CommissionError extends Error {
  constructor(
    public readonly code:
      | "invalid_recipients"
      | "cap_exceeded"
      | "assignment_locked"
      | "not_found"
      | "invalid_state"
      | "beneficiary_is_order_customer",
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CommissionError";
  }
}

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** Transacción + advisory lock por orden. Única puerta de escritura. */
export async function withOrderCommissionLock<T>(
  pool: Pool,
  orderId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('order_commission:' || $1))", [
      orderId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface RecipientRow {
  id: string;
  order_commission_id: string;
  customer_id: string | null;
  qb_vendor_id: string | null;
  display_name: string;
  percent_bps: number;
  amount_cents: string | number | null;
  eligible_at: Date | null;
  state: RecipientState;
  payout_method: string | null;
}

export interface CommissionRow {
  id: string;
  order_id: string;
  currency_code: string;
  item_subtotal_cents: string | number;
  discount_cents: string | number;
  base_cents: string | number;
  discount_bps: number;
  cap_bps: number;
  wait_days: number;
  version: number;
}

/** Coerción de bigint (pg lo entrega como string). */
export const asInt = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : Number.parseInt(v, 10);

export async function fetchCommission(
  client: PoolClient,
  orderId: string
): Promise<{ commission: CommissionRow; recipients: RecipientRow[] } | null> {
  const { rows } = await client.query<CommissionRow>(
    `SELECT * FROM order_commission WHERE order_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [orderId]
  );
  const commission = rows[0];
  if (!commission) return null;
  const { rows: recipients } = await client.query<RecipientRow>(
    `SELECT * FROM order_commission_recipient
      WHERE order_commission_id = $1 AND deleted_at IS NULL
      ORDER BY assigned_at ASC, id ASC`,
    [commission.id]
  );
  return { commission, recipients };
}

export interface SaveAssignmentInput {
  orderId: string;
  orderCustomerId: string | null;
  currencyCode: string;
  money: OrderMoneySnapshot;
  recipients: Array<RecipientInput & { displayName: string }>;
  capBps: number;
  waitDays: number;
  actorId: string | null;
}

export async function saveAssignment(
  client: PoolClient,
  input: SaveAssignmentInput
): Promise<{ commissionId: string; recipientIds: string[] }> {
  const validation = validateRecipients(input.recipients);
  if (!validation.ok) {
    throw new CommissionError("invalid_recipients", `Invalid recipients: ${validation.reason}`, {
      reason: validation.reason,
    });
  }

  // §5.3 — beneficiario = cliente de la orden es un descuento disfrazado.
  if (
    input.orderCustomerId &&
    input.recipients.some((r) => r.customerId === input.orderCustomerId)
  ) {
    throw new CommissionError(
      "beneficiary_is_order_customer",
      "The order's customer cannot be a beneficiary of its own commission — use a discount instead."
    );
  }

  const cap = checkCombinedCap({
    itemSubtotalCents: input.money.itemSubtotalCents,
    discountCents: input.money.discountCents,
    recipientPercentsBps: input.recipients.map((r) => r.percentBps),
    capBps: input.capBps,
  });
  if (!cap.ok) {
    throw new CommissionError("cap_exceeded", "Discount + commissions exceed the cap.", { ...cap });
  }

  const existing = await fetchCommission(client, input.orderId);
  if (existing && !canReSaveAssignment(existing.recipients.map((r) => r.state))) {
    throw new CommissionError(
      "assignment_locked",
      "This assignment already has accrued or settled recipients — it can no longer be re-saved."
    );
  }

  const base = commissionBaseCents(input.money);
  const discountBps = discountBpsOf(input.money);
  const eligible = computeEligibleAt(
    input.money.fullyPaidAt,
    input.money.lastInvoiceAt,
    input.waitDays
  );

  let commissionId: string;
  if (existing) {
    commissionId = existing.commission.id;
    await client.query(
      `UPDATE order_commission
          SET currency_code = $2, item_subtotal_cents = $3, discount_cents = $4,
              base_cents = $5, discount_bps = $6, cap_bps = $7, wait_days = $8,
              version = version + 1, assigned_by = $9, updated_at = NOW()
        WHERE id = $1`,
      [
        commissionId,
        input.currencyCode,
        input.money.itemSubtotalCents,
        input.money.discountCents,
        base,
        discountBps,
        input.capBps,
        input.waitDays,
        input.actorId,
      ]
    );
    await client.query(
      `UPDATE order_commission_recipient
          SET deleted_at = NOW(), updated_at = NOW()
        WHERE order_commission_id = $1 AND deleted_at IS NULL`,
      [commissionId]
    );
  } else {
    commissionId = newId("ocom");
    await client.query(
      `INSERT INTO order_commission
         (id, order_id, currency_code, item_subtotal_cents, discount_cents, base_cents,
          discount_bps, cap_bps, wait_days, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        commissionId,
        input.orderId,
        input.currencyCode,
        input.money.itemSubtotalCents,
        input.money.discountCents,
        base,
        discountBps,
        input.capBps,
        input.waitDays,
        input.actorId,
      ]
    );
  }

  const recipientIds: string[] = [];
  for (const r of input.recipients) {
    const id = newId("ocre");
    recipientIds.push(id);
    await client.query(
      `INSERT INTO order_commission_recipient
         (id, order_commission_id, customer_id, qb_vendor_id, display_name,
          percent_bps, eligible_at, state, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8)`,
      [
        id,
        commissionId,
        r.customerId ?? null,
        r.qbVendorId ?? null,
        r.displayName,
        r.percentBps,
        eligible,
        input.actorId,
      ]
    );
  }

  return { commissionId, recipientIds };
}

/**
 * Re-lee el dinero y actualiza base + devengo. En DRAFT la base sigue a la
 * orden (una devolución achica la comisión sola, §2.3); draft↔eligible se
 * mueven según el devengo. approved/settling/closed/void no se tocan.
 */
export async function refreshCommission(
  client: PoolClient,
  orderId: string,
  money: OrderMoneySnapshot,
  now: Date = new Date()
): Promise<{ refreshed: boolean }> {
  const existing = await fetchCommission(client, orderId);
  if (!existing) return { refreshed: false };

  const base = commissionBaseCents(money);
  const discountBps = discountBpsOf(money);
  const eligible = computeEligibleAt(money.fullyPaidAt, money.lastInvoiceAt, existing.commission.wait_days);

  const hasMovable = existing.recipients.some((r) => r.state === "draft" || r.state === "eligible");
  if (hasMovable) {
    await client.query(
      `UPDATE order_commission
          SET item_subtotal_cents = $2, discount_cents = $3, base_cents = $4,
              discount_bps = $5, updated_at = NOW()
        WHERE id = $1`,
      [existing.commission.id, money.itemSubtotalCents, money.discountCents, base, discountBps]
    );
  }

  for (const r of existing.recipients) {
    const next = refreshedState(r.state, eligible, now);
    if (next !== r.state || (r.state === "draft" || r.state === "eligible")) {
      await client.query(
        `UPDATE order_commission_recipient
            SET state = $2, eligible_at = $3, updated_at = NOW()
          WHERE id = $1`,
        [r.id, next, eligible]
      );
    }
  }

  return { refreshed: true };
}

export async function approveRecipient(
  client: PoolClient,
  recipientId: string,
  actorId: string | null
): Promise<{ amountCents: number }> {
  const { rows } = await client.query<RecipientRow & { base_cents: string | number }>(
    `SELECT r.*, c.base_cents
       FROM order_commission_recipient r
       JOIN order_commission c ON c.id = r.order_commission_id
      WHERE r.id = $1 AND r.deleted_at IS NULL
      FOR UPDATE OF r`,
    [recipientId]
  );
  const row = rows[0];
  if (!row) throw new CommissionError("not_found", "Recipient not found.");
  if (!canApprove(row.state)) {
    throw new CommissionError("invalid_state", `Cannot approve from state '${row.state}'.`, {
      state: row.state,
    });
  }

  const amountCents = recipientAmountCents(asInt(row.base_cents), row.percent_bps);
  await client.query(
    `UPDATE order_commission_recipient
        SET state = 'approved', amount_cents = $2, approved_by = $3, approved_at = NOW(),
            updated_at = NOW()
      WHERE id = $1`,
    [recipientId, amountCents, actorId]
  );
  return { amountCents };
}

export async function voidRecipient(
  client: PoolClient,
  recipientId: string,
  actorId: string | null,
  reason: string
): Promise<void> {
  const { rows } = await client.query<RecipientRow>(
    `SELECT * FROM order_commission_recipient
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [recipientId]
  );
  const row = rows[0];
  if (!row) throw new CommissionError("not_found", "Recipient not found.");
  if (!canVoid(row.state)) {
    throw new CommissionError("invalid_state", `Cannot void from state '${row.state}'.`, {
      state: row.state,
    });
  }
  await client.query(
    `UPDATE order_commission_recipient
        SET state = 'void', void_reason = $2, settled_by = $3, updated_at = NOW()
      WHERE id = $1`,
    [recipientId, reason, actorId]
  );
}
