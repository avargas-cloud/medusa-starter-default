/**
 * Defectuosos de un credit memo → InventoryAdjustment en QuickBooks.
 *
 * ── El problema ──────────────────────────────────────────────────────────────
 * Cuando un cliente devuelve producto, el credit memo le acredita TODAS las
 * unidades — también las que volvieron rotas. Pero las rotas no vuelven a
 * stock: el POS restockea `quantity - damaged_qty`.
 *
 * QuickBooks no tiene el concepto de "defectuoso". Su CreditMemo devuelve al
 * inventario la cantidad completa y revierte el COGS completo. Resultado hasta
 * hoy: QB sobreestimaba el inventario y subestimaba el costo, una unidad por
 * cada defectuoso, en silencio (medido el 2026-08-12: 22 unidades / $652.57
 * sobre 15 credit memos desde abril).
 *
 * ── La forma ─────────────────────────────────────────────────────────────────
 * El credit memo se manda a QuickBooks INTACTO, con la cantidad completa — la
 * pata de dinero no se toca. Al lado, un InventoryAdjustment saca las unidades
 * defectuosas contra una cuenta de COGS ("Damaged/Defective Returns"), que es
 * donde el contador quiere ver la pérdida: dentro del margen bruto, medible
 * aparte del COGS ordinario.
 *
 * La alternativa que se descartó era mandar el defectuoso como una línea aparte
 * del propio credit memo. No sirve: si esa línea fuera un ítem de inventario
 * crea un ítem sombra por SKU con su propio costo promedio, y si fuera un ítem
 * de servicio no toca inventario ni revierte COGS — o sea que la pérdida queda
 * INVISIBLE, disuelta en el COGS ordinario, y además esa línea lleva el precio
 * de VENTA cuando la pérdida se mide a COSTO. En los dos casos el historial de
 * devoluciones del SKU miente y el documento del cliente muestra una línea que
 * no existe.
 *
 * ── UN ajuste por credit memo, para toda su vida ─────────────────────────────
 * No se emiten ajustes nuevos por cada corrección. El ajuste ES el estado:
 *
 *   defectuosos 0 → 0     nada; ningún documento en QuickBooks
 *   defectuosos 0 → >0    ADD  — nace el ajuste
 *   defectuosos >0 → >0   MOD  — se edita el mismo documento
 *   defectuosos >0 → 0    VOID — se retira
 *   credit memo voideado  VOID — antes del void del propio credit memo
 *
 * Cambiar sólo la cantidad DEVUELTA, con los defectuosos iguales, no toca el
 * ajuste: el `credit_memo_mod` ya cambia lo que QuickBooks restockea.
 *
 * ── Por qué este archivo es el único que decide ──────────────────────────────
 * Cuatro rutas mutan los defectuosos de un credit memo (complete, edit,
 * damaged, void) y las cuatro llaman ACÁ. La lección que lo impone es la del
 * void-vs-ADD: el guard existía y era correcto, pero vivía en un solo camino, y
 * la factura que entró por el otro nació huérfana en QuickBooks. La regla no es
 * "poner el guard", es que todo camino llame al mismo lugar.
 *
 * Este helper NUNCA llama al bridge. Encola y vuelve. El consolidator es el
 * único que habla con QuickBooks, y refresca EditSequence y TxnLineIDs contra
 * QB justo antes de despachar — nunca contra un cache.
 */

import { getDbPool } from "../../../api/utils/db-pool";
import { getBusinessDateString } from "../../date/et";
import { writePipelineRow } from "../pipeline/row-mutations";

export const CM_DAMAGE_ADD_STEP = "cm_damage_adjustment" as const;
export const CM_DAMAGE_MOD_STEP = "cm_damage_adjustment_mod" as const;
export const CM_DAMAGE_VOID_STEP = "void_cm_damage_adjustment" as const;

