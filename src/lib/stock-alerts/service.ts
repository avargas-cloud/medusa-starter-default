import type { Pool, PoolClient } from "pg";

import type { PendingStockAlert } from "./select";

export type StockAlertDb = Pick<Pool | PoolClient, "query">;

/**
 * Acceso a `stock_alert` con el pg pool (`$n`). Una alerta PENDIENTE por
 * (cliente, variante): el índice único parcial lo garantiza y `createAlert`
 * lo lee como "already" en vez de fallar.
 */
export const StockAlertService = {
  async createAlert(
    db: StockAlertDb,
    input: {
      customerId: string;
      email: string;
      variantId: string;
      sku: string;
      sourceApp: string | null;
    }
  ): Promise<{ status: "pending" | "already"; id: string | null }> {
    const res = await db.query<{ id: string }>(
      `INSERT INTO stock_alert (id, customer_id, email, variant_id, sku, source_app)
       VALUES ('sa_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, variant_id) WHERE notified_at IS NULL AND canceled_at IS NULL
       DO NOTHING
       RETURNING id`,
      [
        input.customerId,
        input.email,
        input.variantId,
        input.sku,
        input.sourceApp,
      ]
    );
    const row = res.rows[0];
    return row
      ? { status: "pending", id: row.id }
      : { status: "already", id: null };
  },

  /** Variantes con alerta pendiente de ESTE cliente, de entre las pedidas. */
  async pendingVariantIdsForCustomer(
    db: StockAlertDb,
    customerId: string,
    variantIds: string[]
  ): Promise<Set<string>> {
    const out = new Set<string>();
    if (variantIds.length === 0) return out;
    const res = await db.query<{ variant_id: string }>(
      `SELECT variant_id FROM stock_alert
        WHERE customer_id = $1 AND variant_id = ANY($2::text[])
          AND notified_at IS NULL AND canceled_at IS NULL`,
      [customerId, variantIds]
    );
    for (const r of res.rows) out.add(r.variant_id);
    return out;
  },

  async listPending(
    db: StockAlertDb,
    limit = 500
  ): Promise<PendingStockAlert[]> {
    const res = await db.query<PendingStockAlert>(
      `SELECT id, customer_id, email, variant_id, sku, notified_at, canceled_at
         FROM stock_alert
        WHERE notified_at IS NULL AND canceled_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit]
    );
    return res.rows;
  },

  async markNotified(db: StockAlertDb, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await db.query(
      `UPDATE stock_alert SET notified_at = NOW() WHERE id = ANY($1::text[]) AND notified_at IS NULL`,
      [ids]
    );
    return res.rowCount ?? 0;
  },

  /** Título y handle del producto de cada variante (para el email). */
  async productInfoByVariant(
    db: StockAlertDb,
    variantIds: string[]
  ): Promise<Map<string, { title: string; handle: string | null }>> {
    const out = new Map<string, { title: string; handle: string | null }>();
    if (variantIds.length === 0) return out;
    const res = await db.query<{
      id: string;
      title: string | null;
      handle: string | null;
    }>(
      `SELECT pv.id, p.title, p.handle
         FROM product_variant pv JOIN product p ON p.id = pv.product_id
        WHERE pv.id = ANY($1::text[])`,
      [variantIds]
    );
    for (const r of res.rows)
      out.set(r.id, { title: r.title ?? "", handle: r.handle });
    return out;
  },

  /**
   * El sales channel de la web: el ÚNICO vinculado a una publishable key viva
   * (misma regla que publish-app-catalog-products). Dos o ninguno = null, y el
   * caller no inventa stock.
   */
  async resolveWebSalesChannelId(db: StockAlertDb): Promise<string | null> {
    const forced = process.env.STOCK_ALERTS_SALES_CHANNEL_ID?.trim();
    if (forced) return forced;
    const res = await db.query<{ id: string }>(
      `SELECT DISTINCT sc.id
         FROM publishable_api_key_sales_channel l
         JOIN api_key k ON k.id = l.publishable_key_id
         JOIN sales_channel sc ON sc.id = l.sales_channel_id
        WHERE l.deleted_at IS NULL AND k.type = 'publishable' AND k.revoked_at IS NULL
          AND k.deleted_at IS NULL AND sc.deleted_at IS NULL`
    );
    const only = res.rows.length === 1 ? res.rows[0] : undefined;
    return only ? only.id : null;
  },
};
