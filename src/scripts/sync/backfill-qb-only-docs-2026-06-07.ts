/**
 * Recrea en el POS los 6 documentos que existen SÓLO en QuickBooks (junio y
 * julio 2026), con sus pagos, para que los reportes de ventas dejen de estar
 * por debajo del ledger.
 *
 * Correr (dry-run por default):
 *   env DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/sync/backfill-qb-only-docs-2026-06-07.ts
 * Aplicar:
 *   env APPLY=true DATABASE_URL=... DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/sync/backfill-qb-only-docs-2026-06-07.ts
 *
 * `DISABLE_SCHEDULED_JOBS=true` NO es opcional: sin él `medusa exec` levanta
 * TODOS los crons, incluido un segundo despachador del pipeline de QuickBooks
 * corriendo en paralelo con el de Railway.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * El diff documento por documento POS↔QB de mayo–agosto 2026 cerró al centavo
 * en los cuatro meses. Junio y julio no cuadraban por documentos que alguien
 * cargó DIRECTO en QuickBooks y el POS nunca vio — ventas reales, con ítems
 * reales, ya cobradas. Agosto da $0,00 exacto y es el control de que la
 * medición sirve. Detalle: `docs/REPORTS_SHIPPING_PARITY_PLAN.md`.
 *
 * ── Contrato anti-duplicados (modelo: backfill-qb-invoices-goodlook.ts) ──────
 *
 * QuickBooks YA TIENE estos documentos y sus pagos. Reenviarlos duplicaría la
 * contabilidad, así que NADA de lo que este script crea puede llegar al bridge:
 *
 *   - La orden se crea MODULE-DIRECT (`orderModule.createOrders`), no por la
 *     ruta ni por el flujo de draft→convert: sin ruta no hay evento, sin evento
 *     no corren los subscribers, y no se crean reservas de inventario.
 *   - `pos_invoice` / `pos_credit_memo` por module service, por lo mismo.
 *   - El PAGO también: `handlePosPaymentApplied` se invoca ÚNICAMENTE desde
 *     rutas (`/admin/customer-payments/[id]/apply` y `/admin/invoices`) — no hay
 *     subscriber escuchando al módulo, así que un pago creado por servicio nunca
 *     lo alcanza. Verificado leyendo los callsites, no supuesto.
 *   - `qb_order_pipeline` se SIEMBRA en `confirmed` con el TxnID real: el guard
 *     `QB_CREATE_STEPS` de `row-mutations.ts` vuelve no-op cualquier encolado
 *     posterior.
 *   - `order.metadata.qb_skip = true` para que ningún cron reintente.
 *
 * ── Lo que este script NO hace, a propósito ──────────────────────────────────
 *
 *   - NO toca inventario. La mercadería salió hace meses; mover `stocked_quantity`
 *     hoy corrompería el stock vivo.
 *   - NO escribe en QuickBooks. Ni un Add, ni un Mod.
 *   - NO crea saldo a favor. `customer_credit_ledger` lo escriben sólo las rutas
 *     de `/admin/customers/*`; nada acá lo toca.
 *   - NO netea las diferencias de MONTO (18810, 18921, 18974, 19506, 19519,
 *     19538). Ésas van por el script de ajustes de reconciliación.
 *
 * ── Trampa que ya mordió ─────────────────────────────────────────────────────
 *
 * En QuickBooks el RefNumber NO es único: pedir 18892, 18967 o 18876 devuelve
 * documentos de MESES DISTINTOS con el mismo número. Todo acá keyea por TxnID.
 *
 * Idempotente y reanudable: cada paso guarda por `qb_txn_id` antes de escribir.
 * Audit trail: `backfill-qb-only-docs-2026-06-07.audit.jsonl`, al lado de este
 * archivo, que es la entrada del script de rollback.
 */

import { appendFileSync } from "fs";
import { join } from "path";

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { INVOICE_MODULE } from "../../modules/invoices";
import { FINANCE_MODULE } from "../../modules/finance";
import { CREDIT_MEMO_MODULE } from "../../modules/credit_memos";

const APPLY = process.env.APPLY === "true";
const AUDIT_FILE = join(__dirname, "backfill-qb-only-docs-2026-06-07.audit.jsonl");

