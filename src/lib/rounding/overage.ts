/**
 * src/lib/rounding/overage.ts
 *
 * La dirección ESPEJO del write-off: sobra plata que ninguna factura puede
 * recibir.
 *
 * ── Por qué no es "residual negativo" ─────────────────────────────────────────
 * La rama de shortage se ancla en la FACTURA y se detecta en cada apply. El
 * overage NO se puede detectar así, y esto costó entenderlo:
 *
 *   El route de apply CLAMPEA — `min(pedido, saldo de la factura, disponible)` y
 *   `max(0, total − aplicado − absorbido)`. Por lo tanto **una factura no puede
 *   quedar sobrepagada por ese camino, nunca.** Un `residual` negativo es un
 *   estado inalcanzable, y buscarlo ahí es buscar donde no está.
 *
 * El sobrante vive en el PAGO:
 *
 *   Orden 885.87 · el cliente paga 885.87
 *   Las fracciones del tax redondean ABAJO: A=210.91 · B=674.95 → Σ = 885.86
 *   Se aplica todo lo aplicable. Al pago le queda 1¢ sin destino posible.
 *
 * Ese centavo no pertenece a ninguna factura. Pertenece al pago, y sólo se puede
 * DIAGNOSTICAR cuando la orden ya no va a emitir más facturas — antes,
 * "sobra plata" es indistinguible de "todavía falta facturar", y absorberlo ahí
 * sería quedarse con un adelanto del cliente.
 *
 * De ahí que el disparador tenga TRES partes, y las tres sean necesarias.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { INVOICE_MODULE } from "../../modules/invoices";

import { loadRoundingConfig } from "./config";
import { createOverageJournalInQb, buildOverageJournal } from "./overage-qb";
import {
  ROUNDING_REASON_CODE,
  ROUNDING_WRITE_OFF_CAP_CENTS,
} from "./write-off";

/**
 * Los hechos que decide el disparador. Se leen de la DB, pero la DECISIÓN es
 * pura para poder probar las ramas sin montar Postgres.
 */
export interface OverageFacts {
  /** Orden a la que el pago está atribuido. `null` = sin atribución. */
  orderId: string | null;
  /** `amount − Σ(aplicaciones vivas)`, en centavos. */
  remainderCents: number;
  /** Total de la orden (`order_money_projection`). `null` = ilegible. */
  orderTotalCents: number | null;
  /** Σ de los totales de las facturas VIVAS de la orden, en centavos. */
  invoicedCents: number;
  /** Σ de los saldos abiertos de esas facturas, en centavos. */
  openBalanceCents: number;
}

export type OverageDecision =
  | { kind: "absorb"; amountCents: number }
  | { kind: "skip"; reason: string };

/**
 * ¿Este pago está en estado de overage?
 *
 * Las tres condiciones, y por qué ninguna sobra:
 *
 * 1. **Sobra plata, y poca.** `0 < remanente ≤ tope`. Un remanente grande no es
 *    redondeo — es un adelanto, o plata que el operador todavía no aplicó.
 * 2. **La orden ya no va a facturar más.** Sin esto, absorberíamos el anticipo de
 *    una factura que aún no existe. Es la condición que hace que el overage sólo
 *    se pueda diagnosticar al cerrar, no en cada apply.
 * 3. **Ninguna factura de la orden debe nada.** Si alguna sigue abierta, el
 *    remanente todavía tiene a dónde ir y aplicarlo es lo correcto — absorberlo
 *    sería regalarle a la cuenta de resultados plata que el cliente debía usar.
 *
 * Función pura: no lee env, no toca la DB, no habla con QuickBooks.
 */
