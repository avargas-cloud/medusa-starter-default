/**
 * applyOrderDiscount — el ÚNICO escritor del descuento de una orden CONFIRMADA.
 *
 * Plan descuentos-canonicos-v1, Fase 6. Reemplaza a los tres escritores que
 * divergían (las 3 ramas de post-edit-sync, apply-discount-force con su baile
 * de draft-flip, y el fallback de convert-force): una sola fórmula
 * (`allocation.ts`, paridad 23/23 medida contra prod) y UNA transacción.
 *
 * ── Qué escribe, todo o nada ──────────────────────────────────────────────────
 *   adjustments por línea (versión actual) · link order_promotion · metadata
 *   del descuento (discount_type/value, promotion_code, pos_discount_amount,
 *   discount_schema=1) · tax lines · order_summary · computed_total+pos_total ·
 *   payment_collection.amount — dentro de UN BEGIN/COMMIT con advisory lock
 *   por orden. Si algo no se puede derivar, TIRA y no quedó nada a medias
 *   (la mitad escrita es exactamente el estado que envenenó S11432).
 *
 * ── Qué queda AFUERA de la transacción ────────────────────────────────────────
 *   El promo-vehículo CPOS (find-or-create vía workflow de Medusa): un promo
 *   sin usar tras un rollback es residuo inocuo. El caller lo resuelve antes
 *   (`resolveCposPromotion`) y lo pasa acá.
 *
 * ── Idempotencia ──────────────────────────────────────────────────────────────
 *   Por construcción: mismo input → mismo estado final. Re-aplicar lo aplicado
 *   reescribe filas idénticas; quitar lo inexistente deja todo en cero.
 *
 * ── Convenciones que NO se negocian ───────────────────────────────────────────
 *   · `order_line_item_adjustment.amount` está en DÓLARES; todo write numérico
 *     actualiza también su `raw_*` (BigNumber JSONB).
 *   · Los adjustments llevan `version` = MAX(order_item.version) — una versión
 *     vieja es invisible para Medusa y el hard-wipe la borra.
 *   · `pos_total` se escribe con el total DERIVADO, jamás con el del navegador.
 *   · El descuento del metadata usa null explícito para "sin descuento"
 *     (JSONB deep-merge nunca borra claves).
 */
import type { Pool } from "pg";

import {
  isZeroTaxSafe,
  loadOrderMoneyBase,
  replaceOrderTaxLines,
  resolvePatchedOrderTotal,
  resolveQbParityTax,
} from "../order-money/order-tax-lines";
import {
  allocateOrderDiscount,
  type AllocationLine,
  type DiscountIntent,
} from "./allocation";

export interface TaxContext {
  /** Rate estatutario (7 = 7%). */
  ratePercent: number;
  /** Tax que declaró el POS (assertion + entrada de la derivación). */
  posTaxAmount: number;
}

export interface PromoVehicle {
  id: string | null;
  code: string;
}

export interface MiniLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ApplyOrderDiscountInput {
  /** null = quitar el descuento (wipe). */
  intent: DiscountIntent | null;
  /**
   * Lo que el POS declaró en dólares (`pos_discount_amount`) — se contrasta
   * contra la asignación propia y una divergencia real se loguea; la cifra
   * canónica es SIEMPRE la derivada.
   */
  declaredDiscountDollars?: number;
  tax: TaxContext;
  /** Requerido cuando intent != null. */
  promo?: PromoVehicle | null;
  logger?: MiniLogger;
}

export interface ApplyOrderDiscountResult {
  discountDollars: number;
  taxDollars: number;
  totalDollars: number;
  adjustmentLines: number;
  paymentCollectionsUpdated: number;
}

const noopLogger: MiniLogger = { info: () => {}, warn: () => {}, error: () => {} };

function raw20(n: number): string {
  return JSON.stringify({ value: String(n), precision: 20 });
}