// Mismos que usan las órdenes del POS en producción (medido: 1334 órdenes).
const REGION_ID = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1";
const SALES_CHANNEL_ID = "sc_15154EAF0D194265ADD21AAD2D";

/** Nombre del cliente en QB → id del cliente en el POS. Resuelto y verificado. */
const CUSTOMER_BY_QB_NAME: Record<string, string> = {
  "ARMANDO FIGUEROA": "cus_01KNMBS0AKVXGXMY9R8N6H3WRH",
  "Design Flooring and Carpentry Inc": "cus_01KG0QB28CP97G0PB8Q2XEGJ3N",
  "JOEL MARTINEZ": "cus_01KJ3WJMSRVRFZYSH7P835QDCE",
};

type QbLine = {
  sku: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
};

type QbLinked = {
  type: string;
  ref: string | null;
  date: string;
  amount_cents: number;
  txn_id: string;
};

type QbDoc = {
  doc_type: "Invoice" | "CreditMemo";
  qb_ref_number: string;
  qb_txn_id: string;
  qb_edit_sequence: string;
  txn_date: string;
  customer_qb: string;
  subtotal_cents: number;
  tax_cents: number;
  memo: string | null;
  lines: QbLine[];
  linked: QbLinked[];
};

/**
 * Capturado del bridge el 2026-09-04 con `InvoiceQuery`/`CreditMemoQuery`
 * (`IncludeLineItems` + `IncludeLinkedTxns`) y GENERADO, no transcrito: cada
 * documento se verificó cuadrando Σ líneas === subtotal antes de congelarse.
 */
