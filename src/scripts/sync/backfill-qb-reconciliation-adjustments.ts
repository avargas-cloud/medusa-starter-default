/**
 * Ajustes de reconciliación POS ↔ QuickBooks para mayo–julio 2026.
 *
 * Correr (dry-run por default):
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/sync/backfill-qb-reconciliation-adjustments.ts
 * Aplicar:
 *   env APPLY=true DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true ...
 *
 * ── Qué compensa y por qué existe ────────────────────────────────────────────
 *
 * Seis documentos existen en los DOS sistemas con montos distintos. Ninguno se
 * puede corregir: el cliente ya tiene su factura en la mano y un documento
 * emitido no se reescribe. Así que la diferencia se NETEA con un documento
 * nuevo, que es la decisión del operador (2026-09-04).
 *
 *   19506 venta  may  QB 249,91 vs POS 437,81  → QB aplicó el descuento DOS veces
 *   18810 venta  jun  QB 6.260,53 vs POS 6.334,63 → ídem (mismo cliente)
 *   19519 CM     may  QB 46,94 vs POS 23,99     → una línea quedó en cantidad 0 en el POS
 *   19538 CM     may  QB 19,07 vs POS 25,75     → QB descuenta el credit memo, el POS no
 *   18921 CM     jun  QB 193,18 vs POS 321,98   → ídem
 *   18974 CM     jul  QB 1.111,51 vs POS 1.235,02 → ídem
 *
 * Cuatro de los seis son el MISMO fenómeno: descuentos que QuickBooks aplica al
 * credit memo y el POS no. Eso sigue vivo (no está arreglado, está dormido: en
 * toda la historia sólo 4 de 138 credit memos llevan descuento, y agosto quedó
 * limpio porque no hubo ni una devolución de mercadería vendida con rebaja).
 * Arreglar la CAUSA es otro trabajo; esto cuadra los meses ya pasados.
 *
 * ── A nombre de quién, y por qué no del cliente real ─────────────────────────
 *
 * Los ajustes cuelgan de un cliente propio de conciliación, NO del cliente que
 * hizo la compra. Dos motivos:
 *
 *   1. Un documento a nombre del cliente real aparecería en su cuenta de la web
 *      (`/store/orders` devuelve las órdenes del cliente autenticado), y estos
 *      son arreglos nuestros. El cliente de conciliación tiene
 *      `has_account = false`: sin cuenta no hay sesión, y sin sesión no hay nada
 *      que mostrar. La invisibilidad es estructural, no un filtro que alguien
 *      pueda sacar.
 *   2. Falsear el historial de un cliente real por un error que ocurrió del lado
 *      de QuickBooks es peor que dejar la diferencia visible en su ficha.
 *
 * CONSECUENCIA ACEPTADA: el total MENSUAL cuadra con QuickBooks, el reporte POR
 * CLIENTE no. ELECTRICAL UNLIMITED USA sigue mostrando sus $187,90 de más.
 *
 * ── Por qué hay dos formas de documento ──────────────────────────────────────
 *
 * Un credit memo sólo mueve el NETO — resta de las devoluciones y no puede
 * bajar el ingreso facturado. Los dos ajustes del lado VENTAS son facturas de
 * monto negativo; los cuatro del lado DEVOLUCIONES son quick credits (credit
 * memos sin factura ligada). Con las seis, los cuatro meses cierran en $0,00
 * bruto Y neto.
 *
 * ── Contrato: NADA de esto llega a QuickBooks ────────────────────────────────
 *
 * Es la prohibición central. QuickBooks ya tiene sus documentos; estos existen
 * sólo para que el reporte del POS diga lo mismo. El mecanismo es el mismo del
 * backfill hermano y quedó MEDIDO en sandbox (filas pendientes de pipeline
 * 41 → 41, cero nuevas): creación module-direct (sin ruta → sin evento → sin
 * subscriber), `qb_skip = true`, y la fila de pipeline sembrada en `confirmed`.
 *
 * Tampoco toca inventario (`manage_inventory: false` en la variante) ni emite
 * saldo a favor (`customer_credit_ledger` lo escriben sólo rutas de
 * `/admin/customers/*`).
 *
 * ── Sobre los montos negativos ───────────────────────────────────────────────
 *
 * Serían los primeros del sistema: medido el 2026-09-04, hay CERO negativos en
 * `pos_invoice.subtotal`, `pos_credit_memo.total/subtotal` y en las líneas de
 * ambos. Ninguna restricción `CHECK` los prohíbe, pero que sea legal no
 * significa que los lectores los hayan visto nunca — por eso el sandbox afirma
 * explícitamente que el statement, el aging y los reportes no se rompen.
 */

