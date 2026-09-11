/**
 * verify-stock-alerts.ts — el notificador de "avisame cuando vuelva el stock"
 * de punta a punta contra la base REAL del sandbox, sin mandar ningún email.
 *
 *   env DATABASE_URL=<sandbox> DISABLE_SCHEDULED_JOBS=true QB_BRIDGE_DISABLED=true \
 *     SMTP_DISABLED=true BAMS_WEBHOOK_DISABLED=true \
 *     ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-stock-alerts.ts
 *
 * Planta alertas de un cliente SINTÉTICO (`cus_verify_stock_alerts`) sobre una
 * variante CON stock en el canal web y otra SIN stock, corre `notifyBackInStock`
 * con un `send` capturado y afirma: se notifica sólo la que volvió, el email
 * lleva título y link del producto, la segunda pasada no repite, y un envío
 * fallido deja la alerta pendiente. Limpia sus filas al final (y al inicio).
 * Sólo escribe en `stock_alert`, y sólo filas del cliente sintético.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

import { getDbPool } from "../../api/utils/db-pool";
import { notifyBackInStock, StockAlertService } from "../../lib/stock-alerts";
import type { MailOptions } from "../../utils/mailer";

const CUSTOMER = "cus_verify_stock_alerts";
const EMAIL = "verify-stock-alerts@example.invalid";

let failures = 0;
const check = (ok: boolean, label: string, detail?: unknown): void => {
  console.log(
    `${ok ? "✅" : "❌"} ${label}${detail !== undefined && !ok ? ` — ${JSON.stringify(detail)}` : ""}`
  );
  if (!ok) failures += 1;
};

export default async function verifyStockAlerts({
  container,
}: ExecArgs): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(url)) {
    throw new Error(
      "Este verificador corre SÓLO contra el sandbox (DATABASE_URL en :5499)."
    );
  }
  const db = getDbPool();
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const cleanup = async (): Promise<void> => {
    await db.query(`DELETE FROM stock_alert WHERE customer_id = $1`, [
      CUSTOMER,
    ]);
  };
  await cleanup();

  try {
    const channelId = await StockAlertService.resolveWebSalesChannelId(db);
    check(
      typeof channelId === "string" && channelId.startsWith("sc_"),
      `canal web resuelto: ${channelId}`
    );
    if (!channelId) return;

    const pick = async (
      withStock: boolean
    ): Promise<{
      variantId: string;
      sku: string;
      title: string;
      handle: string;
    } | null> => {
      const r = await db.query<{
        variant_id: string;
        sku: string;
        title: string;
        handle: string;
      }>(
        `SELECT pv.id AS variant_id, pv.sku, p.title, p.handle
           FROM product_variant pv
           JOIN product p ON p.id = pv.product_id AND p.status = 'published' AND p.deleted_at IS NULL
           JOIN product_sales_channel psc ON psc.product_id = p.id AND psc.sales_channel_id = $1 AND psc.deleted_at IS NULL
          WHERE pv.deleted_at IS NULL AND pv.sku IS NOT NULL AND pv.manage_inventory = true AND pv.allow_backorder = false
            AND ${withStock ? "" : "NOT"} EXISTS (
              SELECT 1 FROM product_variant_inventory_item pvii
                JOIN inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.deleted_at IS NULL
                JOIN sales_channel_stock_location ssl ON ssl.stock_location_id = il.location_id AND ssl.deleted_at IS NULL AND ssl.sales_channel_id = $1
               WHERE pvii.variant_id = pv.id AND pvii.deleted_at IS NULL AND il.stocked_quantity - il.reserved_quantity > 0)
          ORDER BY pv.sku LIMIT 1`,
        [channelId]
      );
      const row = r.rows[0];
      return row
        ? {
            variantId: row.variant_id,
            sku: row.sku,
            title: row.title,
            handle: row.handle,
          }
        : null;
    };
    const inStock = await pick(true);
    const noStock = await pick(false);
    check(!!inStock, `variante CON stock en el canal: ${inStock?.sku}`);
    check(!!noStock, `variante SIN stock en el canal: ${noStock?.sku}`);
    if (!inStock || !noStock) return;

    // Plantar: una alerta por variante; la segunda inserción es idempotente.
    const a1 = await StockAlertService.createAlert(db, {
      customerId: CUSTOMER,
      email: EMAIL,
      variantId: inStock.variantId,
      sku: inStock.sku,
      sourceApp: "backlighting",
    });
    const a1b = await StockAlertService.createAlert(db, {
      customerId: CUSTOMER,
      email: EMAIL,
      variantId: inStock.variantId,
      sku: inStock.sku,
      sourceApp: "backlighting",
    });
    const a2 = await StockAlertService.createAlert(db, {
      customerId: CUSTOMER,
      email: EMAIL,
      variantId: noStock.variantId,
      sku: noStock.sku,
      sourceApp: null,
    });
    check(
      a1.status === "pending" &&
        a1b.status === "already" &&
        a2.status === "pending",
      "createAlert: pending / already / pending",
      { a1, a1b, a2 }
    );
    const pendingIds = await StockAlertService.pendingVariantIdsForCustomer(
      db,
      CUSTOMER,
      [inStock.variantId, noStock.variantId, "var_nope"]
    );
    check(
      pendingIds.size === 2 &&
        pendingIds.has(inStock.variantId) &&
        pendingIds.has(noStock.variantId),
      "pendingVariantIdsForCustomer ve las dos"
    );

    // 1ª pasada: se notifica sólo la que tiene stock.
    const sent: MailOptions[] = [];
    const s1 = await notifyBackInStock({
      db,
      query,
      send: async (m) => {
        sent.push(m);
        return true;
      },
      storeUrl: "https://example.test",
      storeName: "EPT Verify",
    });
    check(s1.salesChannelId === channelId, "notify usa el canal web", s1);
    check(
      s1.toNotify.some((a) => a.sku === inStock.sku && a.email === EMAIL) &&
        !s1.toNotify.some((a) => a.sku === noStock.sku),
      "toNotify: sólo la variante con stock",
      s1.toNotify.map((a) => a.sku)
    );
    check(
      sent.length >= 1 && s1.failed.length === 0,
      `se mandó ${sent.length} email, 0 fallidos`,
      { failed: s1.failed }
    );
    const mine = sent.find((m) => m.to === EMAIL);
    check(!!mine, "el email va al email del cliente (de su registro)");
    check(
      !!mine && mine.subject.includes(inStock.title),
      "asunto con el título del producto",
      mine?.subject
    );
    check(
      !!mine &&
        mine.html.includes(`https://example.test/product/${inStock.handle}`),
      "html con el link a la ficha",
      mine?.html.slice(0, 200)
    );
    // El SKU va escapado en el HTML (un `&` en el SKU sale como `&amp;`).
    const skuHtml = inStock.sku
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    check(!!mine && mine.html.includes(skuHtml), "html con el SKU (escapado)", {
      sku: inStock.sku,
    });
    const after1 = await db.query<{ sku: string; notified: boolean }>(
      `SELECT sku, notified_at IS NOT NULL AS notified FROM stock_alert WHERE customer_id = $1 ORDER BY sku`,
      [CUSTOMER]
    );
    const byS = new Map(after1.rows.map((r) => [r.sku, r.notified]));
    check(
      byS.get(inStock.sku) === true && byS.get(noStock.sku) === false,
      "notified_at: estampada la enviada, NULL la sin stock",
      after1.rows
    );

    // 2ª pasada: no repite (la notificada ya no es candidata; la sin stock sigue esperando).
    const sent2: MailOptions[] = [];
    const s2 = await notifyBackInStock({
      db,
      query,
      send: async (m) => {
        sent2.push(m);
        return true;
      },
      storeUrl: "https://example.test",
      storeName: "EPT Verify",
    });
    check(
      sent2.filter((m) => m.to === EMAIL).length === 0 &&
        !s2.toNotify.some((a) => a.email === EMAIL),
      "2ª pasada: nada repetido para el cliente sintético",
      s2
    );

    // Envío fallido: la alerta queda pendiente para el próximo tick.
    const a3 = await StockAlertService.createAlert(db, {
      customerId: CUSTOMER,
      email: EMAIL,
      variantId: inStock.variantId,
      sku: inStock.sku,
      sourceApp: "linear-lighting",
    });
    check(
      a3.status === "pending",
      "tras notificar, se puede volver a pedir aviso (nueva fila pendiente)",
      a3
    );
    const s3 = await notifyBackInStock({
      db,
      query,
      send: async () => false,
      storeUrl: "https://example.test",
      storeName: "EPT Verify",
    });
    check(
      s3.failed.length > 0 && s3.notified.length === 0,
      "send=false cuenta como fallido y no estampa",
      s3
    );
    const stillPending = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_alert WHERE customer_id = $1 AND variant_id = $2 AND notified_at IS NULL`,
      [CUSTOMER, inStock.variantId]
    );
    check(
      stillPending.rows[0]?.n === "1",
      "la fila del envío fallido sigue pendiente (no se estampó)",
      stillPending.rows
    );
  } finally {
    await cleanup();
    const left = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_alert WHERE customer_id = $1`,
      [CUSTOMER]
    );
    check(left.rows[0]?.n === "0", "limpieza: 0 filas del cliente sintético");
  }

  console.log(
    failures === 0
      ? "\nVERIFY OK — stock alerts"
      : `\nVERIFY FAILED — ${failures} check(s)`
  );
  if (failures > 0) process.exitCode = 1;
}