const DOCS: QbDoc[] = [
  {
    doc_type: "Invoice",
    qb_ref_number: "18867",
    qb_txn_id: "1C7515-1781363692",
    qb_edit_sequence: "1781363692",
    txn_date: "2026-06-13",
    customer_qb: "ARMANDO FIGUEROA",
    subtotal_cents: 39225,
    tax_cents: 2746,
    memo: null,
    lines: [
      { sku: "ESP-SFA50W0840", description: "LED Freecut SOB Strip, 24VDC, 320LED/Meter, 50W/Roll, 10W/Meter, 3.66W/Ft, 329 LM/ft, 4000K, 8mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative). 5 year warranty.", quantity: 3, unit_price_cents: 5675, total_cents: 17025 },
      { sku: "SUP-MDA-96-24", description: "Slim Design Dimmable Power supply, 96W, 100-120VAC, 4A. Output 24VDC. UL Listed, Class 2. 3-year Warranty.", quantity: 2, unit_price_cents: 5250, total_cents: 10500 },
      { sku: "ECNA-POC2-6F-B", description: "6ft 18 AWG Universal 2-Prong Power Cord (IEC320 C13 to NEMA 1-15P) Black.", quantity: 2, unit_price_cents: 750, total_cents: 1500 },
      { sku: "EAP-AR1-8S", description: "Standard Recessed Mount Aluminum Channel for a maximum of a 10mm LED Strip, Silver Finish, 8 feet, PC Opal Diffuser, Frosted Cover. Comes with 4 mounting clips, 2 pair of end caps (blank and hole)", quantity: 4, unit_price_cents: 2550, total_cents: 10200 },
    ],
    linked: [
      { type: "CreditMemo", ref: "18866", date: "2026-06-13", amount_cents: -19812, txn_id: "1C750F-1781363142" },
      { type: "ReceivePayment", ref: null, date: "2026-06-13", amount_cents: -22159, txn_id: "1C752C-1781363795" },
    ],
  },
  {
    doc_type: "Invoice",
    qb_ref_number: "18892",
    qb_txn_id: "1C7F4D-1781961882",
    qb_edit_sequence: "1781961882",
    txn_date: "2026-06-20",
    customer_qb: "Design Flooring and Carpentry Inc",
    subtotal_cents: 1196,
    tax_cents: 84,
    memo: "Estimate E18024728:",
    lines: [
      { sku: "EAS1-PIG08", description: "6' Connector for 8mm Single Color LED COB Strips. One side clip for 8mm LED Strips, other side 3A 24V Dupont Male Connecotr. Black/Black dotted Cables.", quantity: 3, unit_price_cents: 399, total_cents: 1196 },
    ],
    linked: [
      { type: "SalesOrder", ref: "6281", date: "2026-04-10", amount_cents: -1280, txn_id: "1C03C7-1775836433" },
      { type: "ReceivePayment", ref: null, date: "2026-04-10", amount_cents: -1280, txn_id: "1C03D9-1775836571" },
    ],
  },
  {
    doc_type: "Invoice",
    qb_ref_number: "18967",
    qb_txn_id: "1C9523-1783442503",
    qb_edit_sequence: "1783442503",
    txn_date: "2026-07-07",
    customer_qb: "Design Flooring and Carpentry Inc",
    subtotal_cents: 33750,
    tax_cents: 2363,
    memo: null,
    lines: [
      { sku: "LEG-ADTP703TUW4", description: "sofTap Dimmer, Tru-Universal: ELV/Halogen/Incandescent/ (700W) , MLV(500VA), LED/CFL(450W), Single Pole / 3-Way, White.", quantity: 6, unit_price_cents: 5625, total_cents: 33750 },
    ],
    linked: [
      { type: "CreditMemo", ref: "18966", date: "2026-07-07", amount_cents: -36113, txn_id: "1C94E0-1783438165" },
    ],
  },
  {
    doc_type: "CreditMemo",
    qb_ref_number: "18866",
    qb_txn_id: "1C750F-1781363142",
    qb_edit_sequence: "1781363697",
    txn_date: "2026-06-13",
    customer_qb: "ARMANDO FIGUEROA",
    subtotal_cents: 18516,
    tax_cents: 1296,
    memo: null,
    lines: [
      { sku: "SUP-AP-SM2-8S", description: "Profile for a maximum of a 16.6 mm LED Strip, Silver Finish, 8 feet, PC Opal Diffuser, Frosted Cover. Comes with 4 mounting clips, 2 pair of end caps (blank and hole)", quantity: 4, unit_price_cents: 2999, total_cents: 11996 },
      { sku: "ESPC1R4W40W0840", description: "LED Strip COB, 24VDC, 320LED/Meter, 40W/Roll, 8W/Meter, 235 LM/ft, White Board, 4000K, IP65, UL Listed, 5 meters/16.4 feet. Includes Female Connector on both ends, Males plugs(2 pairs) with cable, 10 mounting clips, 5 end caps, 1 silicone glue and 20 screws. 3 year warranty.", quantity: 1, unit_price_cents: 6520, total_cents: 6520 },
    ],
    linked: [
      { type: "Invoice", ref: "18867", date: "2026-06-13", amount_cents: -19812, txn_id: "1C7515-1781363692" },
    ],
  },
  {
    doc_type: "CreditMemo",
    qb_ref_number: "18876",
    qb_txn_id: "1C7741-1781547132",
    qb_edit_sequence: "1781547204",
    txn_date: "2026-06-15",
    customer_qb: "JOEL MARTINEZ",
    subtotal_cents: 7050,
    tax_cents: 494,
    memo: null,
    lines: [
      { sku: "EAP-AR1-8S", description: "Standard Recessed Mount Aluminum Channel for a maximum of a 10mm LED Strip, Silver Finish, 8 feet, PC Opal Diffuser, Frosted Cover. Comes with 4 mounting clips, 2 pair of end caps (blank and hole)", quantity: 3, unit_price_cents: 2350, total_cents: 7050 },
    ],
    linked: [
    ],
  },
  {
    doc_type: "CreditMemo",
    qb_ref_number: "18966",
    qb_txn_id: "1C94E0-1783438165",
    qb_edit_sequence: "1786076507",
    txn_date: "2026-07-07",
    customer_qb: "Design Flooring and Carpentry Inc",
    subtotal_cents: 33750,
    tax_cents: 2363,
    memo: null,
    lines: [
      { sku: "LEG-ADPD453LW2", description: "Paddle Dimmer, CFL/LED (450W), Single-Pole/3-Way, White.", quantity: 6, unit_price_cents: 5625, total_cents: 33750 },
    ],
    linked: [
      { type: "Invoice", ref: "18967", date: "2026-07-07", amount_cents: -36113, txn_id: "1C9523-1783442503" },
    ],
  },
];

