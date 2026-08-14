/**
 * src/lib/rounding/overage-qb.ts
 *
 * El asiento que lleva un overage a QuickBooks.
 *
 * ── El asiento ────────────────────────────────────────────────────────────────
 *
 *   Débito   Accounts Receivable      0.01   + EntityRef del cliente
 *   Crédito  Cash Discrepancies:Overages 0.01
 *
 * El `EntityRef` en la línea de A/R no es decoración: sin él el movimiento no se
 * imputa a ningún cliente y el crédito que sobraba sigue colgado en su cuenta
 * corriente. Con él, la queda en cero.
 *
 * ── Lo que este archivo NO hace, y por qué ────────────────────────────────────
 * No toca la factura. Ninguna dirección del write-off lo hace: la factura es el
 * mismo documento en el POS y en QuickBooks, y un `InvoiceMod` con líneas sobre
 * una factura SO-linked puede romper el `LinkToTxn` de forma irrecuperable.
 *
 * ── Corregirlo ────────────────────────────────────────────────────────────────
 * `TxnDel` + reemitir, nunca un Mod. Está confirmado por sondeo que un Journal
 * Entry se puede borrar; `JournalEntryMod` quedó como forma NO confirmada.
 *
 * ── Pendiente medible, declarado ──────────────────────────────────────────────
 * Falta comprobar si este asiento hace bajar el `UnusedPayment` del
 * `ReceivePaymentRet`. Si NO lo baja, el centavo queda visible como "sin
 * aplicar" en una pantalla interna de QuickBooks aunque el saldo del cliente sea
 * correcto — un lunar cosmético que se acepta a cambio de no mintear un
 * documento por cada caso. Si además se propagara (aging, auto-apply,
 * conciliación), el diseño cambia a la vía del documento, que sí consume el pago.
 */

import { bridgeFetch } from "../quickbooks/client/core";

export interface OverageJournalInput {
  /** Centavos absorbidos. Positivo. */
  amountCents: number;
  /** ListID del cliente en QuickBooks — imputa el movimiento de A/R. */
  customerListId: string;
  /** ListID de `Cash Discrepancies:Overages`. */
  overageAccountListId: string;
  /** YYYY-MM-DD. Explícito SIEMPRE: sin él QB estampa el reloj de su propia PC. */
  date: string;
  /** Memo — lo único que distingue este asiento de un descuadre real de caja. */
  memo: string;
}

export interface OverageJournalPayload {
  date: string;
  debitLines: Array<{
    accountListId: string;
    amount: number;
    memo?: string;
    entityListId?: string;
  }>;
  creditLines: Array<{ accountListId: string; amount: number; memo?: string }>;
}

/**
 * Arma el payload del asiento. Puro — testeable sin bridge ni env.
 *
 * Tira si falta algo en vez de emitir un asiento a medias: un movimiento
 * contable incompleto es peor que ninguno.
 */
export function buildOverageJournal(
  input: OverageJournalInput,
  arAccountListId: string
): OverageJournalPayload {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(
      `overage journal: monto inválido (${input.amountCents}¢) — debe ser un entero positivo de centavos`
    );
  }
  if (!input.customerListId) {
    throw new Error(
      "overage journal: falta el ListID del cliente — sin EntityRef el asiento no cancela el crédito de nadie"
    );
  }
  if (!arAccountListId || !input.overageAccountListId) {
    throw new Error("overage journal: falta una de las dos cuentas");
  }

  const amount = input.amountCents / 100;
  return {
    date: input.date,
    debitLines: [
      {
        accountListId: arAccountListId,
        amount,
        memo: input.memo,
        entityListId: input.customerListId,
      },
    ],
    creditLines: [
      { accountListId: input.overageAccountListId, amount, memo: input.memo },
    ],
  };
}

export interface QbAsyncResult {
  operationId: string;
}

/**
 * Encola el asiento en el bridge.
 *
 * `Idempotency-Key` 1:1 con la fila del ajuste: un `JournalEntryAdd` NO es
 * idempotente, y una key que no sea 1:1 con el documento es peor que ninguna
 * (el bridge se tragaría un asiento legítimo distinto — plata faltante es
 * invisible; plata duplicada se ve).
 *
 * Devuelve el `operationId`: **encolar no es confirmar.** Quien necesite saber
 * que el asiento existe tiene que pollear el resultado real, nunca creerle al
 * éxito del encolado.
 */
export async function createOverageJournalInQb(
  payload: OverageJournalPayload,
  adjustmentId: string
): Promise<{ success: boolean; data?: QbAsyncResult; error?: string }> {
  try {
    const data = await bridgeFetch("POST", "/api/journal-entries", payload, {
      idempotencyKey: `rounding-overage:${adjustmentId}`,
    });
    const operationId = data?.operationId;
    if (!operationId) {
      throw new Error("Bridge did not return an operationId for journal entry");
    }
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
