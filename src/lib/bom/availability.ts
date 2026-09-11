/**
 * Clasificación de disponibilidad de UN SKU para el carrito de la web —
 * lo que cada línea del BOM de las apps dice de antemano (user-stated
 * 2026-09-11: "necesitamos colocar los mensajes de out of stock en el BOM").
 *
 * Es la MISMA regla que aplica `addToCartWorkflow` cuando la línea entra al
 * carrito, dicha antes de apretar: una variante que no gestiona inventario o
 * admite backorder siempre entra; una que sí gestiona entra sólo con
 * disponibilidad > 0 en las ubicaciones del sales channel (hoy: Miami para el
 * canal Web). `not_sold` = el SKU no resuelve a una variante PUBLICADA del
 * canal (misma resolución que `sync-bom`).
 */
export type BomAvailabilityStatus = "ok" | "out_of_stock" | "not_sold";

export interface BomAvailabilityItem {
  sku: string;
  status: BomAvailabilityStatus;
  /** Unidades disponibles cuando se gestiona inventario; null si no aplica. */
  available: number | null;
}

export function classifyAvailability(input: {
  manageInventory: boolean;
  allowBackorder: boolean;
  /** null = el módulo de inventario no contestó / no gestiona. */
  available: number | null;
}): { status: "ok" | "out_of_stock"; available: number | null } {
  if (!input.manageInventory || input.allowBackorder) {
    return { status: "ok", available: null };
  }
  const available =
    typeof input.available === "number" && Number.isFinite(input.available)
      ? Math.max(0, Math.floor(input.available))
      : 0;
  return { status: available > 0 ? "ok" : "out_of_stock", available };
}
