export { buildBackInStockEmail, selectAlertsToNotify } from "./select";
export type { PendingStockAlert } from "./select";
export { StockAlertService } from "./service";
export type { StockAlertDb } from "./service";
export { notifyBackInStock } from "./notify";
export type { NotifyDeps, NotifySummary } from "./notify";

/** Kill switch sin deploy: `STOCK_ALERTS_DISABLED=true` apaga el notificador. */
export const isStockAlertsDisabled = (): boolean =>
  process.env.STOCK_ALERTS_DISABLED === "true";