export async function applyOrderDiscount(
  pool: Pool,
  orderId: string,
  input: ApplyOrderDiscountInput
): Promise<ApplyOrderDiscountResult> {
  const log = input.logger ?? noopLogger;
  if (input.intent && !input.promo?.code) {
    throw new Error(
      "applyOrderDiscount: intent sin promo-vehículo — resolver el promo CPOS antes (fuera de la tx)"
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `order-discount:${orderId}`,
    ]);

    // Guard inverso del type-guard de pos-discount: el chokepoint es de
    // órdenes CONFIRMADAS; un draft va por los workflows nativos de draft-edit.
    const { rows: ordRows } = await client.query<{ is_draft_order: boolean }>(
      `SELECT is_draft_order FROM "order" WHERE id = $1 AND deleted_at IS NULL`,
      [orderId]
    );
    if (!ordRows[0]) throw new Error(`orden ${orderId} inexistente`);
    if (ordRows[0].is_draft_order) {
      throw new Error(
        `la orden ${orderId} es un DRAFT — el chokepoint es de confirmadas; los drafts van por pos-discount`
      );
    }

    // ── Líneas de la versión ACTUAL ──────────────────────────────────────────
    const { rows: lines } = await client.query<{
      item_id: string;
      unit_price: string;
      quantity: string;
      taxable: boolean;
      cur_version: number;
    }>(
      `SELECT oi.item_id, oli.unit_price::text, oi.quantity::text,
              COALESCE(oli.taxable, true) AS taxable,
              (SELECT MAX(version) FROM order_item WHERE order_id = $1) AS cur_version
         FROM order_item oi
         JOIN order_line_item oli ON oli.id = oi.item_id
        WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
          AND oi.version = (SELECT MAX(version) FROM order_item WHERE order_id = $1)`,
      [orderId]
    );
    if (lines.length === 0) {
      throw new Error(`la orden ${orderId} no tiene líneas en su versión actual`);
    }
    const curVersion = lines[0]!.cur_version;

    // ── Higiene de adjustments (antes vivía en el hard-wipe de la ruta) ─────
    await client.query(
      `DELETE FROM order_line_item_adjustment
        WHERE deleted_at IS NOT NULL
          AND item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
      [orderId]
    );
    await client.query(
      `DELETE FROM order_line_item_adjustment
        WHERE item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)
          AND version != $2`,
      [orderId, curVersion]
    );

    // ── Reconciliación: los adjustments SON lo que el intent declara ────────
    // Modelo escalar: el descuento de la orden es UNO; se reemplaza todo.
    await client.query(
      `DELETE FROM order_line_item_adjustment
        WHERE item_id IN (SELECT DISTINCT item_id FROM order_item WHERE order_id = $1)`,
      [orderId]
    );
    await client.query(`DELETE FROM order_promotion WHERE order_id = $1`, [
      orderId,
    ]);

    let discountDollars = 0;
    let adjustmentLines = 0;
    if (input.intent) {
      const allocInput: AllocationLine[] = lines.map((l) => ({
        itemId: l.item_id,
        netCents: Math.round(Number(l.unit_price) * 100) * Number(l.quantity),
        taxable: l.taxable,
      }));
      const alloc = allocateOrderDiscount(allocInput, input.intent);
      discountDollars = alloc.totalCents / 100;

      if (
        input.declaredDiscountDollars !== undefined &&
        Math.abs(input.declaredDiscountDollars - discountDollars) > 0.005
      ) {
        // La assertion del POS no coincide: se loguea fuerte y GANA la
        // derivación propia — dos verdades para el mismo número es el
        // defecto original de este dominio.
        log.warn(
          `[order-discount] POS declaró $${input.declaredDiscountDollars} y la asignación canónica da $${discountDollars} (${input.intent.type} ${input.intent.value}) — gana la canónica`
        );
      }

      for (const line of alloc.lines) {
        if (line.adjustmentCents <= 0) continue;
        const amount = line.adjustmentCents / 100;
        const adjId = `adj_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        await client.query(
          `INSERT INTO order_line_item_adjustment
             (id, item_id, code, amount, raw_amount, promotion_id, description,
              is_tax_inclusive, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, false, $8, NOW(), NOW())`,
          [
            adjId,
            line.itemId,
            input.promo!.code,
            amount,
            raw20(amount),
            input.promo!.id,
            "POS Order Discount",
            curVersion,
          ]
        );
        adjustmentLines++;
      }
      if (input.promo!.id) {
        const linkId = `ordpr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        await client.query(
          `INSERT INTO order_promotion (id, order_id, promotion_id, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT DO NOTHING`,
          [linkId, orderId, input.promo!.id]
        );
      }
    }

    // ── Metadata del descuento (una sola forma, null explícito) ─────────────
    await client.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'discount_type',       $2::text,
                'discount_value',      $3::numeric,
                'promotion_code',      $4::text,
                'pos_discount_amount', $5::numeric,
                'discount_schema',     1
              ),
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [
        orderId,
        input.intent ? input.intent.type : null,
        input.intent ? input.intent.value : null,
        input.intent ? input.promo!.code : null,
        discountDollars,
      ]
    );

    // ── Tax lines por línea (misma función que siempre, en ESTA tx) ─────────
    const taxRewrite = await replaceOrderTaxLines(
      client,
      orderId,
      input.tax.ratePercent
    );

    // ── Totales canónicos: los TRES campos + summary, desde la base ─────────
    const moneyBase = await loadOrderMoneyBase(client, orderId);
    const resolved = resolvePatchedOrderTotal({
      base: moneyBase,
      posTaxAmount: input.tax.posTaxAmount,
      discount: discountDollars,
    });
    if (!resolved.ok) {
      // refuse-no-guess: este número es el techo del clamp de depósitos.
      throw new Error(`total no derivable: ${resolved.reason}`);
    }
    for (const w of resolved.warnings) log.warn(`[order-discount] ${w}`);

    let taxTotalToWrite = input.tax.posTaxAmount;
    if (input.tax.posTaxAmount === 0 && !isZeroTaxSafe(taxRewrite)) {
      const recomputed = resolveQbParityTax(
        moneyBase,
        discountDollars,
        input.tax.ratePercent
      );
      taxTotalToWrite = recomputed.tax;
      log.warn(
        `[order-discount] POS mandó tax 0 con ${taxRewrite.taxedItemIds.length} línea(s) taxable; recomputado $${taxTotalToWrite} @ ${input.tax.ratePercent}%`
      );
    }
    const totalDollars =
      taxTotalToWrite === input.tax.posTaxAmount
        ? resolved.total
        : (() => {
            const redo = resolvePatchedOrderTotal({
              base: moneyBase,
              posTaxAmount: taxTotalToWrite,
              discount: discountDollars,
            });
            if (!redo.ok) throw new Error(`total no derivable (retax): ${redo.reason}`);
            return redo.total;
          })();

    const { rows: sumRows } = await client.query<{ id: string; totals: any }>(
      `SELECT id, totals FROM order_summary
        WHERE order_id = $1 AND deleted_at IS NULL
        ORDER BY version DESC LIMIT 1`,
      [orderId]
    );
    if (!sumRows[0]) {
      throw new Error(`la orden ${orderId} no tiene order_summary`);
    }
    await client.query(
      `UPDATE order_summary SET totals = $1, updated_at = NOW() WHERE id = $2`,
      [
        JSON.stringify({
          ...sumRows[0].totals,
          discount_total: discountDollars,
          raw_discount_total: { value: String(discountDollars), precision: 20 },
          tax_total: taxTotalToWrite,
          raw_tax_total: { value: String(taxTotalToWrite), precision: 20 },
          accounting_total: totalDollars,
          raw_accounting_total: { value: String(totalDollars), precision: 20 },
          current_order_total: totalDollars,
          raw_current_order_total: { value: String(totalDollars), precision: 20 },
          pending_difference: totalDollars,
          raw_pending_difference: { value: String(totalDollars), precision: 20 },
        }),
        sumRows[0].id,
      ]
    );
    await client.query(
      `UPDATE "order"
          SET metadata = COALESCE(metadata, '{}') || jsonb_build_object(
                'computed_total', $1::numeric,
                'pos_total',      $1::numeric
              )
        WHERE id = $2`,
      [totalDollars, orderId]
    );

    // ── payment_collection: el cuarto total, en la MISMA tx ─────────────────
    const pcRes = await client.query(
      `UPDATE payment_collection pc
          SET amount = $1, raw_amount = $2::jsonb, updated_at = NOW()
        WHERE pc.id IN (
          SELECT payment_collection_id FROM order_payment_collection
           WHERE order_id = $3
        ) AND pc.deleted_at IS NULL`,
      [totalDollars, raw20(totalDollars), orderId]
    );

    await client.query("COMMIT");
    log.info(
      `[order-discount] ✅ ${orderId}: descuento $${discountDollars} (${adjustmentLines} líneas) · tax $${taxTotalToWrite} · total $${totalDollars} · ${pcRes.rowCount ?? 0} payment collection(s)`
    );
    return {
      discountDollars,
      taxDollars: taxTotalToWrite,
      totalDollars,
      adjustmentLines,
      paymentCollectionsUpdated: pcRes.rowCount ?? 0,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
