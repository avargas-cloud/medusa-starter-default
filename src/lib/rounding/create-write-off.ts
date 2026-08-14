/**
 * src/lib/rounding/create-write-off.ts
 *
 * Emite el ajuste que salda el residuo de centavos de una factura. La aritmética
 * y el porqué viven en `./write-off.ts`; acá está el efecto.
 *
 * Se llama DESPUÉS de aplicar un pago, cuando ya se sabe cuánto quedó abierto.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { INVOICE_MODULE } from "../../modules/invoices";

import { loadRoundingConfig } from "./config";
import {
  ROUNDING_REASON_CODE,
  buildRoundingMemo,
  resolveRoundingResidual,
  type RoundingDirection,
} from "./write-off";

export interface RoundingWriteOffOutcome {
  /** Se emitió el ajuste y la factura queda saldada. */
  created: boolean;
  /** Monto absorbido, en centavos. 0 si no se emitió nada. */
  amountCents: number;
  direction: RoundingDirection | null;
  /** Id de la fila `pos_rounding_adjustment`, si se creó. */
  adjustmentId: string | null;
  /**
   * Por qué NO se emitió. `null` cuando sí se emitió.
   *
   * Nunca es una excepción: no poder absorber un residuo es un resultado
   * legítimo (el caso normal es que no haya residuo), y hacer fallar el apply de
   * un pago de $674.95 por un centavo sería mucho peor que dejar el centavo.
   */
  skippedReason: string | null;
}

/**
 * Centavos ya absorbidos por un ajuste VIVO de esta factura.
 *
 * Todo cálculo de "cuánto queda debiendo" DEBE restar esto, no sólo el dinero
 * aplicado. El saldo de una factura se re-deriva de cero en cada apply
 * (`total − Σ aplicado`), así que un write-off que sólo escribiera
 * `balance_due = 0` se evaporaría en el apply siguiente: la ruta volvería a ver
 * el centavo abierto y aplicaría plata real contra algo que ya se había
 * absorbido, dejándolo cubierto DOS veces.
 *
 * Lo cazó el E2E — ningún type-check ni unit test podía verlo, porque el
 * defecto sólo existe en la SEGUNDA aplicación.
 */
export async function getLiveRoundingWriteOffCents(
  container: MedusaContainer,
  invoiceId: string
): Promise<number> {
  const invoiceService: any = container.resolve(INVOICE_MODULE);
  try {
    const rows = await invoiceService.listRoundingAdjustments({
      invoice_id: invoiceId,
      voided_at: null,
    });
    return (rows ?? []).reduce(
      (sum: number, r: any) => sum + Number(r?.amount_cents ?? 0),
      0
    );
  } catch {
    // Fail-open: no poder leer los ajustes nunca debe impedir cobrar.
    return 0;
  }
}

const NOOP: RoundingWriteOffOutcome = {
  created: false,
  amountCents: 0,
  direction: null,
  adjustmentId: null,
  skippedReason: null,
};

/**
 * Intenta saldar el residuo de una factura recién actualizada.
 *
 * @param balanceDueCents Saldo que quedó abierto tras aplicar el pago, en
 *   CENTAVOS. Positivo = la factura pide más de lo que entró.
 *
 * Devuelve siempre un outcome; nunca tira. El caller decide si cerrar la factura
 * mirando `created`.
 */
export async function createRoundingWriteOff(
  container: MedusaContainer,
  params: {
    invoiceId: string;
    invoiceNumber: string | number;
    orderId: string | null;
    balanceDueCents: number;
    actor: string | null;
  }
): Promise<RoundingWriteOffOutcome> {
  // Sin las cuentas configuradas en `store.metadata` el mecanismo entero está
  // apagado y el sistema se comporta exactamente como antes de que existiera.
  const config = await loadRoundingConfig();
  if (!config) {
    return { ...NOOP, skippedReason: "mecanismo apagado (cuentas sin configurar)" };
  }

  const resolution = resolveRoundingResidual(params.balanceDueCents);
  if (resolution.kind === "none") return NOOP;
  if (resolution.kind === "refused") {
    // No es un error: es una factura que legítimamente sigue debiendo plata.
    return { ...NOOP, skippedReason: resolution.reason };
  }

  const accountListId =
    resolution.accountKey === "shortage"
      ? config.shortageAccountListId
      : config.overageAccountListId;

  const invoiceService: any = container.resolve(INVOICE_MODULE);

  try {
    const created = await invoiceService.createRoundingAdjustments({
      // `shortage` cierra la FACTURA. La rama `overage` (sobra plata sin factura
      // donde aplicarla) apunta a un PAGO y todavía no tiene emisor: su
      // mecánica en QuickBooks no es espejo de ésta —un descuento reduce lo que
      // el cliente debe, no sirve para plata que sobra— así que se construye
      // aparte. El CHECK de la tabla impide que se emita mal desde acá.
      invoice_id: params.invoiceId,
      order_id: params.orderId,
      amount_cents: resolution.amountCents,
      direction: resolution.direction,
      account_list_id: accountListId,
      reason_code: ROUNDING_REASON_CODE,
      memo: buildRoundingMemo(params.invoiceNumber),
      actor: params.actor,
      // La pata de QuickBooks es asíncrona y NO gatea el cierre local: la fila
      // es autoritativa para el POS y un rechazo de QB lo levanta el digest,
      // dejando la factura como está hoy en vez de en limbo.
      qb_status: "pending",
    });

    const row = Array.isArray(created) ? created[0] : created;
    return {
      created: true,
      amountCents: resolution.amountCents,
      direction: resolution.direction,
      adjustmentId: row?.id ?? null,
      skippedReason: null,
    };
  } catch (err: any) {
    // El índice único parcial (una factura no puede tener dos ajustes VIVOS) es
    // la idempotencia real: si otro request ganó la carrera, el residuo YA está
    // saldado y este intento no tiene nada que hacer. No es una falla.
    const msg = String(err?.message ?? err);
    if (/duplicate key|unique constraint/i.test(msg)) {
      return { ...NOOP, skippedReason: "ya existe un ajuste vivo para esta factura" };
    }
    return { ...NOOP, skippedReason: `error al emitir el ajuste: ${msg}` };
  }
}
