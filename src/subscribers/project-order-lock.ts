import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";

import { evaluateProjectLocksForOrder, isProjectLockDisabled } from "../lib/project-lock";

/**
 * Candado proyecto ↔ orden (Backlighting / Linear Lighting), disparado por los
 * MISMOS bordes que el auto-cierre de órdenes (`auto-complete-order.ts`): son
 * los eventos en los que cambia "cobró" o "entregó". No es la garantía de
 * inmutabilidad — esa es la tabla + el 409 en las apps — y no es la única
 * escritura: el reconciler `project-order-lock-reconciler` repasa cada 5 min
 * lo que un evento no cubrió (capturas nativas, metadata escrita por SQL,
 * vínculos sólo del lado del proyecto).
 *
 * Nunca lanza: un candado que no se escribió ahora se escribe en la próxima
 * pasada; un evento bloqueado por esto sería peor.
 */
type AnyOrderEvent = { id?: string; order_id?: string };

export default async function projectOrderLockSubscriber({
  event: { name, data },
}: SubscriberArgs<AnyOrderEvent>) {
  if (isProjectLockDisabled()) return;
  const orderId = data?.order_id ?? data?.id;
  if (!orderId?.startsWith("order_")) return;

  try {
    const result = await evaluateProjectLocksForOrder(orderId, `subscriber:${name}`);
    if (result.inserted.length > 0) {
      console.log(
        `[project-lock] ${orderId} via ${name}: ${result.reason} → locked ${result.inserted
          .map((l) => `${l.app}:${l.projectId}`)
          .join(", ")}`
      );
    }
  } catch (err: any) {
    console.warn(
      `[project-lock] soft-fail on ${name} for ${orderId}: ${err?.message?.slice(0, 120)}`
    );
  }
}

export const config: SubscriberConfig = {
  event: [
    "pos.invoice.created",
    "order-edit.confirmed",
    "order.fulfillment_created",
    "order.placed",
    "order.updated",
    "pos.order.completion_requested",
  ],
};