export function decideOverage(facts: OverageFacts): OverageDecision {
  const { remainderCents, orderId, orderTotalCents, invoicedCents, openBalanceCents } =
    facts;

  if (!Number.isInteger(remainderCents)) {
    return { kind: "skip", reason: "el remanente no es un entero de centavos" };
  }
  if (remainderCents <= 0) {
    return { kind: "skip", reason: "no sobra plata" };
  }
  if (remainderCents > ROUNDING_WRITE_OFF_CAP_CENTS) {
    return {
      kind: "skip",
      reason:
        `sobran ${remainderCents}¢, por encima del tope de ` +
        `${ROUNDING_WRITE_OFF_CAP_CENTS}¢ — no es redondeo`,
    };
  }

  // Sin saber a qué orden pertenece, no se puede afirmar que no tenga destino:
  // podría ser un depósito general del cliente. Fail-closed.
  if (!orderId) {
    return { kind: "skip", reason: "el pago no está atribuido a ninguna orden" };
  }
  if (orderTotalCents === null || !Number.isFinite(orderTotalCents)) {
    return { kind: "skip", reason: "no se pudo leer el total de la orden" };
  }

  // (2) ¿Terminó de facturarse? Si falta emitir, el remanente es de la factura
  // que viene, no un sobrante.
  if (invoicedCents < orderTotalCents) {
    return {
      kind: "skip",
      reason:
        `la orden todavía no está totalmente facturada ` +
        `(${invoicedCents}¢ de ${orderTotalCents}¢)`,
    };
  }

  // (3) ¿Quedó alguna factura debiendo? Entonces el remanente tiene destino.
  if (openBalanceCents > 0) {
    return {
      kind: "skip",
      reason: `quedan ${openBalanceCents}¢ de saldo abierto en la orden`,
    };
  }

  return { kind: "absorb", amountCents: remainderCents };
}

/** Lee los hechos del pago desde Postgres. */
export async function loadOverageFacts(
  paymentId: string
): Promise<OverageFacts | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `
    WITH pay AS (
      SELECT cp.id,
             cp.amount::numeric AS amount_cents,
             -- Atribución canónica, la misma que usa order_money_projection.
             COALESCE(cp.locked_order_id, cp.metadata->>'order_id') AS order_id,
             COALESCE((
               SELECT SUM(pa.amount_applied)
                 FROM payment_application pa
                WHERE pa.payment_id = cp.id
                  AND pa.voided_at IS NULL
                  AND pa.deleted_at IS NULL
             ), 0) AS applied_cents
        FROM customer_payment cp
       WHERE cp.id = $1
         AND cp.status <> 'voided'
         AND cp.deleted_at IS NULL
    )
    SELECT p.order_id,
           (p.amount_cents - p.applied_cents)::int AS remainder_cents,
           omp.order_total_cents,
           COALESCE((
             SELECT SUM(i.total) FROM pos_invoice i
              WHERE i.order_id = p.order_id
                AND i.voided_at IS NULL AND i.deleted_at IS NULL
                AND i.status <> 'draft'
           ), 0)::int AS invoiced_cents,
           COALESCE((
             SELECT SUM(i.balance_due) FROM pos_invoice i
              WHERE i.order_id = p.order_id
                AND i.voided_at IS NULL AND i.deleted_at IS NULL
                AND i.status <> 'draft'
           ), 0)::int AS open_balance_cents
      FROM pay p
      LEFT JOIN order_money_projection omp ON omp.order_id = p.order_id
    `,
    [paymentId]
  );

  const r = rows[0];
  if (!r) return null;
  return {
    orderId: r.order_id ?? null,
    remainderCents: Number(r.remainder_cents ?? 0),
    orderTotalCents:
      r.order_total_cents === null || r.order_total_cents === undefined
        ? null
        : Number(r.order_total_cents),
    invoicedCents: Number(r.invoiced_cents ?? 0),
    openBalanceCents: Number(r.open_balance_cents ?? 0),
  };
}

export interface OverageOutcome {
  created: boolean;
  amountCents: number;
  adjustmentId: string | null;
  skippedReason: string | null;
}

const NOOP: OverageOutcome = {
  created: false,
  amountCents: 0,
  adjustmentId: null,
  skippedReason: null,
};

/**
 * Emite el ajuste de overage si el pago está en ese estado.
 *
 * Nunca tira: no poder absorber un sobrante es un resultado legítimo (el caso
 * normal es que no haya ninguno), y hacer fallar un cobro por un centavo sería
 * mucho peor que dejar el centavo.
 */