/**
 * ListID de la subcuenta de COGS donde cae la pérdida.
 *
 * Sin esta variable el mecanismo entero queda apagado y el sistema se comporta
 * exactamente como antes de existir. Es el interruptor de corte del release: no
 * hay "cuenta por defecto", porque adivinar una cuenta contable es peor que no
 * escribir nada.
 */
export const DAMAGE_ACCOUNT_ENV = "QB_DAMAGED_RETURNS_ACCOUNT_LIST_ID";

export function getDamageAccountListId(): string | null {
  const v = process.env[DAMAGE_ACCOUNT_ENV];
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Tipos de ítem de QuickBooks que NO son de inventario. Un InventoryAdjustment
 * sobre uno de estos lo rechaza QuickBooks: no tienen cantidad en stock que
 * ajustar. Un servicio no puede volver defectuoso, así que en la práctica esto
 * sólo filtra líneas de ajuste o instalación mal cargadas.
 */
const NON_INVENTORY_QB_TYPES = new Set([
  "Service",
  "NonInventory",
  "NonInventoryPart",
  "OtherCharge",
  "Discount",
]);

export interface DamageTargetLine {
  variant_id: string;
  sku: string;
  /** Unidades defectuosas, POSITIVO. Se manda a QuickBooks negado. */
  damaged_qty: number;
}

export interface DamageTarget {
  lines: DamageTargetLine[];
  /** Líneas con defectuosos que no se pueden ajustar, con su motivo. Nunca se ocultan. */
  skipped: Array<{ sku: string | null; reason: string }>;
}

/**
 * Estado DESEADO del ajuste: cuántas unidades defectuosas hay hoy, por SKU.
 *
 * Se agrupa por variante porque un mismo SKU puede aparecer en dos líneas del
 * credit memo (y de hecho aparece: hay 17 credit memos con SKU repetido). QB no
 * necesita saber de qué línea vino cada unidad, sólo cuántas salen del stock.
 *
 * `damaged_qty` se clampea a `quantity`: una línea que devolvió 1 no puede
 * tener 2 defectuosos. La UI ya lo impide y la ruta de daño también, pero un
 * dato viejo o un write directo no pueden convertirse en una escritura a QB.
 */
export async function resolveDamageTarget(
  creditMemoId: string
): Promise<DamageTarget> {
  const pool = getDbPool();

  const { rows } = await pool.query(
    `SELECT cmi.variant_id,
            cmi.sku,
            cmi.quantity,
            cmi.damaged_qty,
            COALESCE(pv.metadata, '{}'::jsonb) AS variant_metadata,
            COALESCE(p.metadata,  '{}'::jsonb) AS product_metadata
       FROM pos_credit_memo_item cmi
       LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
       LEFT JOIN product         p  ON p.id  = pv.product_id
      WHERE cmi.credit_memo_id = $1
        AND cmi.deleted_at IS NULL
        AND COALESCE(cmi.damaged_qty, 0) > 0`,
    [creditMemoId]
  );

  const byVariant = new Map<string, DamageTargetLine>();
  const skipped: DamageTarget["skipped"] = [];

  for (const r of rows) {
    const damaged = Math.min(
      Number(r.damaged_qty ?? 0),
      Number(r.quantity ?? 0)
    );
    if (damaged <= 0) continue;

    if (!r.variant_id || !r.sku) {
      skipped.push({
        sku: r.sku ?? null,
        reason: "línea sin variante o sin SKU — no hay ítem de QuickBooks que ajustar",
      });
      continue;
    }

    const vm = r.variant_metadata ?? {};
    const pm = r.product_metadata ?? {};
    const qbItemType = vm.qb_item_type ?? pm.qb_item_type;
    const isNonInventory =
      vm.quickbooks_is_service === true ||
      vm.quickbooks_is_service === "true" ||
      pm.quickbooks_is_service === true ||
      pm.quickbooks_is_service === "true" ||
      (typeof qbItemType === "string" && NON_INVENTORY_QB_TYPES.has(qbItemType));

    if (isNonInventory) {
      skipped.push({
        sku: r.sku,
        reason: `ítem no-inventario en QuickBooks (${qbItemType ?? "service"}) — no tiene stock que ajustar`,
      });
      continue;
    }

    const prev = byVariant.get(r.variant_id);
    if (prev) {
      prev.damaged_qty += damaged;
    } else {
      byVariant.set(r.variant_id, {
        variant_id: r.variant_id,
        sku: r.sku,
        damaged_qty: damaged,
      });
    }
  }

  return { lines: [...byVariant.values()], skipped };
}

/**
 * Número de referencia del ajuste, derivado del credit memo — sin contador
 * nuevo y sin serie nueva, igual que los conteos (`IC1095`).
 *
 * Que sea derivable importa fuera de nuestra base: quien abra en QuickBooks el
 * reporte de la cuenta de daños ve `DMG1234` y sabe de qué credit memo salió,
 * sin tener que preguntarnos. QuickBooks corta RefNumber en 11 caracteres.
 */
export function buildDamageRefNumber(creditMemoNumber: string | null): string {
  const digits = (creditMemoNumber ?? "").match(/(\d+)\s*$/)?.[1];
  const base = digits ? `DMG${digits}` : `DMG${(creditMemoNumber ?? "").replace(/\W/g, "")}`;
  return base.slice(0, 11);
}

export function buildDamageMemo(creditMemoNumber: string | null): string {
  return `${creditMemoNumber ?? "Credit memo"} defective products`.slice(0, 4095);
}

export type DamageSyncReason =
  | "complete"
  | "edit"
  | "damaged_edit"
  | "void";

export interface DamageSyncOutcome {
  action: "none" | "add" | "mod" | "void";
  reason: string;
  rowId?: string;
  skipped?: DamageTarget["skipped"];
}

/**
 * Chokepoint. Lo llaman las cuatro rutas que pueden mover los defectuosos de un
 * credit memo, siempre DESPUÉS de haber persistido su cambio.
 *
 * No tira nunca: un problema sincronizando el ajuste de inventario no puede
 * tumbar la operación de dinero que ya ocurrió. Devuelve qué hizo y por qué,
 * para que el caller lo loguee.
 */
export async function syncCreditMemoDamageAdjustment(input: {
  creditMemoId: string;
  reason: DamageSyncReason;
  logger: any;
  /**
   * Tratar el credit memo como si ya estuviera voideado, aunque su columna
   * todavía no lo diga.
   *
   * Existe por el ORDEN, no por comodidad. El gate de quiescencia sólo retiene
   * una operación con filas creadas ANTES que ella —así dos voids del mismo
   * documento no se bloquean mutuamente para siempre— y eso obliga a que el
   * void del ajuste se encole ANTES que el del credit memo. Pero la ruta de
   * void recién marca `status='voided'` al final, así que sin este flag el
   * helper leería el credit memo todavía vivo, calcularía que sus defectuosos
   * siguen ahí, y encolaría un Mod en vez del void.
   *
   * La alternativa era relajar el gate para este par de steps. Se descartó: esa
   * cláusula es lo único que garantiza que no haya ciclos, y ya hubo un
   * bloqueo eterno y silencioso por exactamente ese motivo.
   */
  forceEmpty?: boolean;
}): Promise<DamageSyncOutcome> {
  const { creditMemoId, reason, logger, forceEmpty } = input;
  const LOG = "[cm-damage]";

  try {
    const accountListId = getDamageAccountListId();

    const pool = getDbPool();
    const { rows: cmRows } = await pool.query(
      `SELECT id, credit_memo_number, status,
              qb_inventory_adjustment_txn_id AS adj_txn_id
         FROM pos_credit_memo
        WHERE id = $1`,
      [creditMemoId]
    );
    const cm = cmRows[0];
    if (!cm) {
      return { action: "none", reason: `credit memo ${creditMemoId} no existe` };
    }

    // ── ¿Hay un void del ajuste en curso? ──────────────────────────────────
    //
    // El puntero `qb_inventory_adjustment_txn_id` se libera cuando el void
    // CONFIRMA, no cuando se encola. Entre esos dos momentos el credit memo
    // sigue diciendo "tengo un ajuste" mientras ese ajuste está en camino de
    // dejar de existir. Bajar los defectuosos a 0 y volver a subirlos en esa
    // ventana —guardar, mirar, corregir: segundos— caía justo ahí y encolaba un
    // MOD contra un documento que se estaba voideando, con el orden de despacho
    // sin garantizar.
    //
    // Se parte en dos según si el void ya SALIÓ:
    //   - todavía en cola  → se cancela y se sigue editando el mismo ajuste.
    //     Mejor que dejarlo ir: evita voidear un documento para crear otro
    //     idéntico un segundo después.
    //   - ya despachado    → el ajuste está muerto. Se trata como si no
    //     existiera y nace uno nuevo.
    const { rows: liveVoids } = await pool.query(
      `SELECT id, status
         FROM qb_order_pipeline
        WHERE reference_id = $1
          AND step = $2
          AND status IN ('waiting', 'pending', 'processing', 'submitted')
        ORDER BY created_at DESC`,
      [creditMemoId, CM_DAMAGE_VOID_STEP]
    );
    const dispatchedVoid = liveVoids.find(
      (v: any) => v.status === "processing" || v.status === "submitted"
    );
    const queuedVoids = liveVoids.filter(
      (v: any) => v.status === "waiting" || v.status === "pending"
    );

    let hasAdjustment = !!cm.adj_txn_id;
    if (hasAdjustment && dispatchedVoid) {
      hasAdjustment = false;
      logger.info(
        `${LOG} ${cm.credit_memo_number}: hay un void del ajuste ya despachado — el próximo defectuoso creará un ajuste nuevo`
      );
    }

    // Un credit memo voideado no tiene defectuosos vivos, sin importar lo que
    // digan sus líneas: el void ya revirtió el restock en Medusa.
    const target =
      forceEmpty || cm.status === "voided"
        ? { lines: [] as DamageTargetLine[], skipped: [] }
        : await resolveDamageTarget(creditMemoId);

    // ── Sin cuenta configurada: fail-closed ────────────────────────────────
    // Se avisa SOLO cuando había algo que hacer. Un log por cada credit memo
    // sin defectuosos sería ruido que enseña a ignorar el log.
    if (!accountListId) {
      if (target.lines.length > 0 || hasAdjustment) {
        logger.warn(
          `${LOG} ${cm.credit_memo_number}: ${target.lines.length} línea(s) defectuosa(s) sin sincronizar — ` +
            `${DAMAGE_ACCOUNT_ENV} no está configurada (mecanismo apagado)`
        );
      }
      return { action: "none", reason: `${DAMAGE_ACCOUNT_ENV} sin configurar` };
    }

    if (target.skipped.length > 0) {
      for (const s of target.skipped) {
        logger.warn(
          `${LOG} ${cm.credit_memo_number}: SKU ${s.sku ?? "(sin sku)"} con defectuosos NO ajustado — ${s.reason}`
        );
      }
    }

    // ── Nada que hacer ─────────────────────────────────────────────────────
    if (target.lines.length === 0 && !hasAdjustment) {
      return { action: "none", reason: "sin defectuosos y sin ajuste previo" };
    }

    const refNumber = buildDamageRefNumber(cm.credit_memo_number);
    const memo = buildDamageMemo(cm.credit_memo_number);
    const txnDate = getBusinessDateString();

    // ── Los defectuosos desaparecieron → el ajuste se retira ───────────────
    // QuickBooks rechaza un ajuste sin líneas, así que "ya no hay defectuosos"
    // NO es un Mod a cero: es un void. Vale igual para el void del credit memo.
    if (target.lines.length === 0 && hasAdjustment) {
      const rowId = await writePipelineRow({
        referenceId: creditMemoId,
        referenceType: "credit_memo",
        step: CM_DAMAGE_VOID_STEP,
        status: "pending",
        qbTxnId: cm.adj_txn_id,
        medusaRefNumber: cm.credit_memo_number,
        payload: {
          credit_memo_id: creditMemoId,
          credit_memo_number: cm.credit_memo_number,
          reason,
        },
      });
      logger.info(
        `${LOG} ${cm.credit_memo_number}: void del ajuste ${cm.adj_txn_id} encolado (${reason})`
      );
      return { action: "void", reason: "ya no hay unidades defectuosas", rowId };
    }

    const payload = {
      credit_memo_id: creditMemoId,
      credit_memo_number: cm.credit_memo_number,
      qb_account_list_id: accountListId,
      ref_number: refNumber,
      memo,
      txn_date: txnDate,
      lines: target.lines.map((l) => ({
        sku: l.sku,
        product_variant_id: l.variant_id,
        damaged_qty: l.damaged_qty,
      })),
      reason,
    };

    // ── Ya existe el ajuste → se EDITA ─────────────────────────────────────
    // Nunca un documento nuevo. Si al despachar resulta que QuickBooks ya tiene
    // exactamente estas cantidades, el consolidator saltea sin llamar al bridge:
    // acá no se puede saber, porque la verdad de las líneas vive en QB.
    if (hasAdjustment) {
      // Un void encolado y todavía sin despachar se cancela: los defectuosos
      // volvieron, así que el ajuste se queda y se edita. Cancelarlo acá es lo
      // que evita voidear un documento para crear otro idéntico un segundo
      // después, y es seguro precisamente porque no salió del pipeline.
      for (const v of queuedVoids) {
        await pool.query(
          `UPDATE qb_order_pipeline
              SET status = 'skipped',
                  error = 'los defectuosos volvieron antes de despachar el void — el ajuste se mantiene y se edita',
                  next_retry_at = NULL,
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('waiting', 'pending')`,
          [v.id]
        );
        logger.info(
          `${LOG} ${cm.credit_memo_number}: void del ajuste cancelado (fila ${v.id}) — vuelve a haber defectuosos`
        );
      }

      const rowId = await writePipelineRow({
        referenceId: creditMemoId,
        referenceType: "credit_memo",
        step: CM_DAMAGE_MOD_STEP,
        status: "pending",
        qbTxnId: cm.adj_txn_id,
        medusaRefNumber: cm.credit_memo_number,
        payload,
      });
      logger.info(
        `${LOG} ${cm.credit_memo_number}: mod del ajuste ${cm.adj_txn_id} encolado — ` +
          `${target.lines.length} SKU(s), ${target.lines.reduce((s, l) => s + l.damaged_qty, 0)} unidad(es) (${reason})`
      );
      return { action: "mod", reason: "cambiaron los defectuosos", rowId, skipped: target.skipped };
    }

    // ── Primer defectuoso → nace el ajuste ─────────────────────────────────
    const rowId = await writePipelineRow({
      referenceId: creditMemoId,
      referenceType: "credit_memo",
      step: CM_DAMAGE_ADD_STEP,
      status: "pending",
      medusaRefNumber: cm.credit_memo_number,
      payload,
    });
    logger.info(
      `${LOG} ${cm.credit_memo_number}: add del ajuste encolado (${refNumber}) — ` +
        `${target.lines.length} SKU(s), ${target.lines.reduce((s, l) => s + l.damaged_qty, 0)} unidad(es) (${reason})`
    );
    return { action: "add", reason: "primer defectuoso", rowId, skipped: target.skipped };
  } catch (err: any) {
    // Nunca propagar: la plata del credit memo ya se movió y no se revierte por
    // un problema de inventario. Queda visible en el log y, si la fila llegó a
    // escribirse, en el pipeline.
    logger.error(
      `${LOG} ${creditMemoId}: no se pudo encolar el ajuste de defectuosos (${reason}): ${err.message}`
    );
    return { action: "none", reason: `error: ${err.message}` };
  }
}