const audit = (row: Record<string, unknown>): void => {
  if (!APPLY) return;
  appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
};

/** Mediodía ET del día del documento — la fecha de negocio, no UTC. */
const businessInstant = (txnDate: string): string => `${txnDate}T16:00:00.000Z`;

const money = (c: number): string => `$${(c / 100).toFixed(2)}`;

export default async function backfillQbOnlyDocs({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const orderModule = container.resolve(Modules.ORDER) as any;
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const cmService = container.resolve(CREDIT_MEMO_MODULE) as any;
  const financeService = container.resolve(FINANCE_MODULE) as any;

  logger.info(
    `\n${"═".repeat(72)}\nbackfill-qb-only-docs — ${APPLY ? "APLICANDO" : "DRY-RUN (nada se escribe)"}\n${"═".repeat(72)}`
  );

  // ── Resolver variantes por SKU, ANTES de escribir nada ────────────────────
  // Un SKU que no resuelve aborta la corrida entera: una línea sin variante en
  // una factura del POS deja el ítem sin costo y sin historial, y el error
  // aparecería recién en un reporte.
  const skus = [...new Set(DOCS.flatMap((d) => d.lines.map((l) => l.sku)))];
  const variantRows = (
    await pg.raw(
      `SELECT pv.id, pv.sku, pv.title, p.title AS product_title
         FROM product_variant pv
         LEFT JOIN product p ON p.id = pv.product_id
        WHERE pv.sku = ANY(?) AND pv.deleted_at IS NULL`,
      [skus]
    )
  ).rows as Array<{ id: string; sku: string; title: string; product_title: string }>;
  const bySku = new Map(variantRows.map((r) => [r.sku, r]));
  const missing = skus.filter((s) => !bySku.has(s));
  if (missing.length) {
    throw new Error(`SKUs sin variante en el POS: ${missing.join(", ")} — se aborta sin escribir nada`);
  }
  logger.info(`✓ ${skus.length} SKUs resueltos a variantes`);

  /** qb_txn_id de la factura → id del pos_invoice recreado (para linkear los CM). */
  const invoiceByQbTxn = new Map<string, { invoiceId: string; orderId: string; number: string }>();
  let creados = 0;
  let salteados = 0;

  for (const doc of DOCS) {
    const tag = `[${doc.doc_type} ${doc.qb_ref_number}]`;
    const customerId = CUSTOMER_BY_QB_NAME[doc.customer_qb];
    if (!customerId) throw new Error(`${tag} cliente QB sin mapear: ${doc.customer_qb}`);
    const totalCents = doc.subtotal_cents + doc.tax_cents;
    const issuedAt = businessInstant(doc.txn_date);

    // ── Idempotencia: SIEMPRE por TxnID, jamás por RefNumber ────────────────
    // En QuickBooks el RefNumber se repite entre meses (medido: 18892, 18967 y
    // 18876 devuelven documentos distintos). Keyear por número recrearía el
    // documento equivocado o saltearía el correcto.
    const already = (
      await pg.raw(
        doc.doc_type === "Invoice"
          ? `SELECT i.id, i.invoice_number AS num, i.order_id FROM pos_invoice i
               JOIN "order" o ON o.id = i.order_id
              WHERE o.metadata->>'qb_invoice_txn_id' = ? AND i.deleted_at IS NULL`
          : `SELECT id, credit_memo_number AS num, order_id FROM pos_credit_memo
              WHERE qb_txn_id = ? AND deleted_at IS NULL`,
        [doc.qb_txn_id]
      )
    ).rows;
    if (already.length) {
      salteados++;
      if (doc.doc_type === "Invoice") {
        invoiceByQbTxn.set(doc.qb_txn_id, { invoiceId: already[0].id, orderId: already[0].order_id, number: already[0].num });
      }
      logger.info(`${tag} ya existe (${already[0].num}) — se saltea`);
      continue;
    }

    logger.info(
      `${tag} ${doc.txn_date} ${doc.customer_qb} · subtotal ${money(doc.subtotal_cents)} + tax ${money(doc.tax_cents)} = ${money(totalCents)} · ${doc.lines.length} línea(s)`
    );
    for (const l of doc.lines) {
      logger.info(`      · ${l.sku} ×${l.quantity} @ ${money(l.unit_price_cents)} = ${money(l.total_cents)}`);
    }

    if (!APPLY) {
      creados++;
      const pay = doc.linked.find((l) => l.type === "ReceivePayment");
      if (pay) logger.info(`      → crearía pago de ${money(Math.abs(pay.amount_cents))} (${pay.date})`);
      continue;
    }

    if (doc.doc_type === "Invoice") {
      // ── 1. Orden MODULE-DIRECT: sin ruta, sin evento, sin reservas ────────
      //
      // La orden se resuelve APARTE de la factura, y no es un detalle: si una
      // corrida anterior murió ENTRE crear la orden y crear la factura, el
      // guard de arriba (que exige `pos_invoice`) no la ve y se crearía una
      // orden duplicada en cada reintento. Pasó en el sandbox al primer intento.
      let orderId: string;
      let documentNumber: string;
      const orphan = (
        await pg.raw(
          `SELECT id, metadata->>'document_number' AS docnum FROM "order"
            WHERE metadata->>'qb_invoice_txn_id' = ? AND deleted_at IS NULL`,
          [doc.qb_txn_id]
        )
      ).rows;
      if (orphan.length) {
        orderId = orphan[0].id;
        documentNumber = orphan[0].docnum;
        logger.info(`${tag} reusando la orden ${documentNumber} de una corrida anterior`);
      } else {
      const seq = await pg.raw(`SELECT nextval('custom_order_seq') AS seq`);
      documentNumber = `S${seq.rows[0].seq ?? seq.rows[0].SEQ}`;
      const nowIso = new Date().toISOString();
      const created = await orderModule.createOrders({
        region_id: REGION_ID,
        sales_channel_id: SALES_CHANNEL_ID,
        customer_id: customerId,
        currency_code: "usd",
        status: "pending",
        is_draft_order: false,
        items: doc.lines.map((l) => {
          const v = bySku.get(l.sku)!;
          return {
            variant_id: v.id,
            variant_sku: l.sku,
            title: v.title || l.sku,
            product_title: v.product_title,
            quantity: l.quantity,
            unit_price: l.unit_price_cents / 100,
          };
        }),
        metadata: {
          document_number: documentNumber,
          pos_created: true,
          pos_created_by: "QB Backfill 2026-09",
          order_placed_at: issuedAt,
          confirmed_at: issuedAt,
          order_status: "Fulfilled",
          fully_invoiced: true,
          pos_total: totalCents / 100,
          computed_total: totalCents / 100,
          computed_subtotal: doc.subtotal_cents / 100,
          computed_tax_amount: doc.tax_cents / 100,
          // El trío que mantiene esto fuera de QuickBooks.
          qb_skip: true,
          qb_sync_status: "synced",
          qb_synced_at: nowIso,
          qb_invoice_txn_id: doc.qb_txn_id,
          qb_invoice_ref_number: doc.qb_ref_number,
          qb_ref_number: doc.qb_ref_number,
          manually_imported: true,
          manually_imported_source: `QB Desktop ${doc.doc_type} ${doc.qb_ref_number} (backfill 2026-09-04)`,
          ...(doc.memo ? { pos_notes: doc.memo } : {}),
        },
      });
      orderId = created.id;
      // Backdatear para que los listados la ordenen por su fecha de negocio.
      await pg.raw(`UPDATE "order" SET created_at = ?::timestamptz WHERE id = ?`, [issuedAt, orderId]);
      audit({ step: "order_created", qb_txn_id: doc.qb_txn_id, order_id: orderId, document_number: documentNumber });
      }

      // ── 2. Número de factura: counter ROW, no sequence ───────────────────
      // La numeración gapless del repo usa `document_number_counter` a propósito:
      // una sequence de Postgres quema el número si la transacción revierte.
      const numRes = await pg.raw(
        `UPDATE document_number_counter SET value = value + 1, updated_at = now()
          WHERE name = 'medusa_invoice' RETURNING value`
      );
      const invoiceNumber = String(numRes.rows[0].value);

      const invoice = await invoiceService.createPosInvoices({
        invoice_number: invoiceNumber,
        order_id: orderId,
        fulfillment_id: null,
        customer_id: customerId,
        status: "paid",
        subtotal: doc.subtotal_cents,
        discount: 0,
        shipping: 0,
        tax: doc.tax_cents,
        untaxed_total: doc.subtotal_cents,
        total: totalCents,
        amount_paid: totalCents,
        // Requerido y SIN default en el modelo. Nace en cero porque en
        // QuickBooks estas facturas ya figuran pagadas (IsPaid=true, saldo 0).
        balance_due: 0,
        issued_at: issuedAt,
        paid_at: issuedAt,
        notes: `Recreado desde QuickBooks ${doc.doc_type} ${doc.qb_ref_number} (TxnID ${doc.qb_txn_id}).`,
        metadata: { qb_txn_id: doc.qb_txn_id, qb_ref_number: doc.qb_ref_number, manually_imported: true },
      });
      const invoiceId = (invoice as any).id;
      await invoiceService.createPosInvoiceItems(
        doc.lines.map((l) => ({
          invoice_id: invoiceId,
          variant_id: bySku.get(l.sku)!.id,
          sku: l.sku,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price_cents,
          total: l.total_cents,
          net_total_cents: l.total_cents,
        }))
      );
      invoiceByQbTxn.set(doc.qb_txn_id, { invoiceId, orderId, number: invoiceNumber });
      audit({ step: "invoice_created", qb_txn_id: doc.qb_txn_id, invoice_id: invoiceId, invoice_number: invoiceNumber });

      // ── 3. Pipeline sembrado en `confirmed` con el TxnID REAL ────────────
      await pg.raw(
        `INSERT INTO qb_order_pipeline
           (order_id, reference_id, reference_type, step, status,
            qb_txn_id, qb_ref_number, payload, confirmed_at, submitted_at)
         VALUES (?, ?, 'invoice', 'invoice', 'confirmed', ?, ?, ?::jsonb, NOW(), NOW())`,
        [orderId, invoiceId, doc.qb_txn_id, doc.qb_ref_number,
         JSON.stringify({ backfilled: true, source: `QB ${doc.doc_type} ${doc.qb_ref_number}` })]
      );
      audit({ step: "pipeline_seeded", qb_txn_id: doc.qb_txn_id, order_id: orderId });

      // ── 4. El pago, si QB dice que lo hubo ───────────────────────────────
      const pay = doc.linked.find((l) => l.type === "ReceivePayment");
      if (pay) {
        const paySeq = await pg.raw(`SELECT nextval('custom_payment_seq') AS seq`);
        const payNum = Number(paySeq.rows[0].seq ?? paySeq.rows[0].SEQ);
        const amount = Math.abs(pay.amount_cents);
        const receivedAt = businessInstant(pay.date);
        const payment = await financeService.createCustomerPayments({
          customer_id: customerId,
          display_id: payNum,
          amount,
          method: "other",
          reference: `QB ${pay.txn_id}`,
          notes: `Recreado: el pago ya existe en QuickBooks (ReceivePayment ${pay.txn_id}). NO se re-sincroniza.`,
          received_at: receivedAt,
          created_by: "QB Backfill 2026-09",
          source: "pos",
          type: "payment",
          status: "applied",
          medusa_payment_synced: false,
          metadata: {
            invoices_affected: [invoiceId],
            qb_sync_status: "synced",
            qb_txn_id: pay.txn_id,
            qb_parent_txn_id: doc.qb_txn_id,
            qb_parent_ref_number: doc.qb_ref_number,
            manually_imported: true,
          },
        });
        const paymentId = Array.isArray(payment) ? payment[0].id : (payment as any).id;
        await financeService.createPaymentApplications({
          payment_id: paymentId,
          invoice_id: invoiceId,
          invoice_number: invoiceNumber,
          order_id: orderId,
          amount_applied: amount,
          applied_at: receivedAt,
          applied_by: "QB Backfill 2026-09",
        });
        audit({ step: "payment_created", qb_txn_id: doc.qb_txn_id, payment_id: paymentId, amount_cents: amount });
        logger.info(`${tag} ✅ pago ${money(amount)} (PAY-${payNum})`);
      }

      logger.info(`${tag} ✅ orden ${documentNumber} · factura ${invoiceNumber}`);
      creados++;
    } else {
      // ── CREDIT MEMO ───────────────────────────────────────────────────────
      // Se liga a la factura que este mismo script acaba de recrear, cuando QB
      // dice que se aplicó contra ella. `order_id` va sólo si esa factura tiene
      // orden; un credit memo suelto se queda sin ninguna, que es legal.
      const appliedTo = doc.linked.find((l) => l.type === "Invoice");
      const target = appliedTo ? invoiceByQbTxn.get(appliedTo.txn_id) : undefined;
      if (appliedTo && !target) {
        // QB dice que este credit memo se aplicó a una factura que este script
        // NO recreó. Linkearlo a `null` lo dejaría suelto y sumando crédito que
        // en QB ya está consumido — se aborta en vez de adivinar.
        throw new Error(
          `${tag} QB lo aplica a la factura ${appliedTo.ref} (TxnID ${appliedTo.txn_id}) que no está en este backfill`
        );
      }

      const cmSeq = await pg.raw(`SELECT nextval('custom_credit_memo_seq') AS seq`);
      const cmNumber = `CM-${cmSeq.rows[0].seq ?? cmSeq.rows[0].SEQ}`;

      const cm = await cmService.createPosCreditMemos({
        credit_memo_number: cmNumber,
        order_id: target?.orderId ?? null,
        invoice_id: target?.invoiceId ?? null,
        customer_id: customerId,
        status: "completed",
        subtotal: doc.subtotal_cents,
        discount: 0,
        shipping: 0,
        tax: doc.tax_cents,
        total: totalCents,
        completed_at: issuedAt,
        notes: `Recreado desde QuickBooks CreditMemo ${doc.qb_ref_number} (TxnID ${doc.qb_txn_id}).`,
        created_by: "QB Backfill 2026-09",
        qb_txn_id: doc.qb_txn_id,
        qb_edit_sequence: doc.qb_edit_sequence,
        refund_method: target ? "store_credit" : null,
        metadata: { qb_ref_number: doc.qb_ref_number, manually_imported: true },
      });
      const cmId = Array.isArray(cm) ? cm[0].id : (cm as any).id;
      await cmService.createPosCreditMemoItems(
        doc.lines.map((l) => ({
          credit_memo_id: cmId,
          variant_id: bySku.get(l.sku)!.id,
          sku: l.sku,
          title: bySku.get(l.sku)!.title || l.sku,
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price_cents,
          line_total: l.total_cents,
          damaged_qty: 0,
        }))
      );
      audit({ step: "credit_memo_created", qb_txn_id: doc.qb_txn_id, credit_memo_id: cmId, number: cmNumber });

      await pg.raw(
        `INSERT INTO qb_order_pipeline
           (order_id, reference_id, reference_type, step, status,
            qb_txn_id, qb_ref_number, payload, confirmed_at, submitted_at)
         VALUES (?, ?, 'credit_memo', 'credit_memo', 'confirmed', ?, ?, ?::jsonb, NOW(), NOW())`,
        [target?.orderId ?? null, cmId, doc.qb_txn_id, doc.qb_ref_number,
         JSON.stringify({ backfilled: true, source: `QB CreditMemo ${doc.qb_ref_number}` })]
      );
      audit({ step: "pipeline_seeded", qb_txn_id: doc.qb_txn_id, credit_memo_id: cmId });

      logger.info(`${tag} ✅ ${cmNumber}${target ? ` aplicado a la factura ${target.number}` : " (suelto, sin factura)"}`);
      creados++;
    }
  }

  logger.info(
    `\n${"─".repeat(72)}\n${APPLY ? "APLICADO" : "DRY-RUN"} · ${creados} documento(s) ${APPLY ? "creados" : "a crear"} · ${salteados} ya existían\n` +
      (APPLY ? `audit: ${AUDIT_FILE}\n` : "Para aplicar: APPLY=true\n") +
      `${"─".repeat(72)}`
  );
}