export async function createOverageWriteOff(
  container: MedusaContainer,
  params: {
    paymentId: string;
    paymentRef: string | number;
    actor: string | null;
    /** YYYY-MM-DD del evento. Explícita SIEMPRE — ver `overage-qb.ts`. */
    businessDate: string;
  }
): Promise<OverageOutcome> {
  const config = await loadRoundingConfig();
  if (!config) {
    return { ...NOOP, skippedReason: "mecanismo apagado (cuentas sin configurar)" };
  }

  let facts: OverageFacts | null;
  try {
    facts = await loadOverageFacts(params.paymentId);
  } catch (err: any) {
    return { ...NOOP, skippedReason: `no se pudieron leer los hechos: ${err.message}` };
  }
  if (!facts) return { ...NOOP, skippedReason: "pago no encontrado o anulado" };

  const decision = decideOverage(facts);
  if (decision.kind === "skip") {
    return { ...NOOP, skippedReason: decision.reason };
  }

  const accountListId = config.overageAccountListId;

  const invoiceService: any = container.resolve(INVOICE_MODULE);
  try {
    const created = await invoiceService.createRoundingAdjustments({
      // Ancla el PAGO, no una factura — el CHECK de la tabla lo impone.
      payment_id: params.paymentId,
      order_id: facts.orderId,
      amount_cents: decision.amountCents,
      direction: "overage",
      account_list_id: accountListId,
      reason_code: ROUNDING_REASON_CODE,
      memo: `Rounding - PAY ${params.paymentRef}`,
      actor: params.actor,
      qb_status: "pending",
    });
    const row = Array.isArray(created) ? created[0] : created;

    // ── Pata contable: el asiento en QuickBooks ──────────────────────────────
    //
    // La fila local YA es autoritativa para el POS y NO espera a QuickBooks: si
    // el asiento falla, esto queda `failed`, el digest lo levanta, y el sobrante
    // sigue visible en el pago — el estado previo a este mecanismo. Acoplar el
    // cierre local a QB dejaría el pago en limbo ante cualquier hipo del bridge.
    //
    // `qb_status` sólo pasa a `confirmed` cuando alguien POLLEA el resultado
    // real del bridge. Encolar no es confirmar.
    if (row?.id) {
      const customerListId = await loadCustomerQbListId(params.paymentId);
      if (!customerListId) {
        await markQbSkipped(invoiceService, row.id, "el cliente no tiene qb_list_id");
      } else {
        try {
          const payload = buildOverageJournal(
            {
              amountCents: decision.amountCents,
              customerListId,
              overageAccountListId: accountListId,
              date: params.businessDate,
              memo: `Rounding - PAY ${params.paymentRef}`,
            },
            config.arAccountListId
          );
          const res = await createOverageJournalInQb(payload, row.id);
          await invoiceService.updateRoundingAdjustments({
            id: row.id,
            ...(res.success
              ? { qb_op_id: res.data?.operationId ?? null }
              : { qb_status: "failed", qb_error: res.error ?? "encolado falló" }),
          });
        } catch (jErr: any) {
          await markQbSkipped(invoiceService, row.id, jErr.message);
        }
      }
    }

    return {
      created: true,
      amountCents: decision.amountCents,
      adjustmentId: row?.id ?? null,
      skippedReason: null,
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // El índice único parcial es la idempotencia real: si otro request ganó la
    // carrera, el sobrante YA está absorbido.
    if (/duplicate key|unique constraint/i.test(msg)) {
      return { ...NOOP, skippedReason: "ya existe un ajuste vivo para este pago" };
    }
    return { ...NOOP, skippedReason: `error al emitir el ajuste: ${msg}` };
  }
}

/** ListID del cliente dueño del pago. `null` = el cliente no está en QuickBooks. */
async function loadCustomerQbListId(paymentId: string): Promise<string | null> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT c.metadata->>'qb_list_id' AS qb_list_id
       FROM customer_payment cp
       JOIN customer c ON c.id = cp.customer_id
      WHERE cp.id = $1`,
    [paymentId]
  );
  const v = rows[0]?.qb_list_id;
  return v && String(v).trim().length > 0 ? String(v).trim() : null;
}

/**
 * El ajuste local vale igual; lo que no hay es nada que esperar de QuickBooks.
 * `skipped` y no `failed` a propósito: nada nuestro falló, y un badge rojo que
 * ningún retry limpia enseña a ignorar los badges.
 */
async function markQbSkipped(
  invoiceService: any,
  id: string,
  reason: string
): Promise<void> {
  await invoiceService
    .updateRoundingAdjustments({ id, qb_status: "skipped", qb_error: reason })
    .catch(() => {});
}