import { appendFileSync } from "fs";
import { join } from "path";

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";
import { CREDIT_MEMO_MODULE } from "../../modules/credit_memos";

const APPLY = process.env.APPLY === "true";
const AUDIT_FILE = join(__dirname, "backfill-qb-reconciliation-adjustments.audit.jsonl");

const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1";
const SALES_CHANNEL_ID = "sc_15154EAF0D194265ADD21AAD2D";

/** El cliente de conciliación. `has_account=false` = no puede ver la web. */
const RECON_CUSTOMER_EMAIL = "qb.reconciliation@noemail.ecopowertech.com";
const RECON_CUSTOMER_NAME = "QB Reconciliation";

/**
 * El item. NO lleva `quickbooks_id` a propósito: no existe en QuickBooks y no
 * debe existir. Va `draft` para que jamás aparezca en la tienda pública, y
 * `manage_inventory: false` para que no pueda mover stock.
 */
const ADJ_SKU = "ADJ-RECON";
const ADJ_TITLE = "Reconciliation Adjustment";

type Adjustment = {
  /** `sale` mueve bruto y neto; `refund` sólo el neto. */
  side: "sale" | "refund";
  /** Documento de QB que compensa. */
  compensates: string;
  month: string;
  /** Fecha de negocio del ajuste — el último día del mes que corrige. */
  date: string;
  /**
   * Centavos CON SIGNO, en la convención del documento que se crea:
   *   sale   → negativo baja el ingreso facturado
   *   refund → positivo acredita más, negativo acredita menos
   */
  cents: number;
  reason: string;
};

/**
 * Los seis, medidos documento por documento contra QuickBooks el 2026-09-04.
 * Cada monto es la diferencia observada, no una estimación.
 */
const ADJUSTMENTS: Adjustment[] = [
  {
    side: "sale", compensates: "19506", month: "2026-05", date: "2026-05-31", cents: -18790,
    reason:
      "Compensa la factura 19506 (2026-05-11, ELECTRICAL UNLIMITED USA): QuickBooks recibió las líneas ya rebajadas Y además una línea de Discount de $187,88, o sea que aplicó el descuento dos veces. QB dice $249,91 y el POS $437,81. La factura emitida no se modifica.",
  },
  {
    side: "refund", compensates: "19519", month: "2026-05", date: "2026-05-31", cents: 2295,
    reason:
      "Compensa el credit memo 19519 (2026-05-13, COENG GROUP LLC): la línea EAP-AS1-8S quedó en cantidad 0 en el POS y en 1 en QuickBooks. QB acredita $46,94 y el POS $23,99.",
  },
  {
    side: "refund", compensates: "19538", month: "2026-05", date: "2026-05-31", cents: -668,
    reason:
      "Compensa el credit memo 19538 (2026-05-18, MARCELO CUADRATO'S DESIGN): QuickBooks le aplica un Discount de $6,68 que el POS no tiene. QB acredita $19,07 y el POS $25,75.",
  },
  {
    side: "sale", compensates: "18810", month: "2026-06", date: "2026-06-30", cents: -7410,
    reason:
      "Compensa la factura 18810 (2026-06-01, ELECTRICAL UNLIMITED USA): mismo doble descuento que 19506 — líneas ya rebajadas más una línea de Discount de $74,27. QB dice $6.260,53 y el POS $6.334,63.",
  },
  {
    side: "refund", compensates: "18921", month: "2026-06", date: "2026-06-30", cents: -12880,
    reason:
      "Compensa el credit memo 18921 (2026-06-26, American Eagle Electric): QuickBooks le aplica un Discount de $128,80 que el POS no tiene. QB acredita $193,18 y el POS $321,98.",
  },
  {
    side: "refund", compensates: "18974", month: "2026-07", date: "2026-07-08", cents: -12351,
    reason:
      "Compensa el credit memo 18974 (2026-07-08, ALL STONES FL): QuickBooks le aplica un Discount de $123,51 que el POS no tiene. QB acredita $1.111,51 y el POS $1.235,02.",
  },
];

