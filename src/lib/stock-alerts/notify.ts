import type { RemoteQueryFunction } from "@medusajs/framework/types";
import { getVariantAvailability } from "@medusajs/framework/utils";

import { buildBackInStockEmail, selectAlertsToNotify } from "./select";
import { StockAlertService, type StockAlertDb } from "./service";

export interface NotifyDeps {
  db: StockAlertDb;
  query: Omit<RemoteQueryFunction, symbol>;
  /** Envía UN email; true = enviado. Inyectable: el sandbox/E2E no manda nada. */
  send: (mail: {
    to: string;
    subject: string;
    html: string;
  }) => Promise<boolean>;
  storeUrl: string;
  storeName: string;
  limit?: number;
}

export interface NotifySummary {
  candidates: number;
  salesChannelId: string | null;
  toNotify: Array<{ id: string; email: string; sku: string }>;
  notified: string[];
  failed: string[];
}

/**
 * Un pase del notificador: lee las alertas pendientes, mira la disponibilidad
 * de sus variantes en el canal de la web, avisa a las que ya tienen stock y
 * las marca. Sin canal resuelto no avisa a nadie (nunca por un dato ausente).
 * Marca sólo lo que el sender confirmó como enviado: un email que falló
 * vuelve a intentarse en el pase siguiente.
 */
export async function notifyBackInStock(
  deps: NotifyDeps
): Promise<NotifySummary> {
  const alerts = await StockAlertService.listPending(
    deps.db,
    deps.limit ?? 500
  );
  const summary: NotifySummary = {
    candidates: alerts.length,
    salesChannelId: null,
    toNotify: [],
    notified: [],
    failed: [],
  };
  if (alerts.length === 0) return summary;

  const salesChannelId = await StockAlertService.resolveWebSalesChannelId(
    deps.db
  );
  summary.salesChannelId = salesChannelId;
  if (!salesChannelId) return summary;

  const variantIds = [...new Set(alerts.map((a) => a.variant_id))];
  const availability = (await getVariantAvailability(deps.query, {
    variant_ids: variantIds,
    sales_channel_id: salesChannelId,
  })) as Record<string, { availability: number | null }>;
  const byVariant: Record<string, number | null> = {};
  for (const id of variantIds)
    byVariant[id] = availability[id]?.availability ?? null;

  const selected = selectAlertsToNotify(alerts, byVariant);
  summary.toNotify = selected.map((a) => ({
    id: a.id,
    email: a.email,
    sku: a.sku,
  }));
  if (selected.length === 0) return summary;

  const info = await StockAlertService.productInfoByVariant(deps.db, [
    ...new Set(selected.map((a) => a.variant_id)),
  ]);
  for (const a of selected) {
    const p = info.get(a.variant_id);
    const mail = buildBackInStockEmail({
      productTitle: p?.title ?? "",
      sku: a.sku,
      productUrl: p?.handle
        ? `${deps.storeUrl.replace(/\/$/, "")}/product/${p.handle}`
        : null,
      storeName: deps.storeName,
    });
    let ok = false;
    try {
      ok = await deps.send({ to: a.email, ...mail });
    } catch {
      ok = false;
    }
    if (ok) summary.notified.push(a.id);
    else summary.failed.push(a.id);
  }
  await StockAlertService.markNotified(deps.db, summary.notified);
  return summary;
}