const audit = (row: Record<string, unknown>): void => {
  if (!APPLY) return;
  appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
};

/** Mediodía ET del día — la fecha de negocio, no UTC. */
const businessInstant = (d: string): string => `${d}T16:00:00.000Z`;
const money = (c: number): string => `${c < 0 ? "-" : ""}$${Math.abs(c / 100).toFixed(2)}`;

export default async function backfillReconciliationAdjustments({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const orderModule = container.resolve(Modules.ORDER) as any;
  const customerModule = container.resolve(Modules.CUSTOMER) as any;
  const productModule = container.resolve(Modules.PRODUCT) as any;
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const cmService = container.resolve(CREDIT_MEMO_MODULE) as any;

  logger.info(
    `\n${"═".repeat(72)}\najustes de reconciliación — ${APPLY ? "APLICANDO" : "DRY-RUN (nada se escribe)"}\n${"═".repeat(72)}`
  );

  // ── 1. El cliente de conciliación ─────────────────────────────────────────
  let reconCustomerId: string;
  const existingCustomer = (
    await pg.raw(`SELECT id FROM customer WHERE email = ? AND deleted_at IS NULL`, [
      RECON_CUSTOMER_EMAIL,
    ])
  ).rows;
  if (existingCustomer.length) {
    reconCustomerId = existingCustomer[0].id;
    logger.info(`✓ cliente de conciliación ya existe (${reconCustomerId})`);
  } else if (!APPLY) {
    reconCustomerId = "(se crearía)";
    logger.info(`→ crearía el cliente "${RECON_CUSTOMER_NAME}" (${RECON_CUSTOMER_EMAIL})`);
  } else {
    const created = await customerModule.createCustomers({
      email: RECON_CUSTOMER_EMAIL,
      company_name: RECON_CUSTOMER_NAME,
      // has_account queda en false: sin cuenta no puede iniciar sesión en la
      // web, así que estos documentos no tienen por dónde llegarle a nadie.
      metadata: {
        internal_reconciliation: true,
        created_by_script: "backfill-qb-reconciliation-adjustments",
        note: "Cliente interno. NO es un comprador — agrupa los ajustes que cuadran el POS contra QuickBooks.",
      },
    });
    reconCustomerId = (Array.isArray(created) ? created[0] : created).id;
    audit({ step: "recon_customer_created", customer_id: reconCustomerId });
    logger.info(`✅ cliente de conciliación creado (${reconCustomerId})`);
  }

  // ── 2. El item ────────────────────────────────────────────────────────────
  let adjVariantId: string;
  const existingVariant = (
    await pg.raw(`SELECT id FROM product_variant WHERE sku = ? AND deleted_at IS NULL`, [ADJ_SKU])
  ).rows;
  if (existingVariant.length) {
    adjVariantId = existingVariant[0].id;
    logger.info(`✓ item ${ADJ_SKU} ya existe (${adjVariantId})`);
  } else if (!APPLY) {
    adjVariantId = "(se crearía)";
    logger.info(`→ crearía el item "${ADJ_TITLE}" (${ADJ_SKU})`);
  } else {
    const [product] = await productModule.createProducts([
      {
        title: ADJ_TITLE,
        handle: "reconciliation-adjustment",
        // `draft` para que NUNCA aparezca en la tienda pública.
        status: "draft" as const,
        metadata: {
          sales_description:
            "Ajuste interno de reconciliación POS ↔ QuickBooks. No es un producto: no se vende, no se cotiza y no existe en QuickBooks.",
          internal_only: true,
          never_sync_to_qb: true,
        },
        variants: [
          {
            title: "Default",
            sku: ADJ_SKU,
            // Sin esto un ajuste movería stock de un producto que no existe.
            manage_inventory: false,
            allow_backorder: true,
            prices: [],
            metadata: {
              internal_only: true,
              // SIN `quickbooks_id`: este item no existe en QuickBooks y no debe.
              never_sync_to_qb: true,
            },
          },
        ],
      } as any,
    ]);
    const variants = (
      await pg.raw(`SELECT id FROM product_variant WHERE sku = ? AND deleted_at IS NULL`, [ADJ_SKU])
    ).rows;
    adjVariantId = variants[0].id;
    audit({ step: "adj_item_created", product_id: (product as any).id, variant_id: adjVariantId });
    logger.info(`✅ item ${ADJ_SKU} creado (${adjVariantId})`);
  }

  // ── 3. Los seis ajustes ───────────────────────────────────────────────────
  let creados = 0;
  let salteados = 0;

  for (const adj of ADJUSTMENTS) {
    const tag = `[ajuste vs ${adj.compensates} · ${adj.month}]`;
    const issuedAt = businessInstant(adj.date);

    // Idempotencia por el documento que compensa: un ajuste por diferencia.
    const already = (
      await pg.raw(
        adj.side === "sale"
          ? `SELECT invoice_number AS num FROM pos_invoice
              WHERE metadata->>'compensates_qb_ref' = ? AND deleted_at IS NULL`
          : `SELECT credit_memo_number AS num FROM pos_credit_memo
              WHERE metadata->>'compensates_qb_ref' = ? AND deleted_at IS NULL`,
        [adj.compensates]
      )
    ).rows;
    if (already.length) {
      salteados++;
      logger.info(`${tag} ya existe (${already[0].num}) — se saltea`);
      continue;
    }

    logger.info(
      `${tag} ${adj.side === "sale" ? "FACTURA (bruto+neto)" : "QUICK CREDIT (neto)"} ${money(adj.cents)}`
    );
    if (!APPLY) {
      creados++;
      continue;
    }

    const metadata = {
      is_internal_adjustment: true,
      compensates_qb_ref: adj.compensates,
      compensates_month: adj.month,
      adjustment_reason: adj.reason,
      never_sync_to_qb: true,
    };

    if (adj.side === "sale") {
      const seq = await pg.raw(`SELECT nextval('custom_order_seq') AS seq`);
      const documentNumber = `S${seq.rows[0].seq ?? seq.rows[0].SEQ}`;
      const created = await orderModule.createOrders({
        region_id: REGION_ID,
        sales_channel_id: SALES_CHANNEL_ID,
        customer_id: reconCustomerId,
        currency_code: "usd",
        status: "pending",
        is_draft_order: false,
        items: [
          {
            variant_id: adjVariantId,
            variant_sku: ADJ_SKU,
            title: ADJ_TITLE,
            product_title: ADJ_TITLE,
            quantity: 1,
            unit_price: adj.cents / 100,
          },
        ],
        metadata: {
          ...metadata,
          document_number: documentNumber,
          pos_created: true,
          pos_created_by: "QB Reconciliation",
          order_placed_at: issuedAt,
          order_status: "Fulfilled",
          fully_invoiced: true,
          pos_total: adj.cents / 100,
          computed_total: adj.cents / 100,
          computed_subtotal: adj.cents / 100,
          computed_tax_amount: 0,
          qb_skip: true,
          qb_sync_status: "synced",
          manually_imported: true,
        },
      });
      const orderId = created.id;
      await pg.raw(`UPDATE "order" SET created_at = ?::timestamptz WHERE id = ?`, [issuedAt, orderId]);

      const numRes = await pg.raw(
        `UPDATE document_number_counter SET value = value + 1, updated_at = now()
          WHERE name = 'medusa_invoice' RETURNING value`
      );
      const invoiceNumber = String(numRes.rows[0].value);
      const invoice = await invoiceService.createPosInvoices({
        invoice_number: invoiceNumber,
        order_id: orderId,
        fulfillment_id: null,
        customer_id: reconCustomerId,
        status: "paid",
        subtotal: adj.cents,
        discount: 0,
        shipping: 0,
        tax: 0,
        untaxed_total: adj.cents,
        total: adj.cents,
        // Saldada por construcción: un ajuste no es plata que alguien deba.
        amount_paid: adj.cents,
        balance_due: 0,
        issued_at: issuedAt,
        paid_at: issuedAt,
        notes: adj.reason,
        metadata,
      });
      const invoiceId = (invoice as any).id;
      await invoiceService.createPosInvoiceItems([
        {
          invoice_id: invoiceId,
          variant_id: adjVariantId,
          sku: ADJ_SKU,
          description: adj.reason,
          quantity: 1,
          unit_price: adj.cents,
          total: adj.cents,
          net_total_cents: adj.cents,
        },
      ]);
      // Pipeline sembrado en `skipped`: este documento NO tiene contraparte en
      // QuickBooks y nunca debe intentar tenerla.
      await pg.raw(
        `INSERT INTO qb_order_pipeline
           (order_id, reference_id, reference_type, step, status, error, confirmed_at)
         VALUES (?, ?, 'invoice', 'invoice', 'skipped', ?, NOW())`,
        [orderId, invoiceId, "Ajuste interno de reconciliación — no se sincroniza a QuickBooks"]
      );
      audit({ step: "adjustment_invoice", compensates: adj.compensates, invoice_id: invoiceId, invoice_number: invoiceNumber, cents: adj.cents });
      logger.info(`${tag} ✅ factura ${invoiceNumber} (orden ${documentNumber})`);
    } else {
      const cmSeq = await pg.raw(`SELECT nextval('custom_credit_memo_seq') AS seq`);
      const cmNumber = `CM-${cmSeq.rows[0].seq ?? cmSeq.rows[0].SEQ}`;
      const cm = await cmService.createPosCreditMemos({
        credit_memo_number: cmNumber,
        // Quick Credit: sin factura y sin orden. Sin orden, la web no lo puede
        // mostrar ni siquiera si algún día muestra invoices por order.
        order_id: null,
        invoice_id: null,
        customer_id: reconCustomerId,
        status: "completed",
        subtotal: adj.cents,
        discount: 0,
        shipping: 0,
        tax: 0,
        total: adj.cents,
        completed_at: issuedAt,
        notes: adj.reason,
        created_by: "QB Reconciliation",
        // Sin `refund_method`: no se le devolvió plata a nadie ni se emitió
        // crédito. Es un asiento de reconciliación.
        refund_method: null,
        metadata,
      });
      const cmId = (Array.isArray(cm) ? cm[0] : cm).id;
      await cmService.createPosCreditMemoItems([
        {
          credit_memo_id: cmId,
          variant_id: adjVariantId,
          sku: ADJ_SKU,
          title: ADJ_TITLE,
          description: adj.reason,
          quantity: 1,
          unit_price: adj.cents,
          line_total: adj.cents,
          damaged_qty: 0,
        },
      ]);
      audit({ step: "adjustment_credit_memo", compensates: adj.compensates, credit_memo_id: cmId, number: cmNumber, cents: adj.cents });
      logger.info(`${tag} ✅ ${cmNumber}`);
    }
    creados++;
  }

  logger.info(
    `\n${"─".repeat(72)}\n${APPLY ? "APLICADO" : "DRY-RUN"} · ${creados} ajuste(s) ${APPLY ? "creados" : "a crear"} · ${salteados} ya existían\n` +
      (APPLY ? `audit: ${AUDIT_FILE}\n` : "Para aplicar: APPLY=true\n") +
      `${"─".repeat(72)}`
  );
}
